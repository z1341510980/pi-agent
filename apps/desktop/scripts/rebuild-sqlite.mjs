/**
 * 在隔离的生产部署目录中重编译 better-sqlite3 匹配 Electron ABI。
 *
 * 开发环境使用系统 Node.js，不能把 Electron ABI 写回 workspace 的
 * node_modules。build:server 会先执行 pnpm deploy，再调用本脚本；因此所有
 * 原生模块变更都限制在 .deploy-tmp 内。
 *
 * 注意：不使用 @electron/rebuild 兜底——它的模块搜索会从 buildPath 上溯到
 * 仓库根 node_modules，把 workspace 里的 better-sqlite3 也换成 Electron ABI
 * （内部走 prebuild 下载，tarball mtime 佐证），直接污染开发环境。
 * prebuild-install 失败时显式报错，给出手动源码编译指引。
 */

import { execFileSync } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync, rmSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = resolve(__dirname, '..')
const AGENT_SERVER_ROOT = resolve(DESKTOP_ROOT, '../agent-server')
const REPO_ROOT = resolve(DESKTOP_ROOT, '../..')
const DEPLOY_ROOT = resolve(REPO_ROOT, '.deploy-tmp')

if (!existsSync(join(DEPLOY_ROOT, 'node_modules'))) {
  throw new Error('未找到 .deploy-tmp/node_modules，请先执行 pnpm --filter desktop build:server')
}

const electronPkg = JSON.parse(
  readFileSync(resolve(DESKTOP_ROOT, 'node_modules/electron/package.json'), 'utf-8')
)
const electronVersion = electronPkg.version
const electronDir = resolve(DESKTOP_ROOT, 'node_modules/electron')
// path.txt 内容是相对 dist/ 的可执行名（如 electron.exe）；
// 与 build-bytenode 的 resolveElectronPath 一致，失败时回退 require('electron')
function resolveElectronPath() {
  const pathTxt = join(electronDir, 'path.txt')
  if (existsSync(pathTxt)) {
    const abs = join(electronDir, 'dist', readFileSync(pathTxt, 'utf-8').trim())
    if (existsSync(abs)) return abs
  }
  return createRequire(join(DESKTOP_ROOT, 'package.json'))('electron')
}
const electronPath = resolveElectronPath()
const deployRequire = createRequire(join(DEPLOY_ROOT, 'package.json'))
const sqliteEntry = deployRequire.resolve('better-sqlite3')
// deploy 顶层是 junction，realpath 到 .pnpm 内真实目录，避免 npx/解析歧义
const sqliteRoot = realpathSync(dirname(dirname(sqliteEntry)))
const nodeFile = resolve(sqliteRoot, 'build/Release/better_sqlite3.node')

console.log(`[rebuild] Electron 版本: ${electronVersion}`)
console.log(`[rebuild] 目标模块: ${sqliteRoot}`)
console.log(`[rebuild] 隔离目录: ${DEPLOY_ROOT}`)

function canLoadWithElectron() {
  if (!existsSync(nodeFile)) {
    console.log('[rebuild] better_sqlite3.node 不存在，视为未编译')
    return false
  }
  try {
    execFileSync(
      electronPath,
      [
        '-e',
        "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.prepare('select 1').get(); db.close()"
      ],
      {
        cwd: DEPLOY_ROOT,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: 'pipe',
        timeout: 30_000
      }
    )
    return true
  } catch (error) {
    console.warn(`[rebuild] Electron 加载校验失败: exit=${error.status ?? 'null'} code=${error.code ?? ''}`)
    const stderr = String(error.stderr ?? '').trim()
    if (stderr) console.warn(`[rebuild] 子进程 stderr: ${stderr}`)
    return false
  }
}

/** 解析 prebuild-install 的 bin 入口：优先 deploy 树内，回退 workspace */
function resolvePrebuildBin() {
  const candidates = [
    () => createRequire(join(sqliteRoot, 'package.json')).resolve('prebuild-install/bin.js'),
    () => createRequire(join(AGENT_SERVER_ROOT, 'package.json')).resolve('prebuild-install/bin.js')
  ]
  for (const tryResolve of candidates) {
    try {
      return tryResolve()
    } catch {
      /* 尝试下一个解析基点 */
    }
  }
  return null
}

function tryPrebuildInstall() {
  console.log('[rebuild] 尝试 prebuild-install 下载 Electron 二进制...')
  const prebuildBin = resolvePrebuildBin()
  if (!prebuildBin) {
    console.warn('[rebuild] 未找到 prebuild-install 可执行入口')
    return false
  }
  try {
    rmSync(nodeFile, { force: true })
    execFileSync(
      process.execPath,
      [prebuildBin, '--runtime', 'electron', '--target', electronVersion, '--arch', process.arch],
      { cwd: sqliteRoot, stdio: 'inherit', timeout: 120_000 }
    )
    console.log(`[rebuild] prebuild-install 退出成功，产物存在: ${existsSync(nodeFile)}`)
    return canLoadWithElectron()
  } catch (error) {
    console.warn('[rebuild] prebuild-install 失败:', error.message)
    return false
  }
}

function main() {
  if (canLoadWithElectron()) {
    console.log('[rebuild] .deploy-tmp 中的 better-sqlite3 已匹配 Electron ABI，跳过重编译')
    return
  }

  if (tryPrebuildInstall()) {
    console.log('[rebuild] better-sqlite3 重编译完成（prebuild-install）')
    return
  }

  throw new Error(
    [
      '[rebuild] prebuild-install 无法为 Electron ' + electronVersion + ' 提供 better-sqlite3 二进制。',
      '可能原因：离线 / 该 Electron 版本无预编译产物。',
      '手动源码编译（需要 Visual Studio Build Tools）：',
      `  cd ${sqliteRoot}`,
      `  npx node-gyp rebuild --release --target ${electronVersion} --arch ${process.arch} --dist-url=https://electronjs.org/headers`
    ].join('\n')
  )
}

try {
  main()
} catch (error) {
  console.error('[rebuild] 重编译失败:', error)
  process.exit(1)
}
