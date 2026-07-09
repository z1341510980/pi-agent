/**
 * 重编译 better-sqlite3 匹配 Electron ABI
 *
 * better-sqlite3 是 agent-server 的依赖（原生 .node 模块），
 * 默认编译为系统 Node ABI。生产模式用 ELECTRON_RUN_AS_NODE 复用
 * Electron 内置 Node，ABI 不匹配会报 Module version mismatch。
 *
 * 本脚本调用 @electron/rebuild，只重编译 better-sqlite3，
 * 不影响其他依赖。需在 build:bytenode 之前执行。
 *
 * 用法：node scripts/rebuild-sqlite.mjs
 */

import { rebuild } from '@electron/rebuild'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = resolve(__dirname, '..')
const AGENT_SERVER_ROOT = resolve(DESKTOP_ROOT, '../agent-server')

// 从 desktop package.json 读取 electron 版本
const desktopPkg = JSON.parse(
  readFileSync(resolve(DESKTOP_ROOT, 'package.json'), 'utf-8')
)
const electronVersion = desktopPkg.devDependencies.electron
if (!electronVersion) {
  throw new Error('desktop package.json 未找到 electron 版本')
}
// 去掉 ^ 前缀
const version = electronVersion.replace(/^[\^~]/, '')

console.log(`[rebuild] Electron 版本: ${version}`)
console.log(`[rebuild] 目标模块: better-sqlite3`)
console.log(`[rebuild] 模块路径: ${AGENT_SERVER_ROOT}`)

try {
  await rebuild({
    buildPath: AGENT_SERVER_ROOT,
    electronVersion: version,
    arch: process.arch,
    onlyModules: ['better-sqlite3'],
    // 强制重新编译，不用缓存
    force: true,
  })
  console.log('[rebuild] better-sqlite3 重编译完成')
} catch (err) {
  console.error('[rebuild] 重编译失败:', err)
  process.exit(1)
}
