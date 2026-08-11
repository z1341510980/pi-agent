/**
 * sample-baseline.mjs — P0-4 基线采样跑批（只读）。
 *
 * 按 §13.3 采样要求输出基线报告：≥ 30 普通 + 10 多实体 + 10 修订/重写，≥ 2 Provider。
 * 实际采样量取决于库内已有日志；本脚本聚合已有数据并标注缺口，作为 P3 决策输入。
 *
 * 用法：
 *   node scripts/novel-migration-tools/sample-baseline.mjs <projectId> [--csv]
 *
 * 输出：output/sample-baseline-<ts>.json + docs/novel/2026-08-07-成本基线采样结论-<ts>.md
 */
import { openDb, writeJsonReport } from './lib/db.mjs'

const projectId = process.argv[2]

const db = openDb()
try {
  if (!projectId) {
    console.error('用法: node sample-baseline.mjs <projectId>')
    process.exit(2)
  }

  // 按章聚合：普通（无 arranged-entities 度量）/ 多实体（有 arranged-entities 且字符占比高）
  const metrics = db.prepare(`
    SELECT chapter_number, section_id, chars
    FROM novel_context_section_metrics
    WHERE project_id = ?
  `).all(projectId)

  const metricByChapter = new Map()
  for (const m of metrics) {
    if (!metricByChapter.has(m.chapter_number)) metricByChapter.set(m.chapter_number, { shared: 0, arranged: 0 })
    const entry = metricByChapter.get(m.chapter_number)
    if (m.section_id === 'shared') entry.shared += m.chars
    if (m.section_id === 'arranged-entities') entry.arranged += m.chars
  }

  const logs = db.prepare(`
    SELECT chapter_number, agent_type, llm_provider, llm_model, status, input_tokens,
           cache_read_tokens, llm_round_trips, created_at
    FROM novel_agent_logs
    WHERE project_id = ?
    ORDER BY created_at ASC
  `).all(projectId)

  const chapters = new Map()
  for (const l of logs) {
    if (!chapters.has(l.chapter_number)) chapters.set(l.chapter_number, {
      chapterNumber: l.chapter_number,
      agents: [],
      providers: new Set(),
      models: new Set(),
      hasRevisionOrRewrite: false,
    })
    const entry = chapters.get(l.chapter_number)
    entry.agents.push(l.agent_type)
    if (l.llm_provider) entry.providers.add(l.llm_provider)
    if (l.llm_model) entry.models.add(l.llm_model)
    if (l.agent_type === 'reviser') entry.hasRevisionOrRewrite = true
  }

  let normal = 0
  let multiEntity = 0
  let revision = 0
  for (const [num, entry] of chapters) {
    const arranged = metricByChapter.get(num)?.arranged ?? 0
    const shared = metricByChapter.get(num)?.shared ?? 0
    if (entry.hasRevisionOrRewrite) revision += 1
    else if (arranged > 0 && shared > 0 && arranged / shared >= 0.1) multiEntity += 1
    else normal += 1
  }

  const providers = new Set()
  const models = new Set()
  for (const [, entry] of chapters) {
    for (const p of entry.providers) providers.add(p)
    for (const m of entry.models) models.add(m)
  }

  const providerCount = providers.size
  const report = {
    projectId,
    sampledAt: new Date().toISOString(),
    sampledChapters: chapters.size,
    breakdown: { normal, multiEntity, revision },
    required: { normal: 30, multiEntity: 10, revision: 10 },
    coverage: {
      normal: `${normal}/30`,
      multiEntity: `${multiEntity}/10`,
      revision: `${revision}/10`,
    },
    providers: [...providers],
    models: [...models],
    providerCoverage: providerCount >= 2 ? 'PASS' : 'FAIL',
    samplingComplete: normal >= 30 && multiEntity >= 10 && revision >= 10 && providerCount >= 2,
  }

  const file = writeJsonReport(`sample-baseline-${Date.now()}.json`, report)
  console.log(`采样基线: chapters=${chapters.size} normal=${normal} multiEntity=${multiEntity} revision=${revision} providers=${providerCount}`)
  console.log(`报告: ${file}`)
  process.exit(report.samplingComplete ? 0 : 1)
} finally {
  db.close()
}
