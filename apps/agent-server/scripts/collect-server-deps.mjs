/**
 * 收集后端运行时依赖到 dist/node_modules
 *
 * esbuild bundle 时将 better-sqlite3 标记为 external（原生模块不能打包），
 * 运行时 loader.cjs require('better-sqlite3') 需要能从 dist/node_modules 解析。
 *
 * 本脚本：
 *   1. 通过 require.resolve 找到包的实际路径（兼容 pnpm workspace）
 *   2. 递归收集包及其运行时 dependencies
 *   3. 复制 package.json + 主入口 + build/（含 .node）+ lib/
 *
 * 注意：.node 文件的 ABI 必须匹配 Electron 内置 Node。
 *      由 desktop 的 electron-rebuild 步骤负责重编译，本脚本只负责收集。
 *      执行顺序：electron-rebuild → build:bytenode → collect-deps
 */

import { createRequire } from 'node:module'
import { copyFile, mkdir, readFile, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const DIST = join(ROOT, 'dist')
const DEPS_DIR = join(DIST, 'node_modules')

const require = createRequire(join(ROOT, 'package.json'))

/** 顶层需要收集的外置依赖 */
const TOP_LEVEL_EXTERNALS = ['better-sqlite3']

/** 已收集的包（避免重复） */
const collected = new Set()

/**
 * 递归复制目录
 */
async function copyDir(src, dest) {
  await mkdir(dest, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath)
    } else {
      await copyFile(srcPath, destPath)
    }
  }
}

/**
 * 解析包根目录：用给定的 require 函数解析入口，向上找含 package.json 的目录
 */
function resolvePackageDir(name, fromRequire) {
  const req = fromRequire || require
  const entryPath = req.resolve(name)
  let pkgDir = dirname(entryPath)
  while (pkgDir !== dirname(pkgDir)) {
    if (existsSync(join(pkgDir, 'package.json'))) break
    pkgDir = dirname(pkgDir)
  }
  return pkgDir
}

/**
 * 收集单个包及其运行时依赖（递归）
 * @param name 包名
 * @param fromRequire 用于解析依赖的 require 函数（基于父包的 package.json）
 */
async function collectPackage(name, fromRequire) {
  if (collected.has(name)) return
  collected.add(name)

  let pkgDir
  try {
    pkgDir = resolvePackageDir(name, fromRequire)
  } catch (err) {
    console.warn(`[collect] 无法解析 ${name}: ${err.message}`)
    return
  }

  const pkgJson = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf-8'))
  console.log(`[collect] ${name} v${pkgJson.version} ← ${relative(ROOT, pkgDir) || '.'}`)

  const destDir = join(DEPS_DIR, name)
  await rm(destDir, { recursive: true, force: true })

  // 复制 package.json
  await mkdir(destDir, { recursive: true })
  await copyFile(join(pkgDir, 'package.json'), join(destDir, 'package.json'))

  // 复制主入口
  if (pkgJson.main) {
    const src = join(pkgDir, pkgJson.main)
    if (existsSync(src)) {
      const dest = join(destDir, pkgJson.main)
      await mkdir(dirname(dest), { recursive: true })
      await copyFile(src, dest)
    }
  }

  // 复制 lib/（better-sqlite3 的实现）
  const libDir = join(pkgDir, 'lib')
  if (existsSync(libDir)) {
    await copyDir(libDir, join(destDir, 'lib'))
  }

  // 复制 build/（含 .node 二进制）
  const buildDir = join(pkgDir, 'build')
  if (existsSync(buildDir)) {
    await copyDir(buildDir, join(destDir, 'build'))
  }

  // 复制 prebuilds/（部分包用预编译二进制）
  const prebuildsDir = join(pkgDir, 'prebuilds')
  if (existsSync(prebuildsDir)) {
    await copyDir(prebuildsDir, join(destDir, 'prebuilds'))
  }

  // 递归收集运行时 dependencies
  // 用当前包的 package.json 创建 require，正确解析 pnpm 依赖结构
  const childRequire = createRequire(join(pkgDir, 'package.json'))
  const deps = pkgJson.dependencies || {}
  for (const depName of Object.keys(deps)) {
    // 跳过 prebuild-install（仅安装时用，运行时不需要）
    if (depName === 'prebuild-install') continue
    await collectPackage(depName, childRequire)
  }
}

async function main() {
  console.log('[collect] 清理 dist/node_modules/')
  await rm(DEPS_DIR, { recursive: true, force: true })
  await mkdir(DEPS_DIR, { recursive: true })

  for (const name of TOP_LEVEL_EXTERNALS) {
    await collectPackage(name, require)
  }

  console.log(`[collect] 完成，共收集 ${collected.size} 个包`)
}

main().catch((err) => {
  console.error('[collect] 收集失败:', err)
  process.exit(1)
})
