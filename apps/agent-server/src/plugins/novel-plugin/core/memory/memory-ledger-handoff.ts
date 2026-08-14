/**
 * Memory Agent 的账本承接段。
 *
 * ## 实测问题与一处修正
 *
 * 方案文档写「memory 拿不到账本承接与本章编排实体」。核查后前半句成立、后半句不成立：
 * `getCurrentEntityState` 已经按 `arrangedEntities` 过滤，本章编排实体的
 * currentState / currentGoal / currentPressure 都注入了。
 *
 * 真正缺的是**账本**这一侧的两样东西：
 *
 * 1. **前几章的变化 delta**。Memory 只看到实体的「当前值」，看不到这个值是
 *    第几章、因为什么变成这样的。于是它每章都在从零重新判断「这个角色现在算什么状态」，
 *    而不是在已有轨迹上做差分 —— 这正是它 20.2k input 却只产出 1.8k output 的由来。
 * 2. **本章的计划变更**（`plannedChanges`）。编排阶段已经声明了本章打算推进哪些维度，
 *    Memory 却看不到，无法回答「计划的推进到底发生了没有」。
 *
 * 补上这两段之后，Memory 的任务从「读正文，判断现在是什么状态」变成
 * 「读正文，确认计划中的变化发生了没有、还多发生了什么」—— 后者的输出能直接
 * 对应账本的变化记录。
 *
 * ## 为什么不直接复用 prompt-builder 的 formatStoryLedgerContext
 *
 * 那个版本服务于 Writer：它要的是「写作时需要知道的故事现状」，包含未来承诺、
 * 活跃线程、批注、连续性告警等。Memory 只需要「上文到哪了 + 本章计划改什么」，
 * 其余段落对状态提取无用，注入进去只是把 20.2k input 推得更高。
 * 两者的取舍方向相反，共用一个 formatter 会让两边都被迫妥协。
 *
 * ## 边界
 *
 * 纯函数，输入是已取好的 ChapterStoryContext，不碰数据库。
 */

import type { ChapterStoryContext } from '../types.js'

/** 维度标识 → 中文标签。与 prompt-builder 的表保持一致，避免同一维度两种叫法。 */
const DIMENSION_LABELS: Record<string, string> = {
  'character.state': '状态',
  'character.goal': '目标',
  'character.pressure': '压力',
  'character.cognition': '认知',
  'character.arc_stage': '成长状态',
  'conflict.stage': '冲突进展',
  'conflict.intensity': '冲突强度',
  'foreshadow.beat': '伏笔动作',
  'foreshadow.payoff_chapter': '伏笔回收时点',
  'clue.progress': '线索进展',
  'faction.status': '势力状态',
  'faction.activity': '势力动态',
  'item.holder': '物品归属',
  'item.status': '物品状态',
  'relationship.stage': '关系进展',
  'relationship.alignment': '关系立场',
}

/**
 * 预算。比 Writer 的 LEDGER_BUDGET 更紧：Memory 的输入已有全篇正文（最大的一块），
 * 承接段只需要够它做差分，不需要还原完整故事。
 */
export const MEMORY_LEDGER_BUDGET = {
  /** 章前状态条数 */
  stateCount: 12,
  /** 本章计划变更条数 */
  plannedCount: 8,
  /** 单条值的字符上限 */
  valueChars: 80,
  /** 缘由字符上限 */
  reasonChars: 60,
} as const

/** 本章编排实体的 ID 集合；为空表示不过滤 */
export interface MemoryLedgerScope {
  entityIds: Set<string>
}

export interface MemoryLedgerOptions {
  scope?: MemoryLedgerScope
  /**
   * 实体 ID → 显示名。
   *
   * 必须由调用方提供：`StoryDimensionState` 有可选的 `subjectName`（需 prompt-builder
   * 预先注入），但 `plannedChanges` 是裸的 `NovelChangeRecord`，**没有** name 字段。
   * 缺名字时会退化成「（未命名实体）」，那样这段承接对 LLM 就没用了 ——
   * 它无法把状态对应到具体角色。
   */
  names?: Map<string, string>
}

