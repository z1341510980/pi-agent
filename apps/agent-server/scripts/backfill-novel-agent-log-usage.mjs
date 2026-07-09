#!/usr/bin/env node
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { homedir } from 'node:os'

const args = new Set(process.argv.slice(2))
const getArg = (name, fallback) => {
  const prefix = `${name}=`
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix))
  return found ? found.slice(prefix.length) : fallback
}

const apply = args.has('--apply')
const dbPath = getArg('--db', process.env.PI_DB_PATH ?? join(homedir(), '.pi', 'wenlang-agent.db'))
const projectId = getArg('--project', '')
const windowMs = Number(getArg('--window-ms', '1000'))

const db = new Database(dbPath)

const whereProject = projectId ? 'AND project_id = @projectId' : ''
const logs = db.prepare(`
  SELECT id, project_id, agent_type, chapter_number, created_at, duration_ms
  FROM novel_agent_logs
  WHERE input_tokens = 0
    AND output_tokens = 0
    AND cache_read_tokens = 0
    AND cache_write_tokens = 0
    ${whereProject}
  ORDER BY created_at ASC
`).all({ projectId })

const usageStmt = db.prepare(`
  SELECT provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, timestamp
  FROM usage_records
  WHERE timestamp >= @startMs AND timestamp <= @endMs
  ORDER BY timestamp ASC
`)

const updateStmt = db.prepare(`
  UPDATE novel_agent_logs
  SET input_tokens = @inputTokens,
      output_tokens = @outputTokens,
      cache_read_tokens = @cacheReadTokens,
      cache_write_tokens = @cacheWriteTokens,
      llm_provider = @provider,
      llm_model = @model
  WHERE id = @id
`)

let matched = 0
let updated = 0
const samples = []

const tx = db.transaction(() => {
  for (const log of logs) {
    const endMs = log.created_at * 1000 + windowMs
    const startMs = log.created_at * 1000 - Math.max(log.duration_ms ?? 0, 0) - windowMs
    const rows = usageStmt.all({ startMs, endMs })
    if (rows.length === 0) continue
    matched++

    const latest = rows[rows.length - 1]
    const usage = rows.reduce((sum, row) => ({
      inputTokens: sum.inputTokens + (row.input_tokens ?? 0),
      outputTokens: sum.outputTokens + (row.output_tokens ?? 0),
      cacheReadTokens: sum.cacheReadTokens + (row.cache_read_tokens ?? 0),
      cacheWriteTokens: sum.cacheWriteTokens + (row.cache_write_tokens ?? 0),
    }), {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })

    if (usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens === 0) continue
    const payload = {
      id: log.id,
      ...usage,
      provider: latest.provider ?? '',
      model: latest.model ?? '',
    }
    if (apply) {
      updateStmt.run(payload)
      updated++
    }
    if (samples.length < 10) {
      samples.push({
        id: log.id,
        projectId: log.project_id,
        chapterNumber: log.chapter_number,
        agentType: log.agent_type,
        usageRecords: rows.length,
        ...usage,
      })
    }
  }
})

tx()

console.log(JSON.stringify({
  dbPath,
  projectId: projectId || null,
  dryRun: !apply,
  scanned: logs.length,
  matched,
  updated,
  samples,
}, null, 2))

db.close()
