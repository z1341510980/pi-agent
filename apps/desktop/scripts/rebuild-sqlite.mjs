/**
 * 重编译 better-sqlite3 匹配 Electron ABI
 *
 * better-sqlite3 是 agent-server 的依赖（原生 .node 模块），
 * 默认编译为系统 Node ABI。生产模式用 ELECTRON_RUN_AS_NODE 复用
 * Electron 内置 Node，ABI 不匹配会报 Module version mismatch。
 *
 * 优先使用 prebuild-install 下载预编译二进制（无需 Visual Studio），
 * 失败时回退到 @electron/rebuild 从源码编译。
 *
 * 用法：node scripts/rebuild-sqlite.mjs
 */

import { execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'
import { rebuild } from '@electron/rebuild'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = resolve(__dirname, '..')
const AGENT_SERVER_ROOT = resolve(DESKTOP_ROOT, '../agent-server')

// 读取实际安装的 Electron 版本（而非 package.json 中的 ^x.y.z）
const electronPkg = JSON.parse(
  readFileSync(resolve(DESKTOP_ROOT, 'node_modules/electron/package.json'), 'utf-8')
)
const version = electronPkg.version

console.log(`[rebuild] Electron 版本: ${version}`)
console.log(`[rebuild] 目标模块: better-sqlite3`)

// better-sqlite3 在 pnpm 中的实际路径
const bsqPkgDir = resolve(AGENT_SERVER_ROOT, '../../node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3')
const bsqDir = existsSync(bsqPkgDir) ? bsqPkgDir : resolve(AGENT_SERVER_ROOT, 'node_modules/better-sqlite3')
console.log(`[rebuild] 模块路径: ${bsqDir}`)

// ── 策略 1: prebuild-install 下载预编译二进制（无需 Visual Studio）──
function tryPrebuildInstall() {
  // 如果 .node 文件已存在（之前已下载），跳过下载
  const nodeFile = resolve(bsqDir, 'build/Release/better_sqlite3.node')
  if (existsSync(nodeFile)) {
    console.log('[rebuild] better_sqlite3.node 已存在，跳过下载:', nodeFile)
    return true
  }
  console.log('[rebuild] 尝试 prebuild-install 下载预编译二进制...')
  try {
    execSync(
      `npx prebuild-install --runtime electron --target ${version} --arch ${process.arch}`,
      { cwd: bsqDir, stdio: 'inherit', timeout: 120000 }
    )
    if (existsSync(nodeFile)) {
      console.log('[rebuild] prebuild-install 成功:', nodeFile)
      return true
    }
    console.warn('[rebuild] prebuild-install 未生成 .node 文件')
    return false
  } catch (err) {
    console.warn('[rebuild] prebuild-install 失败:', err.message)
    return false
  }
}

// ── 策略 2: @electron/rebuild 从源码编译（需要 Visual Studio）──
async function tryElectronRebuild() {
  console.log('[rebuild] 尝试 @electron/rebuild 从源码编译...')
  await rebuild({
    buildPath: AGENT_SERVER_ROOT,
    electronVersion: version,
    arch: process.arch,
    onlyModules: ['better-sqlite3'],
    force: true,
  })
}

async function main() {
  try {
    if (tryPrebuildInstall()) {
      console.log('[rebuild] better-sqlite3 重编译完成（prebuild-install）')
    } else {
      await tryElectronRebuild()
      console.log('[rebuild] better-sqlite3 重编译完成（源码编译）')
    }
  } catch (err) {
    console.error('[rebuild] 重编译失败:', err)
    process.exit(1)
  }
}

main()
