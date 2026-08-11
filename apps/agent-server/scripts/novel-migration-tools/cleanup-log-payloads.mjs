/**
 * cleanup-log-payloads.mjs — P1-2 按保留策略清理过期 payload（默认 dry-run）。
 *
 * 只删 novel_agent_log_payloads 中 expires_at 已过期的行，**元数据不删**。
 * 定时调度由部署侧 cron/env 决定，本脚本供手动触发。
 *
 * 用法：
 *   node scripts/novel-migration-tools/cleanup-log-payloads.mjs [--apply]
 *
 * --apply 才真正删除；缺省只统计（dry-run）。
 */
import { openDb } from './lib/db.mjs'

const apply = process.argv.includes('--apply')
const db = openDb({ readonly: !apply })
try {
  const nowTs = Math.floor(Date.now() / 1000)
  const expired = db.prepare(
    'SELECT COUNT(*) AS n FROM novel_agent_log_payloads WHERE expires_at IS NOT NULL AND expires_at <= ?',
  ).get(nowTs).n
  const total = db.prepare('SELECT COUNT(*) AS n FROM novel_agent_log_payloads').get().n

  if (!apply) {
    console.log(`[dry-run] 过期 payload=${expired}，总量=${total}（加 --apply 执行删除）`)
    process.exit(0)
  }

  const result = db.prepare(
    'DELETE FROM novel_agent_log_payloads WHERE expires_at IS NOT NULL AND expires_at <= ?',
  ).run(nowTs)
  console.log(`[apply] 删除过期 payload=${result.changes}，剩余=${total - result.changes}（元数据未动）`)
  process.exit(0)
} finally {
  db.close()
}
