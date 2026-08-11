/**
 * novel-migration-tools 共享数据库打开工具。
 *
 * 默认数据路径：~/.pi/wenlang-agent.db（PI_DATA_DIR 可覆盖），与 e2e db-verify 一致。
 */
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'

export function resolveDbPath() {
  const dataDir = process.env.PI_DATA_DIR ?? join(homedir(), '.pi')
  return join(dataDir, 'wenlang-agent.db')
}

/**
 * 打开数据库。
 * @param opts.readonly 只读（默认 true）；清理类脚本传 false
 */
export function openDb({ readonly = true } = {}) {
  const dbPath = resolveDbPath()
  return new Database(dbPath, { readonly, fileMustExist: true })
}

/** 输出目录：scripts/novel-migration-tools/output/ */
export function outputDir() {
  // ⚠️ 必须用 fileURLToPath 而不是 new URL(...).pathname：
  // Windows 下 pathname 是 "/D:/..." POSIX 风格，join 后产生 "D:\D:\..." 双盘符导致 ENOENT。
  const dir = fileURLToPath(new URL('../output/', import.meta.url))
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 写 JSON 报告到 output/ */
export function writeJsonReport(filename, payload) {
  const file = join(outputDir(), filename)
  writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
  return file
}

/** sha256（规范化后）——与 core 层 hashChapterContent 口径一致 */
export function hashChapterContent(content) {
  return createHash('sha256').update(String(content).replace(/\s+/g, ' ').trim()).digest('hex')
}
