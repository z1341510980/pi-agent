/**
 * entity-summary：实体详情降级能力（P3 T03-4）
 *
 * 方案 §5.4：实体档案自动 full/summary——
 * - chooseEntityChunkMode：按实体数 + token 预算选择完整/摘要注入；
 * - buildStoryStateSummary：确定性提取（非 LLM 调用，零成本）的故事状态摘要，
 *   供 story-state chunk 的 summary 模式输出。
 *
 * 生效路径：buildChapterContextChunks 的 story-state 分支在 options.mode === 'summary'
 * 时输出摘要（flag contextChunksEnabled + 调用方传参驱动）；默认 full 保持逐字节等价。
 */
import type { StoryState } from '@repo/shared/novel'

/** §5.4 模式选择：实体数 ≤ 8 且全量 token 未超剩余预算 35% → full，否则 summary */
export function chooseEntityChunkMode(input: {
  entityCount: number
  fullTokens: number
  remainingBudget: number
}): 'full' | 'summary' {
  if (
    input.entityCount <= 8 &&
    input.fullTokens <= input.remainingBudget * 0.35
  ) {
    return 'full'
  }
  return 'summary'
}

/**
 * §5.4 按需查询调用上限（每章每 Agent 的 novel_ask_story 次数），
 * 防止"摘要降级后用工具补齐"变成更多轮调用，反而增加总 token。
 * T03-5 由摘要提示约束 + T03-8 灰度看板统计实际超限。
 */
export const ON_DEMAND_LIMITS: Readonly<Record<string, number>> = {
  director: 4,
  writer: 6,
  reviewer: 4,
  reviser: 2,
  memory: 2,
}

/** 摘要末尾的按需查询提示（仅在有实体内容时附加，空摘要不加） */
const ON_DEMAND_HINT =
  '\n\n需要完整状态、历史推进或 stakes 细节时，调用 novel_ask_story 按需查询（每章查询次数有限）。'

/** 每类实体在摘要中的条数上限（摘要也要控制体积） */
const SUMMARY_LIMIT = 6

/** 占位实体过滤（与 formatStoryState 同一口径） */
function isPlaceholder(name: string): boolean {
  return /（待定）|待补充|待定$|^新的$|^测试角色/.test(name)
}

/** 截断描述：保留前 N 字，超长加省略号 */
function clip(text: string, max = 24): string {
  const t = (text ?? '').trim().replace(/\s+/g, ' ')
  if (t.length <= max) return t
  return `${t.slice(0, max)}…`
}

/**
 * 故事状态摘要（确定性提取，零 LLM 成本）。
 *
 * 与 formatStoryState 相比：每个实体一行、只留状态核心（角色状态/目标、
 * 冲突阶段/强度、伏笔线索进度），丢弃长描述与历史；每类上限 SUMMARY_LIMIT。
 */
export function buildStoryStateSummary(state: StoryState): string {
  const parts: string[] = ['## 当前故事状态（摘要）']

  const characters = state.characters.filter((c) => !isPlaceholder(c.name))
  if (characters.length > 0) {
    parts.push('\n### 角色')
    for (const c of characters.slice(0, SUMMARY_LIMIT)) {
      const status = c.currentState?.trim()
      const goal = c.currentGoal?.trim()
      parts.push(
        `- **${c.name}**${status ? `：${clip(status, 40)}` : ''}${goal ? `（目标：${clip(goal, 30)}）` : ''}`,
      )
    }
    if (characters.length > SUMMARY_LIMIT) {
      parts.push(`- 其余 ${characters.length - SUMMARY_LIMIT} 名角色仅列名`)
    }
  }

  if (state.relationships.length > 0) {
    parts.push('\n### 关系')
    for (const r of state.relationships.slice(0, SUMMARY_LIMIT)) {
      parts.push(`- ${r.characterA} ↔ ${r.characterB}（${r.currentStage ?? r.relationType ?? ''}）`)
    }
  }

  if (state.activeConflicts.length > 0) {
    parts.push('\n### 冲突')
    for (const c of state.activeConflicts.slice(0, SUMMARY_LIMIT)) {
      parts.push(`- ${clip(c.description)}（${c.stage ?? ''}${c.intensity ? `/${c.intensity}` : ''}）`)
    }
  }

  if (state.pendingForeshadowing.length > 0) {
    parts.push('\n### 伏笔')
    for (const f of state.pendingForeshadowing.slice(0, SUMMARY_LIMIT)) {
      parts.push(`- ${clip(f.description ?? '')}`)
    }
  }

  if (state.activeClues.length > 0) {
    parts.push('\n### 线索')
    for (const c of state.activeClues.slice(0, SUMMARY_LIMIT)) {
      parts.push(`- ${clip(c.description ?? '')}`)
    }
  }

  const misc: string[] = []
  for (const f of state.activeFactions.slice(0, SUMMARY_LIMIT)) misc.push(f.name)
  for (const l of state.activeLocations.slice(0, SUMMARY_LIMIT)) misc.push(l.name)
  for (const i of state.items.slice(0, SUMMARY_LIMIT)) misc.push(i.name)
  if (misc.length > 0) {
    parts.push('\n### 势力/地点/物品')
    parts.push(`- ${misc.join('、')}`)
  }

  if (parts.length === 1) return parts[0] // 空状态：只有标题，不加提示
  parts.push(ON_DEMAND_HINT)
  return parts.join('\n')
}
