/**
 * reconcile-entity-appearances.mjs — P2 对账工具
 *
 * 对比「实体表 chapter_spans 展开的章节」与「novel_entity_appearances 记录的章节」，
 * 报告差异（mismatchRows / orphanAppearanceRows），用于 appearanceV2Write 双写期对账。
 *
 * 用法：
 *   node scripts/novel-migration-tools/reconcile-entity-appearances.mjs [projectId] [--db=路径]
 *
 * 输出：output/reconcile-entity-appearances-<ts>.json
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const outputDir = path.join(__dirname, 'output')

const args = process.argv.slice(2)
const dbArg = args.find((a) => a.startsWith('--db='))?.slice('--db='.length)
const projectIdArg = args.find((a) => !a.startsWith('--'))

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const dbPath = dbArg || path.join(HOME, '.pi', 'wenlang-agent.db')
const db = new Database(dbPath, { readonly: true })

/** 把 JSON 区间 [[start,end],...] 展开为章节号数组（角色用 character_history 覆盖） */
function expandSpans(spansJson) {
  try {
    const spans = JSON.parse(spansJson || '[]')
    const out = new Set()
    for (const [start, end] of spans) {
      for (let ch = start; ch <= end; ch += 1) out.add(ch)
    }
    return out
  } catch {
    return new Set()
  }
}

const entityTables = [
  { type: 'conflict', table: 'novel_conflicts', spanCol: 'chapter_spans' },
  { type: 'foreshadow', table: 'novel_foreshadowing', spanCol: 'chapter_spans' },
  { type: 'clue', table: 'novel_clues', spanCol: 'chapter_spans' },
  { type: 'faction', table: 'novel_factions', spanCol: 'chapter_spans' },
  { type: 'location', table: 'novel_locations', spanCol: 'appear_chapters' },
  { type: 'item', table: 'novel_items', spanCol: 'chapter_spans' },
  { type: 'narrative', table: 'novel_narratives', spanCol: 'chapter_spans' },
]

const projectFilter = projectIdArg ? 'WHERE project_id = ?' : ''
const projectParams = projectIdArg ? [projectIdArg] : []

let mismatchRows = 0
let orphanAppearanceRows = 0
let checkedRows = 0
let unpersistedRefs = 0
const details = []

// chapter_id → chapter_number 映射（chapter_id 全局唯一，直接用 id 反查）
const chapterNumberById = new Map()
const chapters = db.prepare('SELECT id, chapter_number FROM novel_chapters').all()
for (const c of chapters) chapterNumberById.set(c.id, c.chapter_number)

for (const { type, table, spanCol } of entityTables) {
  const rows = db.prepare(`SELECT id, project_id, ${spanCol} AS spans FROM ${table} ${projectFilter}`).all(...projectParams)
  for (const row of rows) {
    const spanChapters = expandSpans(row.spans)
    if (spanChapters.size === 0) continue
    checkedRows += 1

    // 该项目已落库的章节号：appearance 只能记录已落库章节，未落库的 spans
    // 引用（如规划到第 14 章但正文只写到 11 章）单独统计，不算 mismatch。
    const projectChapterNumbers = new Set(
      db
        .prepare('SELECT chapter_number FROM novel_chapters WHERE project_id = ?')
        .all(row.project_id)
        .map((r) => r.chapter_number),
    )
    const persistedSpans = new Set([...spanChapters].filter((ch) => projectChapterNumbers.has(ch)))
    const unpersisted = [...spanChapters].filter((ch) => !projectChapterNumbers.has(ch))
    if (unpersisted.length > 0) unpersistedRefs += unpersisted.length
    if (persistedSpans.length === 0) continue

    // appearance 侧
    const appRows = db.prepare(
      'SELECT chapter_id FROM novel_entity_appearances WHERE project_id = ? AND entity_type = ? AND entity_id = ?',
    ).all(row.project_id, type, row.id)
    const appChapters = new Set(
      appRows.map((a) => chapterNumberById.get(a.chapter_id)).filter((n) => n !== undefined),
    )

    // 差异：span 有而 appearance 无 → 缺写；appearance 有而 span 无 → 多余
    const missing = [...persistedSpans].filter((ch) => !appChapters.has(ch))
    const extra = [...appChapters].filter((ch) => !persistedSpans.has(ch))
    if (missing.length > 0 || extra.length > 0) {
      mismatchRows += 1
      details.push({ type, entityId: row.id, missingChapters: missing, extraChapters: extra })
    }
  }
}

// orphan appearance：指向已不存在的实体
const orphanCheck = db.prepare(`
  SELECT a.entity_type AS type, a.entity_id AS id
  FROM novel_entity_appearances a
  WHERE NOT EXISTS (
    SELECT 1 FROM novel_conflicts c WHERE c.id = a.entity_id AND a.entity_type = 'conflict'
  ) AND NOT EXISTS (
    SELECT 1 FROM novel_foreshadowing f WHERE f.id = a.entity_id AND a.entity_type = 'foreshadow'
  ) AND NOT EXISTS (
    SELECT 1 FROM novel_clues cl WHERE cl.id = a.entity_id AND a.entity_type = 'clue'
  ) AND NOT EXISTS (
    SELECT 1 FROM novel_factions fa WHERE fa.id = a.entity_id AND a.entity_type = 'faction'
  ) AND NOT EXISTS (
    SELECT 1 FROM novel_locations lo WHERE lo.id = a.entity_id AND a.entity_type = 'location'
  ) AND NOT EXISTS (
    SELECT 1 FROM novel_items i WHERE i.id = a.entity_id AND a.entity_type = 'item'
  ) AND NOT EXISTS (
    SELECT 1 FROM novel_narratives n WHERE n.id = a.entity_id AND a.entity_type = 'narrative'
  )
`).all()
orphanAppearanceRows = orphanCheck.length

const report = {
  projectId: projectIdArg ?? 'all',
  checkedRows,
  mismatchRows,
  orphanAppearanceRows,
  unpersistedRefs,
  acceptable: mismatchRows === 0,
  details: details.slice(0, 100),
}

fs.mkdirSync(outputDir, { recursive: true })
const outFile = path.join(outputDir, `reconcile-entity-appearances-${Date.now()}.json`)
fs.writeFileSync(outFile, JSON.stringify(report, null, 2))
console.log(`JSON 报告: ${outFile}`)
console.log(`checked=${checkedRows} mismatch=${mismatchRows} orphan=${orphanAppearanceRows} unpersistedRefs=${unpersistedRefs} acceptable=${report.acceptable}`)
db.close()
process.exit(report.acceptable ? 0 : 1)
