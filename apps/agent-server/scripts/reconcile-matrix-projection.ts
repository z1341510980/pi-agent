/**
 * 矩阵投影对账脚本（S4-1，只读）。
 *
 * 用途：在把矩阵切换为"从事件账本派生"之前，量化账本与实体章节维度字段的差异。
 * 差异归零（或差异都被解释清楚）之后才谈得上 S4-2 的切读。
 *
 * 用法：
 *   pnpm --filter agent-server exec tsx scripts/reconcile-matrix-projection.ts --db <path>
 *   pnpm --filter agent-server exec tsx scripts/reconcile-matrix-projection.ts --db <path> --project <id>
 *   pnpm --filter agent-server exec tsx scripts/reconcile-matrix-projection.ts --db <path> --json
 *
 * 参数：
 *   --db <path>       SQLite 库路径（默认 ~/.pi/wenlang-agent.db）
 *   --project <id>    只对账指定项目（默认全部有章节的项目）
 *   --json            输出 JSON 而非可读文本
 *   --max-rows <n>    每类差异最多列出几条（默认 40）
 *
 * 安全性：以 readonly 打开数据库，不执行迁移，不写任何一行。
 */
import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { NovelStore } from '../src/plugins/novel-plugin/core/novel-store.js'
import { NovelMemoryStore } from '../src/plugins/novel-plugin/core/novel-memory-store.js'
import {
  reconcileMatrixProjection,
  formatReconcileReport,
  type ReconcileReport,
} from '../src/plugins/novel-plugin/core/matrix-projection.js'

interface Args {
  db: string
  project?: string
  json: boolean
  maxRows: number
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    db: join(homedir(), '.pi', 'wenlang-agent.db'),
    json: false,
    maxRows: 40,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--db') args.db = argv[++i]
    else if (flag === '--project') args.project = argv[++i]
    else if (flag === '--json') args.json = true
    else if (flag === '--max-rows') args.maxRows = Number(argv[++i]) || 40
    else if (flag === '--help' || flag === '-h') {
      console.log('见文件头注释：--db / --project / --json / --max-rows')
      process.exit(0)
    } else {
      console.error(`未知参数：${flag}`)
      process.exit(2)
    }
  }
  return args
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(args.db)) {
    console.error(`数据库不存在：${args.db}`)
    process.exit(2)
  }

  // readonly：对账是纯读操作，绝不能因为脚本跑一次就改动用户数据
  const db = new Database(args.db, { readonly: true })
  try {
    const store = new NovelStore(db)
    const memoryStore = new NovelMemoryStore(db)

    const projects = db
      // deleted_at IS NULL：与 NovelStore.getProject 的口径一致，跳过软删除项目
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

    const reports: ReconcileReport[] = targets.map((p) => reconcileMatrixProjection(store, memoryStore, p.id))

    if (args.json) {
      console.log(JSON.stringify(reports, null, 2))
    } else {
      console.log(`# 矩阵投影对账\n\n数据库：${args.db}\n项目数：${reports.length}`)
      for (const report of reports) {
        console.log('')
        console.log(formatReconcileReport(report, { maxRows: args.maxRows }))
      }
      console.log('')
      console.log('---')
      console.log('说明：')
      console.log('- "账本缺记录"＝实体字段说这章有它，但账本没有对应变化/事件。')
      console.log('  典型来源：手工编辑实体字段、早期 ai-arrange 不写账本、Memory 阶段漏写。')
      console.log('- "投影缺记录"＝账本说这章动过它，但实体的章节维度字段没体现。')
      console.log('  典型来源：账本写了变化但没同步 chapterSpans/beats/appearChapters。')
      console.log('- "悬空引用"＝账本指向已被删除的实体，补投影无从下手，需清理账本或恢复实体。')
      console.log('- 一致率达到可接受水平后，才能进入 S4-2：把矩阵读路径切到账本。')
    }

    const worst = Math.min(...reports.map((r) => {
      const total = r.matchedCount + r.missingInLedger.length
        + r.missingInEntityFields.length + r.danglingRefs.length
      return total === 0 ? 100 : (r.matchedCount / total) * 100
    }))
    // 退出码只表达"是否存在差异"，供 CI 或人工快速判断，不代表失败
    process.exitCode = worst >= 100 ? 0 : 1
  } finally {
    db.close()
  }
}

main()
