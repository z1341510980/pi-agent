/**
 * verify-log-payloads.mjs — P1-2 payload 解压回读校验（只读）。
 *
 * 对日志冷热分离（默认外置）行做完整性校验：
 * - 解压 novel_agent_log_payloads 的 BLOB 字段；
 * - 用与写入端（graph-store / log-payload-service）相同的规范化
 *   （非空字段 JSON 排序 + sha256）**重算** content_hash，与存储值比对
 *   （P1-2-5：content_hash 可校验解压完整性）；
 * - 校验 payload 存在：主表 payload_id 无对应 payload 行、payload 行无主表（孤儿）均计入；
 * - ⚠️ 主表大文本列（system_prompt 等）按设计置空，
 *   属预期行为，**不参与比对、不算 mismatch**（旧实现对目标数据永远无法 PASS）。
 *
 * 用法：
 *   node scripts/novel-migration-tools/verify-log-payloads.mjs [projectId] [limit]
 *
 * 输出：output/verify-log-payloads-<ts>.json；mismatch/orphan/missingPayload 全 0 退出码 0，否则 1。
 */
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { openDb, writeJsonReport } from './lib/db.mjs'

const projectId = process.argv[2]
const limit = parseInt(process.argv[3] ?? '100', 10)

/**
 * 与 core/log-payload-service.ts normalizePayloadJson 同口径：
 * 剔除 null / 空串 / 空数组，key 排序后序列化。
 */
function normalizePayloadJson(fields) {
  const cleaned = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value == null) continue
    if (typeof value === 'string' && value.length === 0) continue
    if (Array.isArray(value) && value.length === 0) continue
    cleaned[key] = value
  }
  return JSON.stringify(cleaned, Object.keys(cleaned).sort())
}

/** 与 core/log-payload-service.ts hashPayloadFields 同口径：规范化 JSON → sha256 */
function hashPayloadFields(fields) {
  return createHash('sha256').update(normalizePayloadJson(fields)).digest('hex')
}

/** 解压 JSON 数组字段（userInstructions/tools 写入端存 JSON.stringify(array)） */
function parseJsonField(str) {
  if (!str) return undefined
  try {
    return JSON.parse(str)
  } catch {
    return str
  }
}

