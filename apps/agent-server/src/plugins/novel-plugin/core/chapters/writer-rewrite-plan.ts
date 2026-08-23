/**
 * Writer 重写策略：全量重写 vs 定向修改。
 *
 * ## 问题
 *
 * PostWriteGuard 命中后，此前一律让 Writer **从零重写整章**，只传一个
 * `writerGuardRewriteReason` 字符串。代价是每次重写都要重新吃掉 19k input，
 * 而实测 ch9 重写 10 次、ch10 重写 13 次 —— 这是那两章烧掉 46 万 / 126 万
 * 输入 token 的主要来源之一。
 *
 * ## 关键判断：上一稿可不可用
 *
 * 「定向修改」的前提是上一稿本身是有效正文。按 Guard 的命中原因分两类：
 *
 * | Guard 原因 | 上一稿 | 策略 |
 * | --- | --- | --- |
 * | 模型未输出正文 | 只有计划/说明，不是正文 | **全量重写**（带上去只会污染） |
 * | 模型退化检测命中 | 复读/截断/拒答/工程词泄漏 | **全量重写**（同上） |
 * | 正文疑似截断 | 残稿，远低于截断兜底线 | **全量重写**（残稿会锚定输出长度） |
 * | 字数严重不足 | 有效正文，只是短 | 定向扩写（群聊路径仍在用） |
 * | 字数严重超标 | 有效正文，只是长 | 定向压缩（群聊路径仍在用） |
 * | 未完整执行矩阵编排 | 有效正文，缺角色参与 | 定向补入 |
 *
 * 这条区分是本模块存在的理由：把退化输出当"上一稿"喂回去，模型会顺着那段
 * 垃圾继续复读，比全量重写更糟。
 *
 * ## 为什么不直接让 Reviser 做
 *
 * Reviser 的输入是 Reviewer 的结构化审稿报告（语义问题），而 Guard 命中的是
 * **确定性问题**（字数、姓名缺失），此时 Reviewer 还没跑。让 Writer 自己做
 * 定向修改能省掉一次 Reviewer + 一次 Reviser 的往返。
 *
 * ## 边界
 *
 * 纯函数，只产出提示词文本。是否重写、重写几次仍由 orchestrator 决定。
 */

/** Guard 命中原因（与 runPostWriteGuard 的 reason 字面量一致） */
export type GuardReason =
  | '模型未输出正文'
  | '模型退化检测命中'
  | '正文疑似截断'
  | '字数严重不足'
  | '字数严重超标'
  | '未完整执行矩阵编排'
  /** P1-3 v1.1：碎段/短段/声音趋同等分布级问题——Reviser 补丁修不动，由 Writer 整体重构节奏 */
  | '正文形态未达标'
  | string

export type RewriteStrategy =
  /** 从零重写整章：上一稿不可用 */
  | 'full'
  /** 带上一稿做定向修改 */
  | 'targeted'

export interface WriterRewritePlan {
  strategy: RewriteStrategy
  /** 发给 Writer 的完整任务输入 */
  input: string
  /** 供日志与进度展示 */
  summary: string
}

export interface BuildRewritePlanParams {
  chapterNumber: number
  reason: GuardReason
  details?: string
  /** 上一稿正文；strategy=full 时不使用 */
  previousDraft: string
  /** 当前重写次数（1-based） */
  attempt: number
  maxAttempts: number
}

/**
 * 上一稿不可用的 Guard 原因。
 *
 * 判定放在这里而不是内联，是因为它决定了要不要把上一稿塞进 prompt ——
 * 判错的代价是模型顺着退化输出继续复读。
 */
const UNUSABLE_DRAFT_REASONS = new Set<string>([
  '模型未输出正文',
  '模型退化检测命中',
  // 残稿会锚定模型的输出长度——带上去重写大概率还是残稿
  '正文疑似截断',
])

export function isDraftUnusable(reason: GuardReason): boolean {
  return UNUSABLE_DRAFT_REASONS.has(reason)
}

/** 上一稿超长时的截断上限：留足上下文又不至于把 input 顶回原点 */
export const PREVIOUS_DRAFT_CHAR_LIMIT = 12_000

/**
 * 按 Guard 原因给出定向修改指令。
 *
 * 每条都要说清"改哪里、怎么改、不要动什么" —— 只说原因（旧行为）会让模型
 * 把整章重写一遍，定向修改就退化成了全量重写。
 */
