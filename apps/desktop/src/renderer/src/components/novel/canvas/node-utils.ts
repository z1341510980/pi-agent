import type { NovelNodeType } from '@/stores/novel-ui-store'

// ── 节点 ID 前缀工具 ──

export function nodeId(type: NovelNodeType, id: string): string {
  return `${type}:${id}`
}

/**
 * 解析节点 ID：仅在第一个冒号处拆分。
 *
 * 必须使用 indexOf 而非 split(':')，否则当 id 本身含冒号时
 * （例如 "chapter:uuid:1" 这种复合 ID），split 会把 id 截断，
 * 导致后续按 entityId 发起的 DELETE / GET 请求拿到不完整的 id 而 404。
 */
export function parseNodeId(nodeId: string): [string, string] {
  const idx = nodeId.indexOf(':')
  return idx >= 0 ? [nodeId.slice(0, idx), nodeId.slice(idx + 1)] : [nodeId, '']
}

export function parseParticipants(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
