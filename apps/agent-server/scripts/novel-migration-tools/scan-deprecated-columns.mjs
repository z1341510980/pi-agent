/**
 * scan-deprecated-columns.mjs — P1-4 删除前引用扫描（只读）。
 *
 * 扫描业务代码 SQL + e2e 断言中对 novel_conflicts / novel_factions
 * first_chapter / last_chapter 的引用，业务引用 = 0 才允许执行迁移 089。
 *
 * 扫描口径（精确到 SQL 上下文）：
 * - 只检查模板字符串里的 SQL 语句（`` `...` ``），且语句显式引用
 *   novel_conflicts / novel_factions 两表；避免把 locations/foreshadowing
 *   的 first_chapter（不在本次范围）或 JS 对象键误报为引用。
 * - novel-migrations.ts 中的历史迁移（045 回填 SQL）归类为 historical，
 *   不计入业务引用（迁移 045 先于 089 执行，引用旧列是正确历史）。
 *
 * 用法：
 *   node scripts/novel-migration-tools/scan-deprecated-columns.mjs
 *
 * 输出：output/scan-deprecated-columns-<ts>.json；业务引用 = 0 退出码 0，否则 1。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb, writeJsonReport } from './lib/db.mjs'

// ⚠️ 必须用 fileURLToPath 而不是 new URL(...).pathname：Windows 下 pathname 为 "/D:/..."
// POSIX 风格，join 后产生 "D:\D:\..." 双盘符导致 ENOENT。
const ROOT = fileURLToPath(new URL('../..', import.meta.url)) // apps/agent-server/
const SCAN_DIRS = ['src', 'scripts']
const TARGET_TABLES = ['novel_conflicts', 'novel_factions']
const DEPRECATED_COLUMNS = ['first_chapter', 'last_chapter']
/** 历史迁移文件：其中对旧列的引用是正确历史（045 先于 089），不计入业务引用 */
const MIGRATION_FILE = 'novel-migrations.ts'

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name)
    if (statSync(file).isDirectory()) {
      if (name === 'node_modules' || name === '__snapshots__') continue
      walk(file, out)
    } else if (/\.(ts|tsx|mjs|js|sql)$/.test(name)) {
      out.push(file)
    }
  }
  return out
}

/** 提取模板字符串内的 SQL 语句并检查目标表是否引用废弃列 */
function scanSqlContent(file, content) {
  const hits = []
  const stmtRe = /`([^`]*)`/g
  const tableRe = /(?:INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE)\s+(novel_conflicts|novel_factions)\b/g
  let m
  stmtRe.lastIndex = 0
  while ((m = stmtRe.exec(content)) !== null) {
    const stmt = m[1]
    const tables = new Set()
    let t
    tableRe.lastIndex = 0
    while ((t = tableRe.exec(stmt)) !== null) tables.add(t[1])
    if (tables.size === 0) continue
    const hasDeprecated = DEPRECATED_COLUMNS.some((col) => stmt.includes(col))
    if (hasDeprecated) {
      hits.push({
        file: file.replace(ROOT, 'apps/agent-server/'),
        tables: [...tables],
        snippet: stmt.replace(/\s+/g, ' ').trim().slice(0, 120),
      })
    }
  }
  return hits
}

const db = openDb()
try {
  const allHits = []
  for (const dir of SCAN_DIRS) {
    const root = join(ROOT, dir)
    if (!statSync(root).isDirectory()) continue
    for (const file of walk(root)) {
      const content = readFileSync(file, 'utf8')
      allHits.push(...scanSqlContent(file, content))
    }
  }

  // 业务引用：排除历史迁移文件
  const businessHits = allHits.filter((h) => !h.file.endsWith(MIGRATION_FILE))
  const historicalHits = allHits.filter((h) => h.file.endsWith(MIGRATION_FILE))

  // 数据库实际列状态（仅当表存在时）
  let dbColumns = {}
  for (const table of TARGET_TABLES) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all()
    dbColumns[table] = cols.map((c) => c.name)
  }

  const report = {
    scannedDirs: SCAN_DIRS,
    businessRefs: businessHits.length,
    historicalRefs: historicalHits.length,
    hits: businessHits,
    historicalHits,
    dbColumns,
    // 验收：业务引用 = 0 且新库不再含这两列（历史迁移引用允许存在）
    acceptable: businessHits.length === 0 &&
      !dbColumns.novel_conflicts?.includes('first_chapter') &&
      !dbColumns.novel_factions?.includes('first_chapter'),
  }

  const file = writeJsonReport(`scan-deprecated-columns-${Date.now()}.json`, report)
  console.log(`引用扫描: businessRefs=${businessHits.length} historicalRefs=${historicalHits.length}`)
  for (const h of businessHits.slice(0, 20)) console.log(`  - ${h.file}: ${h.snippet}`)
  console.log(`数据库列: conflicts=${JSON.stringify(dbColumns.novel_conflicts)} factions=${JSON.stringify(dbColumns.novel_factions)}`)
  console.log(`报告: ${file}`)
  process.exit(report.acceptable ? 0 : 1)
} finally {
  db.close()
}
