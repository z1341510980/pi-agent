/**
 * SQLite 数据库验证模块
 *
 * 直接读取 wenlang-agent.db 文件，验证 L2/A3/GAP 等架构演进改动是否真正落库。
 *
 * 默认数据路径：~/.pi/wenlang-agent.db
 * 可通过 PI_DATA_DIR 环境变量覆盖
 */

import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** 测试运行 ID，用于把本次测试产生的 agent_call_logs 行筛选出来 */
export const RUN_ID = randomUUID()

export function resolveDbPath() {
  const dataDir = process.env.PI_DATA_DIR ?? join(homedir(), '.pi')
  return join(dataDir, 'wenlang-agent.db')
}

/**
 * 打开数据库只读连接（验证脚本不应写入业务表）
 */
export function openDb() {
  const dbPath = resolveDbPath()
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  return db
}

/**
 * 验证 A3 AgentCallLogger：本次测试运行写入 agent_call_logs 的记录
 *
 * @param {string} threadIdPrefix - novel session threadId 前缀（如 'plugin:novel-plugin:'）；
 *                                  若为空字符串则返回最近所有记录
 * @returns {{total: number, byAgent: Record<string, number>, samples: any[], ok: boolean}}
 */
export function verifyAgentCallLogs(threadIdPrefix) {
  const db = openDb()
  try {
    const rows = threadIdPrefix
      ? db.prepare(`
        SELECT agent_id, agent_name, thread_id, system_prompt, user_message,
               result_length, duration_ms, status, error, metadata, created_at
        FROM agent_call_logs
        WHERE thread_id LIKE ?
        ORDER BY created_at DESC
        LIMIT 20
      `).all(`${threadIdPrefix}%`)
      : db.prepare(`
        SELECT agent_id, agent_name, thread_id, system_prompt, user_message,
               result_length, duration_ms, status, error, metadata, created_at
        FROM agent_call_logs
        ORDER BY created_at DESC
        LIMIT 20
      `).all()

    const byAgent = {}
    for (const row of rows) {
      const key = row.agent_name || row.agent_id
      byAgent[key] = (byAgent[key] || 0) + 1
    }

    const samples = rows.slice(0, 3).map((r) => ({
      agentId: r.agent_id,
      agentName: r.agent_name,
      threadId: r.thread_id,
      resultLength: r.result_length,
      durationMs: r.duration_ms,
      status: r.status,
      error: r.error,
      metadata: safeJson(r.metadata),
      systemPromptHead: (r.system_prompt || '').slice(0, 80),
    }))

    // 验证 metadata 包含领域扩展字段（A3 设计）
    const withProjectId = rows.filter((r) => {
      const m = safeJson(r.metadata)
      return m && m.projectId
    }).length

    return {
      total: rows.length,
      byAgent,
      withProjectId,
      samples,
      ok: rows.length > 0 && withProjectId > 0,
    }
  } finally {
    db.close()
  }
}

/**
 * 验证 GAP A 修复：novel_character_history 表在章节创作后应有写入
 */
export function verifyCharacterHistory(projectId) {
  const db = openDb()
  try {
    const rows = db.prepare(`
      SELECT character_id, chapter_number, field_name, old_value, new_value, reason, created_at
      FROM novel_character_history
      WHERE project_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `).all(projectId)

    const byCharacter = {}
    for (const r of rows) {
      byCharacter[r.character_id] = (byCharacter[r.character_id] || 0) + 1
    }

    return {
      total: rows.length,
      byCharacter,
      samples: rows.slice(0, 5),
      ok: rows.length > 0,
    }
  } finally {
    db.close()
  }
}

/**
 * 验证 GAP C 修复：novel_conflicts / novel_factions 的出场区间由 chapter_spans 表达
 * （first_chapter/last_chapter 已于迁移 089 删除，验证口径切到 chapter_spans）。
 *
 * 注意：novel_characters 表没有 first_chapter/last_chapter 列（GAP C 不针对 characters）。
 * 验证范围限定为 conflicts / factions / locations（appear_chapters TEXT）。
 */
