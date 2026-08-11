/**
 * backfill-entity-appearances.mjs — P2 历史回填工具（一次性）
 *
 * 把实体表里已有的 chapter_spans / appear_chapters 展开，批量 INSERT 到
 * novel_entity_appearances（source='backfill', role='present'），补齐
 * appearanceV2Write flag 开启前缺失的历史出场数据。
 *
 * 用法：
 *   node scripts/novel-migration-tools/backfill-entity-appearances.mjs [--db=路径] [--dry]
 *   --dry 只统计不写入
 *
 * 注意：chapter 映射按 (project_id, chapter_number) 复合键，避免跨项目撞车。
 *       appearance 主键唯一键为 (chapter_id, entity_type, entity_id, role)，
 *       INSERT OR IGNORE 幂等，可重复执行。
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outputDir = path.join(__dirname, 'output')

const args = process.argv.slice(2)
const dbArg = args.find((a) => a.startsWith('--db='))?.slice('--db='.length)
const dry = args.includes('--dry')

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const dbPath = dbArg || path.join(HOME, '.pi', 'wenlang-agent.db')
const db = new Database(dbPath)

/** 展开 JSON 区间 [[start,end],...] 为章节号数组 */
function expandSpans(spansJson) {
  try {
    const spans = JSON.parse(spansJson || '[]')
    const out = new Set()
    for (const span of spans) {
      if (!Array.isArray(span)) continue
      const [start, end] = span
      if (typeof start !== 'number' || typeof end !== 'number') continue
      for (let ch = start; ch <= end; ch += 1) out.add(ch)
    }
    return out
  } catch {
    return new Set()
  }
}

/** 展开 JSON 数字数组 [1,2,3] 为章节号数组（location 用） */
function expandChapterList(json) {
  try {
    const arr = JSON.parse(json || '[]')
    return new Set(arr.filter((n) => typeof n === 'number'))
  } catch {
    return new Set()
  }
}

const entityTables = [
  { type: 'conflict', table: 'novel_conflicts', spanCol: 'chapter_spans', mode: 'spans' },
  { type: 'foreshadow', table: 'novel_foreshadowing', spanCol: 'chapter_spans', mode: 'spans' },
  { type: 'clue', table: 'novel_clues', spanCol: 'chapter_spans', mode: 'spans' },
  { type: 'faction', table: 'novel_factions', spanCol: 'chapter_spans', mode: 'spans' },
  { type: 'location', table: 'novel_locations', spanCol: 'appear_chapters', mode: 'list' },
  { type: 'item', table: 'novel_items', spanCol: 'chapter_spans', mode: 'spans' },
  { type: 'narrative', table: 'novel_narratives', spanCol: 'chapter_spans', mode: 'spans' },
]

// (project_id, chapter_number) → chapter_id 复合映射
const chapterMap = new Map()
const chapters = db.prepare('SELECT id, project_id, chapter_number FROM novel_chapters').all()
for (const c of chapters) chapterMap.set(`${c.project_id}|${c.chapter_number}`, c.id)

const insert = db.prepare(`
  INSERT OR IGNORE INTO novel_entity_appearances
    (id, project_id, chapter_id, entity_type, entity_id, appearance_role, source, created_at)
  VALUES (@id, @project_id, @chapter_id, @entity_type, @entity_id, 'present', 'backfill', unixepoch())
`)

const stats = {}
let inserted = 0
let skippedNoChapter = 0
let scannedEntities = 0

const run = db.transaction(() => {
  for (const { type, table, spanCol, mode } of entityTables) {
    const rows = db.prepare(`SELECT id, project_id, ${spanCol} AS spans FROM ${table}`).all()
    let typeInserted = 0
    for (const row of rows) {
      const chaptersSet = mode === 'spans' ? expandSpans(row.spans) : expandChapterList(row.spans)
      if (chaptersSet.size === 0) continue
      scannedEntities += 1
      for (const chapterNumber of chaptersSet) {
        const chapterId = chapterMap.get(`${row.project_id}|${chapterNumber}`)
        if (!chapterId) {
          skippedNoChapter += 1
          continue
        }
        if (!dry) {
          insert.run({
            id: randomUUID(),
            project_id: row.project_id,
            chapter_id: chapterId,
            entity_type: type,
            entity_id: row.id,
          })
        }
        typeInserted += 1
        inserted += 1
      }
    }
    stats[type] = { entities: rows.length, backfilledRows: typeInserted }
  }
})

run()
db.close()

const report = {
  db: dbPath,
  dry,
  scannedEntities,
  insertedRows: inserted,
  skippedNoChapter,
  byType: stats,
}
fs.mkdirSync(outputDir, { recursive: true })
const outFile = path.join(outputDir, `backfill-entity-appearances-${Date.now()}.json`)
fs.writeFileSync(outFile, JSON.stringify(report, null, 2))
console.log(`JSON 报告: ${outFile}`)
console.log(
  `scanned=${scannedEntities} inserted=${inserted} skippedNoChapter=${skippedNoChapter} ${dry ? '(dry)' : ''}`,
)
for (const [type, s] of Object.entries(stats)) {
  console.log(`  ${type}: 实体 ${s.entities} 行, 回填 ${s.backfilledRows} 条`)
}
