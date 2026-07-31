/**
 * 悬空账本引用清理脚本（S4-1c）。
 *
 * 清理指向已删除实体的账本引用与角色出场记录。
 *
 *   pnpm --filter agent-server cleanup:dangling --db <path>            # dry-run
 *   pnpm --filter agent-server cleanup:dangling --db <path> --apply    # 真正删除
 *
 * 参数：--db <path> / --project <id> / --apply
 *
 * ## 安全性
 *
 * - 不加 --apply 时以 readonly 打开，物理上无法写入。
 * - 只删"指向已不存在实体"的引用；不碰任何仍存在的实体或其记录。
 * - 与 S4-1a 的删除观察者是同一套清理逻辑，此后删实体会自动清理，本脚本只处理存量。
 * - --apply 前请先备份。⚠️ 库是 WAL 模式，直接 Copy-Item 只拷主文件会丢掉 -wal 里未
 *   checkpoint 的事务，得到的是不一致快照（本项目实测过差 17 条记录）。
 *   正确做法是用 SQLite 自带的一致快照：
 *     sqlite3 <db> "VACUUM INTO '<db>.bak'"
 */
import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { NovelStore } from '../src/plugins/novel-plugin/core/novel-store.js'
import { NovelMemoryStore } from '../src/plugins/novel-plugin/core/novel-memory-store.js'
import {
  planDanglingCleanup,
  applyDanglingCleanup,
  formatDanglingCleanupPlan,
} from '../src/plugins/novel-plugin/core/ledger-cleanup.js'
import { reconcileMatrixProjection } from '../src/plugins/novel-plugin/core/matrix-projection.js'

interface Args { db: string; project?: string; apply: boolean }

function parseArgs(argv: string[]): Args {
  const args: Args = { db: join(homedir(), '.pi', 'wenlang-agent.db'), apply: false }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--db') args.db = argv[++i]
    else if (flag === '--project') args.project = argv[++i]
    else if (flag === '--apply') args.apply = true
    else if (flag === '--help' || flag === '-h') {
      console.log('见文件头注释：--db / --project / --apply')
      process.exit(0)
    } else { console.error(`未知参数：${flag}`); process.exit(2) }
  }
  return args
}

function agreementOf(matched: number, total: number): string {
  return total === 0 ? '100%' : `${Math.round((matched / total) * 1000) / 10}%`
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(args.db)) { console.error(`数据库不存在：${args.db}`); process.exit(2) }

  const db = new Database(args.db, { readonly: !args.apply })
  try {
    const store = new NovelStore(db)
    const memoryStore = new NovelMemoryStore(db)
    const projects = db
      .prepare('SELECT id, title FROM novel_projects WHERE deleted_at IS NULL ORDER BY created_at')
      .all() as Array<{ id: string; title: string }>
    const targets = args.project ? projects.filter((p) => p.id === args.project) : projects

    console.log(`# 悬空账本引用清理${args.apply ? '（写入模式）' : '（dry-run，未写入）'}`)
    console.log('')
    console.log(`数据库：${args.db}`)

    for (const target of targets) {
      const before = reconcileMatrixProjection(store, memoryStore, target.id)
      if (before.danglingRefs.length === 0) continue
      const beforeTotal = before.matchedCount + before.missingInLedger.length
        + before.missingInEntityFields.length + before.danglingRefs.length

      console.log('')
      if (args.apply) {
        console.log(formatDanglingCleanupPlan(
          applyDanglingCleanup(store, memoryStore, target.id),
          { applied: true },
        ))
        const after = reconcileMatrixProjection(store, memoryStore, target.id)
        const afterTotal = after.matchedCount + after.missingInLedger.length
          + after.missingInEntityFields.length + after.danglingRefs.length
        console.log('')
        console.log(`一致率：${agreementOf(before.matchedCount, beforeTotal)} → ${agreementOf(after.matchedCount, afterTotal)}`)
        console.log(`悬空引用：${before.danglingRefs.length} → ${after.danglingRefs.length}`)
      } else {
        console.log(formatDanglingCleanupPlan(planDanglingCleanup(store, memoryStore, target.id)))
        console.log('')
        console.log(`当前一致率：${agreementOf(before.matchedCount, beforeTotal)}`)
      }
    }

    if (!args.apply) {
      console.log('')
      console.log('---')
      console.log('以上为 dry-run，未写入任何数据。确认后加 --apply 执行。')
    }
  } finally {
    db.close()
  }
}

main()
