/**
 * 存量投影回填脚本（S4-1b）。
 *
 * 把"实体字段有、账本无"的历史投影补写进事件账本，为 S4-2 切读做准备。
 *
 * ## 默认只做 dry-run
 *
 *   pnpm --filter agent-server backfill:ledger --db <path>            # 只出清单，不写库
 *   pnpm --filter agent-server backfill:ledger --db <path> --apply    # 真正写入
 *
 * 参数：
 *   --db <path>       SQLite 库路径（默认 ~/.pi/wenlang-agent.db）
 *   --project <id>    只回填指定项目（默认全部有章节的项目）
 *   --apply           执行写入（不加则只打印清单）
 *   --max-rows <n>    清单最多列出几条（默认 60）
 *
 * ## 安全性
 *
 * - 不加 --apply 时以 readonly 打开数据库，物理上无法写入。
 * - 写入是幂等的（记录器按 (subject, chapter, dimension) 去重），重复跑不会翻倍。
 * - 只新增账本记录；不修改任何实体字段，不删除任何已有记录。
 * - 事件标题为「存量投影回填」，与实时写入区分，需要回滚时可按标题定位。
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
  planLedgerBackfill,
  applyLedgerBackfill,
  formatBackfillPlan,
} from '../src/plugins/novel-plugin/core/ledger-backfill.js'
import { reconcileMatrixProjection } from '../src/plugins/novel-plugin/core/matrix-projection.js'

interface Args {
  db: string
  project?: string
  apply: boolean
  maxRows: number
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    db: join(homedir(), '.pi', 'wenlang-agent.db'),
    apply: false,
    maxRows: 60,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--db') args.db = argv[++i]
    else if (flag === '--project') args.project = argv[++i]
    else if (flag === '--apply') args.apply = true
    else if (flag === '--max-rows') args.maxRows = Number(argv[++i]) || 60
    else if (flag === '--help' || flag === '-h') {
      console.log('见文件头注释：--db / --project / --apply / --max-rows')
      process.exit(0)
    } else {
      console.error(`未知参数：${flag}`)
      process.exit(2)
    }
  }
  return args
}

function agreementOf(matched: number, total: number): string {
  return total === 0 ? '100%' : `${Math.round((matched / total) * 1000) / 10}%`
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(args.db)) {
    console.error(`数据库不存在：${args.db}`)
    process.exit(2)
  }

  // 不加 --apply 时以 readonly 打开：让"忘记加 flag"物理上不可能写坏数据
  const db = new Database(args.db, { readonly: !args.apply })
  try {
    const store = new NovelStore(db)
    const memoryStore = new NovelMemoryStore(db)

    const projects = db
      .prepare('SELECT id, title FROM novel_projects WHERE deleted_at IS NULL ORDER BY created_at')
      .all() as Array<{ id: string; title: string }>

    const targets = args.project
      ? projects.filter((p) => p.id === args.project)
      : projects.filter((p) => {
        const count = db
          .prepare('SELECT COUNT(*) c FROM novel_chapters WHERE project_id = ?')
          .get(p.id) as { c: number }
        return count.c > 0
      })

    if (targets.length === 0) {
      console.error(args.project ? `未找到项目：${args.project}` : '没有包含章节的项目')
      process.exit(1)
    }

    console.log(`# 存量投影回填${args.apply ? '（写入模式）' : '（dry-run，未写入）'}`)
    console.log('')
    console.log(`数据库：${args.db}`)
    console.log(`项目数：${targets.length}`)

    for (const target of targets) {
      const before = reconcileMatrixProjection(store, memoryStore, target.id)
      const beforeTotal = before.matchedCount + before.missingInLedger.length
        + before.missingInEntityFields.length + before.danglingRefs.length

      console.log('')
      if (args.apply) {
        const result = applyLedgerBackfill(store, memoryStore, target.id)
        console.log(formatBackfillPlan(result, { maxRows: args.maxRows, applied: true }))
        const after = reconcileMatrixProjection(store, memoryStore, target.id)
        const afterTotal = after.matchedCount + after.missingInLedger.length
          + after.missingInEntityFields.length + after.danglingRefs.length
        console.log('')
        console.log(`一致率：${agreementOf(before.matchedCount, beforeTotal)} → ${agreementOf(after.matchedCount, afterTotal)}`)
        console.log(`账本缺记录：${before.missingInLedger.length} → ${after.missingInLedger.length}`)
      } else {
        console.log(formatBackfillPlan(planLedgerBackfill(store, memoryStore, target.id), { maxRows: args.maxRows }))
        console.log('')
        console.log(`当前一致率：${agreementOf(before.matchedCount, beforeTotal)}`)
      }
    }

    if (!args.apply) {
      console.log('')
      console.log('---')
      console.log('以上为 dry-run，未写入任何数据。确认清单无误后加 --apply 执行。')
      console.log('建议先备份（WAL 库不能用 Copy-Item）：sqlite3 <db> "VACUUM INTO \'<db>.bak\'"')
    }
  } finally {
    db.close()
  }
}

main()
