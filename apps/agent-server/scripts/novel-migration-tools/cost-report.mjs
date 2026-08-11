/**
 * cost-report.mjs — P0-2 成本报表 CLI（只读）。
 *
 * 按 project_id + chapter_number 输出六项指标，支持 JSON / CSV。
 * 与 novel-routes 的 GET /projects/:projectId/cost-report 共用同一聚合口径。
 *
 * 用法：
 *   node scripts/novel-migration-tools/cost-report.mjs <projectId> [chapterNumber] [--csv]
 *
 * 输出：output/cost-report-<ts>.json|csv
 */
import { openDb, writeJsonReport } from './lib/db.mjs'

const projectId = process.argv[2]
const chapterNumber = process.argv[3] ? parseInt(process.argv[3], 10) : undefined
const asCsv = process.argv.includes('--csv')

const db = openDb()
try {
  if (!projectId) {
    console.error('用法: node cost-report.mjs <projectId> [chapterNumber] [--csv]')
    process.exit(2)
  }

  const chapterNumbers = chapterNumber != null
    ? [chapterNumber]
    : db.prepare('SELECT DISTINCT chapter_number AS n FROM novel_agent_logs WHERE project_id = ? ORDER BY n ASC').all(projectId).map((r) => r.n)

  const reports = []
  for (const num of chapterNumbers) {
    const logs = db.prepare(`
      SELECT id, project_id, chapter_number, agent_type, status, duration_ms,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
             llm_round_trips, created_at
      FROM novel_agent_logs
      WHERE project_id = ? AND chapter_number = ?
      ORDER BY created_at ASC
    `).all(projectId, num)

    const sections = db.prepare(`
      SELECT agent_log_id, section_type, section_id, chars
      FROM novel_context_section_metrics
      WHERE project_id = ? AND chapter_number = ?
    `).all(projectId, num)

    const sectionByLog = new Map()
    const sharedByLog = new Map()
    const arrangedByLog = new Map()
    for (const s of sections) {
      if (s.section_id === 'shared') {
        sharedByLog.set(s.agent_log_id, (sharedByLog.get(s.agent_log_id) ?? 0) + s.chars)
      }
      if (s.section_id === 'arranged-entities') {
        arrangedByLog.set(s.agent_log_id, (arrangedByLog.get(s.agent_log_id) ?? 0) + s.chars)
        continue
      }
      if (!sectionByLog.has(s.agent_log_id)) sectionByLog.set(s.agent_log_id, new Map())
      sectionByLog.get(s.agent_log_id).set(s.section_type, (sectionByLog.get(s.agent_log_id).get(s.section_type) ?? 0) + s.chars)
    }

    const rows = logs.map((l) => {
      const sec = sectionByLog.get(l.id) ?? new Map()
      return {
        projectId: l.project_id,
        chapterNumber: l.chapter_number,
        agentType: l.agent_type,
        agentLogId: l.id,
        inputTokens: l.input_tokens,
        outputTokens: l.output_tokens,
        cacheReadTokens: l.cache_read_tokens,
        cacheWriteTokens: l.cache_write_tokens,
        llmRoundTrips: l.llm_round_trips ?? 0,
        durationMs: l.duration_ms,
        status: l.status,
        createdAt: l.created_at,
        systemChars: sec.get('system') ?? 0,
        sharedChars: sharedByLog.get(l.id) ?? 0,
        identityChars: sec.get('identity') ?? 0,
        suffixChars: sec.get('suffix') ?? 0,
        dynamicChars: sec.get('dynamic') ?? 0,
        toolSchemaChars: sec.get('tool_schema') ?? 0,
        arrangedEntitiesChars: arrangedByLog.get(l.id) ?? 0,
      }
    })

    const totalShared = rows.reduce((s, r) => s + r.sharedChars, 0)
    const totalArranged = rows.reduce((s, r) => s + r.arrangedEntitiesChars, 0)
    const totalInputChars = rows.reduce((s, r) => s + r.systemChars + r.sharedChars + r.identityChars + r.suffixChars + r.dynamicChars + r.toolSchemaChars, 0)
    const totalToolSchema = rows.reduce((s, r) => s + r.toolSchemaChars, 0)
    const totalRoundTrips = rows.reduce((s, r) => s + r.llmRoundTrips, 0)
    const totalInputTokens = rows.reduce((s, r) => s + r.inputTokens, 0)
    const totalCacheRead = rows.reduce((s, r) => s + r.cacheReadTokens, 0)

    const costByAgent = new Map()
    for (const r of rows) {
      if (!costByAgent.has(r.agentType)) costByAgent.set(r.agentType, { calls: 0, input: 0, cacheRead: 0 })
      const e = costByAgent.get(r.agentType)
      e.calls += 1
      e.input += r.inputTokens
      e.cacheRead += r.cacheReadTokens
    }
    const totalCost = [...costByAgent.values()].reduce((s, e) => s + e.input + e.cacheRead, 0)
    const agentShares = [...costByAgent.entries()].map(([agentType, e]) => ({
      agentType,
      calls: e.calls,
      costUnits: e.input + e.cacheRead,
      sharePct: totalCost > 0 ? (e.input + e.cacheRead) / totalCost : 0,
    })).sort((a, b) => b.costUnits - a.costUnits)

    reports.push({
      projectId,
      chapterNumber: num,
      rows,
      firstCallInputTokens: rows[0]?.inputTokens ?? 0,
      firstCallCacheReadTokens: rows[0]?.cacheReadTokens ?? 0,
      agentShares,
      arrangedEntitiesShareOfSharedPct: totalShared > 0 ? totalArranged / totalShared : null,
      toolSchemaShareOfInputPct: totalInputChars > 0 ? totalToolSchema / totalInputChars : 0,
      roundTripTotal: totalRoundTrips,
      cacheReadRatio: totalInputTokens > 0 ? totalCacheRead / totalInputTokens : 0,
    })
  }

  const ts = Date.now()
  if (asCsv) {
    const header = [
      'projectId,chapterNumber,agentType,agentLogId,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,llmRoundTrips,durationMs,status,createdAt,systemChars,sharedChars,identityChars,suffixChars,dynamicChars,toolSchemaChars,arrangedEntitiesChars',
    ]
    const lines = [header]
    for (const report of reports) {
      for (const r of report.rows) {
        lines.push([
          r.projectId, r.chapterNumber, r.agentType, r.agentLogId, r.inputTokens, r.outputTokens,
          r.cacheReadTokens, r.cacheWriteTokens, r.llmRoundTrips, r.durationMs, r.status,
          r.createdAt, r.systemChars, r.sharedChars, r.identityChars, r.suffixChars,
          r.dynamicChars, r.toolSchemaChars, r.arrangedEntitiesChars,
        ].join(','))
      }
    }
    const { writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { mkdirSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    // ⚠️ 必须用 fileURLToPath 而不是 new URL(...).pathname：Windows 下 pathname 为
    // "/D:/..." POSIX 风格，join 后产生 "D:\D:\..." 双盘符导致 ENOENT。
    // 注意相对本文件（scripts/novel-migration-tools/）应为 ./output/，不是 ../output/。
    const dir = fileURLToPath(new URL('./output/', import.meta.url))
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `cost-report-${ts}.csv`)
    writeFileSync(file, lines.join('\n'), 'utf8')
    console.log(`CSV 报告: ${file}（${reports.reduce((s, r) => s + r.rows.length, 0)} 行）`)
    process.exit(0)
  }

  const file = writeJsonReport(`cost-report-${ts}.json`, { projectId, chapterNumber: chapterNumber ?? null, reports })
  console.log(`JSON 报告: ${file}（${reports.length} 章）`)
  process.exit(0)
} finally {
  db.close()
}
