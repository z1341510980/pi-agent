/**
 * identity-contract：Agent 薄身份契约（P3 T03-6）
 *
 * 方案 §5.3：薄身份 = 「薄身份 + 职责 + 输出协议 + 工具权限」，故事事实来自共享 Chunk。
 * 模板（role-*.md / system-base.md）已按此结构落地；本模块把"契约"代码化：
 * - AGENT_IDENTITY_MARKERS：每 Agent 必须包含的关键协议标记（输出协议/工具权限锚点），
 *   防止后续模板改版丢失职责边界（如 Director 突然开始写正文）；
 * - 校验函数 validateAgentIdentity / 字符统计 countIdentityChars，供测试与灰度看板（T03-8）。
 */
import type { NovelAgentType } from './novel-agents.js'

/** 每 Agent 身份必须包含的协议标记（模板回归防漂移锚点） */
export const AGENT_IDENTITY_MARKERS: Readonly<Record<NovelAgentType, readonly string[]>> = {
  director: ['novel_submit_narrative_task', '绝不创作章节正文'],
  // 2026-10：Writer 的正文交付改走 novel_submit_prose 工具（tool_calls 通道，
  // 与 content 物理隔离）。锚点从"只输出完整章节正文"换成工具名 + 参数边界，
  // 防止模板改版时退回"直接在对话里输出正文"——那条路会被网关的 inline thinking 污染。
  writer: ['novel_submit_prose', 'content 参数只放完整章节正文'],
  reviewer: ['不创作正文', '检查'],
  reviser: ['局部修订'],
  memory: ['绝不创作正文', '状态'],
}

/** 身份字符数上界（含职责描述 + 铁律 + 文风，超出说明模板失控膨胀） */
export const IDENTITY_CHAR_LIMIT = 20000

export interface IdentityContractReport {
  agentType: string
  totalChars: number
  missingMarkers: string[]
  ok: boolean
}

/**
 * 校验某 Agent 的身份文本是否包含其职责协议标记。
 * 缺失标记返回详细报告（测试钉死，模板改版即红）。
 */
export function validateAgentIdentity(
  agentType: string,
  identityText: string,
): IdentityContractReport {
  const markers = AGENT_IDENTITY_MARKERS[agentType as NovelAgentType] ?? []
  const missing = markers.filter((m) => !identityText.includes(m))
  return {
    agentType,
    totalChars: identityText.length,
    missingMarkers: missing,
    ok: missing.length === 0 && identityText.length <= IDENTITY_CHAR_LIMIT,
  }
}

/** 身份字符统计（供 preview / T03-8 看板） */
export function countIdentityChars(identityText: string): number {
  return identityText.length
}