function targetedInstruction(reason: GuardReason, details?: string): string {
  const detailSuffix = details ? `（${details}）` : ''
  switch (reason) {
    case '字数严重不足':
      return [
        `上一稿字数不足${detailSuffix}。`,
        '',
        '**只做扩写，不要重写已有内容**：',
        '- 保留上一稿的情节走向、人物动作顺序与所有已写出的对话',
        '- 在场景内部补足：动作的具体过程、环境的可感细节、人物的即时反应',
        '- 不要新增情节事件或新角色来凑字数；不要把已有段落改写成同义的更长表述',
      ].join('\n')

    case '字数严重超标':
      return [
        `上一稿字数超标${detailSuffix}。`,
        '',
        '**只做压缩，不要改变情节**：',
        '- 保留全部情节节点、人物动作与关键对话',
        '- 删减重复的心理描写、同义的环境铺陈、可由动作自然带出的解释性叙述',
        '- 不要删掉任何已经推进的冲突或已埋设的伏笔',
      ].join('\n')

    case '未完整执行矩阵编排':
      return [
        `上一稿未让本章编排的角色真正参与${detailSuffix}。`,
        '',
        '**在现有情节里补入这些角色的实际参与，不要重写整章**：',
        '- 找到情节上最自然的位置，让他们有具体动作或对话',
        '- 只是提到名字不算参与：要有可观察的行为并对局势产生影响',
        '- 保留其余段落原样',
      ].join('\n')

    case '正文形态未达标':
      return [
        `上一稿的段落节奏与对话形态未达标${detailSuffix}。`,
        '',
        '**保留全部情节、事实、伏笔与信息边界，只重构叙事节奏**：',
        '- 把连续的单句短段按动作单元合并成有呼吸的长段；只保留真正改变局势的动作或台词为独立短段',
        '- 让句长分布拉开：叙述用长短交替，不要通篇 5-15 字的句子',
        '- 对话必须打破"完整句收尾"：加入被打断的半句、答非所问、没说完就转向的话',
        '- 不要新增情节、解释或总结；不要把所有段修成同一种长度',
      ].join('\n')

    default:
      return [
        `上一稿未通过确定性检查：${reason}${detailSuffix}。`,
        '',
        '**在上一稿基础上定向修正，不要重写整章**：只改动与上述问题直接相关的段落，其余保留原样。',
      ].join('\n')
  }
}

/** 按上限截断上一稿；保留首尾，中间省略（首尾承接最关键） */
function clampDraft(draft: string): { text: string; truncated: boolean } {
  if (draft.length <= PREVIOUS_DRAFT_CHAR_LIMIT) {
    return { text: draft, truncated: false }
  }
  const head = Math.round(PREVIOUS_DRAFT_CHAR_LIMIT * 0.7)
  const tail = PREVIOUS_DRAFT_CHAR_LIMIT - head
  return {
    text: `${draft.slice(0, head)}\n\n[中间部分略，保持原样不要改动]\n\n${draft.slice(-tail)}`,
    truncated: true,
  }
}

/**
 * 构建 Writer 重写任务。
 *
 * 首次创作（无 Guard 命中）不走这里 —— 那条路径由 orchestrator 直接发
 * 「执行已批准的叙事任务」。
 */
export function buildWriterRewritePlan(params: BuildRewritePlanParams): WriterRewritePlan {
  const { chapterNumber, reason, details, previousDraft, attempt, maxAttempts } = params
  const progress = `（第 ${attempt}/${maxAttempts} 次重写）`

  // 上一稿不可用，或压根没有上一稿：只能全量重写
  if (isDraftUnusable(reason) || previousDraft.trim().length === 0) {
    return {
      strategy: 'full',
      summary: `全量重写${progress}：${reason}`,
      input: [
        `请沿用已批准的本章叙事任务，重新创作第 ${chapterNumber} 章正文，不要重新规划或推回 Director。`,
        '',
        `上一稿无效：${reason}${details ? `（${details}）` : ''}。`,
        '上一稿不作为参考，请从头写。',
        '',
        '立即输出完整章节正文，不要输出核对过程、计划或重写说明。',
      ].join('\n'),
    }
  }

  const { text, truncated } = clampDraft(previousDraft)
  return {
    strategy: 'targeted',
    summary: `定向修改${progress}：${reason}`,
    input: [
      `请在上一稿的基础上修改第 ${chapterNumber} 章正文。沿用已批准的叙事任务，不要重新规划或推回 Director。`,
      '',
      targetedInstruction(reason, details),
      '',
      truncated
        ? '## 上一稿正文（过长已截断，未展示部分保持原样）'
        : '## 上一稿正文',
      '',
      text,
      '',
      '## 输出要求',
      '',
      '输出修改后的**完整**章节正文（含未改动的段落），不要输出差异说明、修改清单或核对过程。',
    ].join('\n'),
  }
}
