/**
 * LogPayloadService：Agent 日志大文本冷热分离（PRD §4.2 P1-2）。
 *
 * 把 novel_agent_logs 的大文本字段 gzip 压缩后外置到 novel_agent_log_payloads：
 * - gzip（node:zlib 内置，无第三方依赖）
 * - content_hash：非空字段 JSON 规范化后 sha256，可去重 / 校验解压完整性
 * - expires_at：保留策略到期时间戳（成功 30d / 失败 90d / 审计锁定 365d，NULL=长期）
 *
 * 保留策略（统一方案 §4.5）：普通成功 payload 30 天 / 失败 90 天 /
 * 收藏或审计锁定 365 天 / 日志元数据长期。
 */
import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'

export interface PayloadFields {
  systemPrompt?: string
  chapterContext?: string
  userMessage?: string
  taskInput?: string
  userInstructions?: unknown
  tools?: unknown
  result?: string
  error?: string
}

/** 保留策略（天）；null = 长期 */
export const PAYLOAD_RETENTION_DAYS = {
  success: 30,
  error: 90,
  auditLocked: 365,
} as const

/** 一天对应的秒数 */
export const SECONDS_PER_DAY = 24 * 60 * 60

/**
 * gzip 压缩文本为 BLOB。
 */
export function gzipText(text: string): Buffer {
  return gzipSync(Buffer.from(text, 'utf8'))
}

/**
 * 解压 BLOB 为文本。
 */
export function gunzipBlob(blob: Buffer): string {
  return gunzipSync(blob).toString('utf8')
}

/**
 * 对非空字段做 JSON 规范化（key 排序、去 undefined），返回稳定字符串。
 */
export function normalizePayloadJson(fields: PayloadFields): string {
  const cleaned: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value == null) continue
    if (typeof value === 'string' && value.length === 0) continue
    if (Array.isArray(value) && value.length === 0) continue
    cleaned[key] = value
  }
  return JSON.stringify(cleaned, Object.keys(cleaned).sort())
}

/**
 * 计算 payload 的 content_hash（非空字段 JSON 规范化后 sha256）。
 */
export function hashPayloadFields(fields: PayloadFields): string {
  return createHash('sha256').update(normalizePayloadJson(fields)).digest('hex')
}

/**
 * 按状态计算保留到期时间戳（Unix 秒）。
 * @param createdAt 创建时间戳（秒）
 * @param status 日志状态
 * @param auditLocked 是否收藏/审计锁定（长期 365d）
 */
export function computeExpiresAt(
  createdAt: number,
  status: 'success' | 'error' | 'cancelled',
  auditLocked = false,
): number | null {
  if (auditLocked) return createdAt + PAYLOAD_RETENTION_DAYS.auditLocked * SECONDS_PER_DAY
  const days = status === 'error' ? PAYLOAD_RETENTION_DAYS.error : PAYLOAD_RETENTION_DAYS.success
  return createdAt + days * SECONDS_PER_DAY
}

/** payload 表 blob 列 → 内存字段映射（blob 列名去掉 _blob 后缀） */
export const PAYLOAD_BLOB_COLUMNS: Array<{ column: string; field: keyof PayloadFields }> = [
  { column: 'system_prompt_blob', field: 'systemPrompt' },
  { column: 'chapter_context_blob', field: 'chapterContext' },
  { column: 'user_message_blob', field: 'userMessage' },
  { column: 'task_input_blob', field: 'taskInput' },
  { column: 'user_instructions_blob', field: 'userInstructions' },
  { column: 'tools_blob', field: 'tools' },
  { column: 'result_blob', field: 'result' },
  { column: 'error_blob', field: 'error' },
]