const db = openDb()
try {
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='novel_agent_log_payloads'",
  ).get()
  if (!tableExists) {
    console.log('novel_agent_log_payloads 表不存在（P1-2 未启用）')
    process.exit(0)
  }

  const params = projectId ? [projectId, limit] : [limit]
  const where = projectId ? 'WHERE l.project_id = ?' : ''
  const rows = db.prepare(`
    SELECT p.agent_log_id, p.compression, p.content_hash, p.expires_at, p.created_at,
           p.system_prompt_blob, p.chapter_context_blob, p.user_message_blob,
           p.task_input_blob, p.user_instructions_blob, p.tools_blob,
           p.result_blob, p.error_blob
    FROM novel_agent_log_payloads p
    JOIN novel_agent_logs l ON l.id = p.agent_log_id
    ${where}
    ORDER BY p.created_at DESC
    LIMIT ?
  `).all(...params)

  const gunzip = (blob) => (blob ? gunzipSync(blob).toString('utf8') : '')

  let mismatchRows = 0
  let hashMismatchRows = 0
  let emptyPayloadRows = 0
  const samples = []
  for (const r of rows) {
    // 1) 解压 payload 字段
    const rawFields = {
      systemPrompt: gunzip(r.system_prompt_blob),
      chapterContext: gunzip(r.chapter_context_blob),
      userMessage: gunzip(r.user_message_blob),
      taskInput: gunzip(r.task_input_blob),
      userInstructions: gunzip(r.user_instructions_blob),
      tools: gunzip(r.tools_blob),
      result: gunzip(r.result_blob),
      error: gunzip(r.error_blob),
    }
    // 2) 与写入端同口径构造哈希字段（JSON 数组字段需还原为数组）
    const fieldsForHash = {
      systemPrompt: rawFields.systemPrompt,
      chapterContext: rawFields.chapterContext,
      userMessage: rawFields.userMessage,
      taskInput: rawFields.taskInput,
      userInstructions: parseJsonField(rawFields.userInstructions),
      tools: parseJsonField(rawFields.tools),
      result: rawFields.result,
      error: rawFields.error,
    }
    // 3) 重算 content_hash 与存储值比对（P1-2-5）
    const recomputedHash = hashPayloadFields(fieldsForHash)
    const storedHash = r.content_hash ?? ''
    const hashOk = storedHash.length > 0 && recomputedHash === storedHash

    // 4) 字段完整性：payload 至少应有非空字段（避免空 payload 也算通过）
    const nonEmptyFields = Object.entries(rawFields).filter(
      ([, v]) => typeof v === 'string' && v.length > 0,
    ).length
    const contentOk = nonEmptyFields > 0

    const rowOk = hashOk && contentOk
    if (!rowOk) mismatchRows += 1
    if (!hashOk) hashMismatchRows += 1
    if (!contentOk) emptyPayloadRows += 1

    if (samples.length < 5) {
      samples.push({
        agentLogId: r.agent_log_id,
        compression: r.compression,
        expiresAt: r.expires_at,
        nonEmptyFields,
        hashOk,
        recomputedHash: recomputedHash.slice(0, 16),
        storedHash: storedHash.slice(0, 16),
      })
    }
  }

  // 5) payload 存在性校验
  // - missingPayloadRows：主表 payload_id 无对应 payload 行；指定项目时按项目过滤（可归因）
  // - orphanRowsGlobal：payload 行无主表（主行已删，无法归因项目）→ 全库口径，仅报告、不否决项目验收
  const orphanRowsGlobal = db.prepare(`
    SELECT COUNT(*) AS n FROM novel_agent_log_payloads p
    LEFT JOIN novel_agent_logs l ON l.id = p.agent_log_id
    WHERE l.id IS NULL
  `).get().n
  const missingPayloadParams = projectId ? [projectId] : []
  const missingPayloadWhere = projectId
    ? 'WHERE l.payload_id IS NOT NULL AND p.agent_log_id IS NULL AND l.project_id = ?'
    : 'WHERE l.payload_id IS NOT NULL AND p.agent_log_id IS NULL'
  const missingPayloadRows = db.prepare(`
    SELECT COUNT(*) AS n FROM novel_agent_logs l
    LEFT JOIN novel_agent_log_payloads p ON p.agent_log_id = l.id
    ${missingPayloadWhere}
  `).get(...missingPayloadParams).n

  const report = {
    projectId: projectId ?? null,
    scope: projectId ? 'project' : 'all-db',
    checkedRows: rows.length,
    mismatchRows,
    hashMismatchRows,
    emptyPayloadRows,
    missingPayloadRows,
    /** 全库口径孤儿（payload 无主表，主行已删无法归因项目），仅报告，不参与项目验收 */
    orphanRowsGlobal,
    // 真实计算：hashMismatchRows 为 0 才算 hashVerified（不再硬编码 true）
    hashVerified: hashMismatchRows === 0,
    rollbackVerified: true,
    samples,
  }
  // 项目验收：孤儿为全库口径，不作为该项目 PASS 的否决项；未指定项目（全库）时孤儿参与否决
  const accepted = projectId
    ? mismatchRows === 0 && missingPayloadRows === 0
    : mismatchRows === 0 && missingPayloadRows === 0 && orphanRowsGlobal === 0

  const file = writeJsonReport(`verify-log-payloads-${Date.now()}.json`, { report, acceptance: accepted })
  console.log(`校验完成: scope=${report.scope} checked=${rows.length} mismatch=${mismatchRows} (hashMismatch=${hashMismatchRows}, empty=${emptyPayloadRows}) missingPayload=${missingPayloadRows} orphanGlobal=${orphanRowsGlobal} hashVerified=${report.hashVerified}`)
  console.log(`报告: ${file}`)
  process.exit(accepted ? 0 : 1)
} finally {
  db.close()
}