function compact(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

/** 把账本里的任意值压成一行可读文本 */
function formatValue(value: unknown, max: number): string {
  if (value == null || value === '') return '（空）'
  if (typeof value === 'string') return compact(value, max)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value !== 'object') return String(value)

  // 对象值（如 character 的多字段快照）只取有内容的字段
  const record = value as Record<string, unknown>
  const fields: Array<[string, string]> = [
    ['currentState', '状态'],
    ['currentGoal', '目标'],
    ['currentPressure', '压力'],
    ['stage', '进展'],
    ['status', '状态'],
    ['progress', '进度'],
  ]
  const parts = fields.flatMap(([key, label]) => {
    const v = record[key]
    if (v == null || v === '') return []
    return [`${label}：${compact(String(v), 40)}`]
  })
  return parts.length > 0 ? parts.join('；') : '已有记录'
}

function labelFor(dimension: string): string {
  return DIMENSION_LABELS[dimension] ?? '状态'
}

/**
 * 构建 Memory 的账本承接段。
 *
 * @param context 章前账本切片（`memoryStore.getChapterStoryContext` 的产物）
 * @param options scope 限定本章编排实体范围；names 提供实体显示名
 * @returns 可直接拼入 user prompt 的段落；无可用内容时返回空串
 */
export function buildMemoryLedgerHandoff(
  context: ChapterStoryContext,
  options?: MemoryLedgerOptions,
): string {
  const scope = options?.scope
  const names = options?.names ?? new Map<string, string>()
  const nameOf = (id: string, supplied?: string): string =>
    supplied || names.get(id) || '（未命名实体）'

  const inScope = (subjectId: string): boolean => {
    if (!scope || scope.entityIds.size === 0) return true
    return scope.entityIds.has(subjectId)
  }

  const sections: string[] = []

  // ── 章前状态：上文推进到哪了 ──
  //
  // 只保留每个维度的最新值（getChapterStoryContext 已按维度归并），
  // 并按生效章倒序：越近的变化对判断本章差分越有用。
  const priorStates = context.stateBeforeChapter
    .filter((s) => inScope(s.subjectId))
    // 创建类维度不是状态推进，Memory 不需要
    .filter((s) => !s.dimension.endsWith('.created'))
    .slice()
    .sort((a, b) => b.effectiveChapter - a.effectiveChapter)
    .slice(0, MEMORY_LEDGER_BUDGET.stateCount)

  if (priorStates.length > 0) {
    const lines = priorStates.map((s) => {
      const subject = nameOf(s.subjectId, s.subjectName)
      const target = s.targetId ? `与${nameOf(s.targetId, s.targetName)}` : ''
      const value = formatValue(s.value, MEMORY_LEDGER_BUDGET.valueChars)
      return `- ${subject}${target}：${labelFor(s.dimension)}＝「${value}」（第 ${s.effectiveChapter} 章确立）`
    })
    sections.push(
      [
        '\n## 章前状态承接（上文已经推进到这里）\n',
        '以下是本章开始前账本记录的最新状态。**你的任务是找出本章正文让哪些条目发生了变化**，',
        '而不是重新判断每个实体现在算什么状态。与下方条目一致的内容不必再输出。',
        '',
        ...lines,
      ].join('\n'),
    )
  }

  // ── 本章计划变更：编排阶段声明要推进什么 ──
  const planned = context.plannedChanges
    .filter((c) => inScope(c.subjectId))
    .slice(0, MEMORY_LEDGER_BUDGET.plannedCount)

  if (planned.length > 0) {
    const lines = planned.map((c) => {
      const subject = nameOf(c.subjectId)
      const value = formatValue(c.afterValue, MEMORY_LEDGER_BUDGET.valueChars)
      const reason = c.reason ? `；缘由：${compact(c.reason, MEMORY_LEDGER_BUDGET.reasonChars)}` : ''
      return `- ${subject}：${labelFor(c.dimension)}应变为「${value}」${reason}`
    })
    sections.push(
      [
        '\n## 本章计划变更（编排阶段的声明）\n',
        '逐条核对：正文里真的发生了就输出对应的 update；没发生就不要凭计划补写。',
        '',
        ...lines,
      ].join('\n'),
    )
  }

  // ── 连续性告警：账本自身已发现的前后值不接续 ──
  //
  // 这类问题往往正是 Memory 上一次写错造成的，摆在它面前有机会顺手纠正。
  if (context.continuityWarnings.length > 0) {
    sections.push(
      [
        '\n## 账本连续性告警\n',
        '以下维度的前后值不接续，若本章正文能澄清，请在输出中给出正确的当前值。',
        '',
        ...context.continuityWarnings.slice(0, 4).map((w) => `- ${w}`),
      ].join('\n'),
    )
  }

  return sections.join('\n')
}