export function verifyChapterDimensions(projectId) {
  const db = openDb()
  try {
    const conflicts = db.prepare(`
      SELECT id, description, chapter_spans
      FROM novel_conflicts
      WHERE project_id = ?
    `).all(projectId)

    const factions = db.prepare(`
      SELECT id, name, chapter_spans
      FROM novel_factions
      WHERE project_id = ?
    `).all(projectId)

    const locations = db.prepare(`
      SELECT id, name, appear_chapters
      FROM novel_locations
      WHERE project_id = ?
    `).all(projectId)

    const parseSpans = (raw) => {
      if (!raw) return []
      try {
        const arr = JSON.parse(raw)
        return Array.isArray(arr) ? arr : []
      } catch {
        return []
      }
    }
    const nonEmptySpans = (row) => parseSpans(row.chapter_spans).length > 0

    return {
      conflicts: {
        total: conflicts.length,
        withChapterSpans: conflicts.filter(nonEmptySpans).length,
        samples: conflicts.slice(0, 5).map((c) => ({ id: c.id, description: c.description, chapter_spans: parseSpans(c.chapter_spans) })),
      },
      factions: {
        total: factions.length,
        withChapterSpans: factions.filter(nonEmptySpans).length,
        samples: factions.slice(0, 5).map((f) => ({ id: f.id, name: f.name, chapter_spans: parseSpans(f.chapter_spans) })),
      },
      locations: {
        total: locations.length,
        withAppearChapters: locations.filter(
          (l) => l.appear_chapters && l.appear_chapters !== '[]',
        ).length,
        samples: locations.slice(0, 5),
      },
      ok:
        conflicts.some(nonEmptySpans) ||
        factions.some(nonEmptySpans),
    }
  } finally {
    db.close()
  }
}

/**
 * 验证 novel_agent_logs（领域层日志表，与 A3 通用表互补）
 */
export function verifyNovelAgentLogs(projectId) {
  const db = openDb()
  try {
    // 检查表是否存在
    const tableExists = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='novel_agent_logs'",
      )
      .get()
    if (!tableExists) {
      return { exists: false, total: 0, byAgent: {}, ok: false }
    }

    const rows = db.prepare(`
      SELECT agent_type, phase, status, duration_ms, chapter_number, created_at
      FROM novel_agent_logs
      WHERE project_id = ?
      ORDER BY created_at DESC
      LIMIT 30
    `).all(projectId)

    const byAgent = {}
    for (const r of rows) {
      byAgent[r.agent_type] = (byAgent[r.agent_type] || 0) + 1
    }

    return {
      exists: true,
      total: rows.length,
      byAgent,
      samples: rows.slice(0, 5),
      ok: rows.length > 0,
    }
  } finally {
    db.close()
  }
}

/**
 * 验证 Memory Agent 写入的记忆事件（GAP B：role-memory.md 强制 chapterNumber）
 *
 * 表结构：novel_memory_events(id, project_id, chapter_id, chapter_number,
 *   event_type, entity_id, entity_type, description, old_value, new_value,
 *   cause, effect_ids, significance, created_at)
 */
export function verifyMemoryEvents(projectId) {
  const db = openDb()
  try {
    const rows = db.prepare(`
      SELECT id, chapter_id, chapter_number, event_type, entity_type,
             description, significance, created_at
      FROM novel_memory_events
      WHERE project_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `).all(projectId)

    const withChapterNumber = rows.filter((r) => r.chapter_number !== null).length

    return {
      total: rows.length,
      withChapterNumber,
      samples: rows.slice(0, 5),
      ok: rows.length > 0 && withChapterNumber === rows.length,
    }
  } finally {
    db.close()
  }
}

