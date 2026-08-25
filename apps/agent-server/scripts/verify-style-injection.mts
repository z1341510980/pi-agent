import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { compileWritingStylePrompt } from '../src/plugins/novel-plugin/core/prompting/writing-style-prompt-factory.js'
import type { NovelWritingStyleProfile, NovelStyleExpert } from '@repo/shared/novel'

const projectId = '0870c569-4c57-4648-94e9-9d66b931ec7d'
const db = new Database(join(homedir(), '.pi', 'wenlang-agent.db'), { readonly: true })

const row = db.prepare('SELECT * FROM novel_writing_style_profiles WHERE project_id = ?').get(projectId) as any
if (!row) { console.error('profile missing'); process.exit(1) }
const expertRows = db.prepare('SELECT * FROM novel_style_experts WHERE project_id = ? ORDER BY sort_order').all(projectId) as any[]

const profile: NovelWritingStyleProfile = {
  id: row.id,
  projectId,
  name: row.name,
  preset: row.preset,
  narrativePerson: row.narrative_person,
  narrativeDistance: row.narrative_distance,
  sentenceRhythm: row.sentence_rhythm,
  dialogueRatio: row.dialogue_ratio,
  emotionalTemperature: row.emotional_temperature,
  imageryDensity: row.imagery_density,
  vocabularyRegister: row.vocabulary_register,
  hardRules: JSON.parse(row.hard_rules),
  softRules: JSON.parse(row.soft_rules),
  positiveExamples: JSON.parse(row.positive_examples),
  negativeExamples: JSON.parse(row.negative_examples || '[]'),
  notes: row.notes ?? '',
  styleExperts: expertRows.map((r): NovelStyleExpert => ({
    id: r.id, name: r.name, sourceTitle: r.source_title, sourceAuthor: r.source_author ?? undefined,
    description: r.description, distilledPrompt: r.distilled_prompt,
    techniques: r.techniques_json ? JSON.parse(r.techniques_json) : undefined,
    exclusions: r.exclusions_json ? JSON.parse(r.exclusions_json) : undefined,
    exemplarPassages: r.exemplars_json ? JSON.parse(r.exemplars_json) : undefined,
    expressionDna: r.expression_dna_json ? JSON.parse(r.expression_dna_json) : undefined,
    tensions: r.tensions_json ? JSON.parse(r.tensions_json) : undefined,
    antiPatterns: r.anti_patterns_json ? JSON.parse(r.anti_patterns_json) : undefined,
    boundaries: r.boundaries_json ? JSON.parse(r.boundaries_json) : undefined,
    sortOrder: r.sort_order, projectId, version: r.version,
    createdAt: r.created_at, updatedAt: r.updated_at, enabled: !!r.enabled,
  })),
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
}

for (const target of ['writer', 'reviewer', 'reviser'] as const) {
  const compiled = compileWritingStylePrompt(profile, target)
  const text = compiled?.content ?? ''
  console.log(`--- ${target}: ${text.length} chars`)
  const probes = [
    '压后爆·情感白描',
    '对话暗线·权力推演',
    '长生尺度·账本叙事',
    '动作场面·异象分层',
    '语言指纹：句式=',
    '张力「克制与引爆」',
    '失效条件=',
    '本能力反模式：',
    '能力边界：',
    '不得迁移：',
    '手法样本（只学机制）：',   // 范例段（预算末位，允许被截断）
    '我不想死啊',             // 正向锚定样本
    '感官堆叠',               // 反向样本说明
  ]
  for (const probe of probes) {
    if (!text.includes(probe)) console.log(`  缺失:「${probe}」`)
  }
  const critical = ['压后爆·情感白描', '对话暗线·权力推演', '长生尺度·账本叙事', '动作场面·异象分层', '语言指纹：句式=', '张力「克制与引爆」', '失效条件=', '本能力反模式：', '能力边界：', '不得迁移：']
  console.log('  关键护栏探针: ' + (critical.every((p) => text.includes(p)) ? '全部命中' : '有缺失（见上）'))
}