function safeJson(s) {
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

// ═══════════════════════════════════════════════════════════════
// P1 迁移验证骨架（T-01 预留，T-03/T-04 填充实现）
// ═══════════════════════════════════════════════════════════════

/**
 * 验证 P1-1 版本链收敛：novel_chapters.current_content_revision_id 指向的
 * content 与 novel_chapters.content 一致（抽查全部章节，差异 = 0）。
 */
export function verifyVersionChains(projectId) {
  const db = openDb()
  try {
    const rows = db.prepare(`
      SELECT c.id AS chapter_id, c.content AS chapter_content,
             c.current_content_revision_id,
             r.content AS revision_content, r.status AS revision_status
      FROM novel_chapters c
      LEFT JOIN novel_chapter_content_revisions r
        ON r.id = c.current_content_revision_id
      WHERE c.project_id = ?
    `).all(projectId)

    const mismatched = rows.filter(
      (r) => r.current_content_revision_id != null && r.revision_content !== r.chapter_content,
    ).map((r) => ({
      chapterId: r.chapter_id,
      chapterContentHash: r.chapter_content,
      revisionContentHash: r.revision_content,
    }))

    return {
      total: rows.length,
      withPointer: rows.filter((r) => r.current_content_revision_id != null).length,
      mismatched,
      ok: mismatched.length === 0,
    }
  } finally {
    db.close()
  }
}

/**
 * 验证 P1-2 日志冷热分离：novel_agent_log_payloads 表存在且可回读。
 * 仅校验行数与字段完整性元信息，不解压全文（避免审计列表变慢）。
 */
export function verifyLogPayloads(projectId) {
  const db = openDb()
  try {
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='novel_agent_log_payloads'")
      .get()
    if (!tableExists) {
      return { exists: false, total: 0, ok: false }
    }
    const rows = db.prepare(`
      SELECT p.agent_log_id, p.compression, p.content_hash, p.expires_at,
             l.id AS main_id, l.payload_id
      FROM novel_agent_log_payloads p
      JOIN novel_agent_logs l ON l.id = p.agent_log_id
      WHERE l.project_id = ?
      ORDER BY p.created_at DESC
      LIMIT 30
    `).all(projectId)

    const orphan = db.prepare(`
      SELECT COUNT(*) AS n FROM novel_agent_log_payloads p
      LEFT JOIN novel_agent_logs l ON l.id = p.agent_log_id
      WHERE l.id IS NULL
    `).get().n

    return {
      exists: true,
      total: rows.length,
      withHash: rows.filter((r) => r.content_hash && r.content_hash.length > 0).length,
      orphan,
      samples: rows.slice(0, 3),
      ok: orphan === 0,
    }
  } finally {
    db.close()
  }
}

/**
 * 验证 P1-3 Scene Cast 合并：novel_scene_cast 表存在且行数/角色分布可读。
 * 完整往返对账见 scripts/novel-migration-tools/reconcile-scene-cast.mjs。
 */
export function verifySceneCast(projectId) {
  const db = openDb()
  try {
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='novel_scene_cast'")
      .get()
    if (!tableExists) {
      return { exists: false, total: 0, ok: false }
    }
    const rows = db.prepare(`
      SELECT sc.scene_revision_id, sc.character_id, sc.role, sc.function, sc.prominence
      FROM novel_scene_cast sc
      JOIN novel_scene_revisions sr ON sr.id = sc.scene_revision_id
      WHERE sr.project_id = ?
      ORDER BY sc.scene_revision_id, sc.role
      LIMIT 50
    `).all(projectId)

    const byRole = {}
    for (const r of rows) {
      byRole[r.role] = (byRole[r.role] || 0) + 1
    }

    const functionalWithoutFunction = db.prepare(`
      SELECT COUNT(*) AS n FROM novel_scene_cast
      WHERE role = 'functional' AND function IS NULL
    `).get().n

    return {
      exists: true,
      total: rows.length,
      byRole,
      functionalWithoutFunction,
      samples: rows.slice(0, 5),
      ok: functionalWithoutFunction === 0,
    }
  } finally {
    db.close()
  }
}
