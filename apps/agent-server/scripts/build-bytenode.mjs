/**
 * bytenode 构建脚本
 *
 * 流程：
 *   1. esbuild 将 src/index.ts 打成单文件 CJS bundle
 *      - better-sqlite3 标记 external，运行时从 node_modules 解析
 *      - 顶层 await 通过 banner/footer 包进 async IIFE
 *      - import.meta.url 通过 plugin 替换为 CJS 兼容写法
 *   2. bytenode 将 bundle 编译为 V8 字节码 dist/index.jsc
 *   3. esbuild 将 bytenode + loader 逻辑打成自包含的 dist/loader.cjs
 *   4. 复制运行时资源（locales、prompts）到 dist/
 *
 * 产物：
 *   dist/
 *   ├─ index.jsc          # V8 字节码（核心，源码不落盘）
 *   ├─ loader.cjs         # 自包含加载器（内联 bytenode）
 *   ├─ locales/           # i18n 语言文件
 *   └─ prompts/           # 小说插件 prompt 模板
 *
 * 运行时：
 *   node dist/loader.cjs
 *   loader 内部调用内联的 bytenode.runBytecodeFile('index.jsc')
 */

import { build } from 'esbuild'
import bytenode from 'bytenode'
import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const { compileFile } = bytenode

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const DIST = join(ROOT, 'dist')

/** 原生模块：标记 external，运行时从 node_modules 解析 */
const EXTERNALS = ['better-sqlite3']

/** loader 入口源码（会被 esbuild 打包，内联 bytenode） */
const LOADER_ENTRY = `'use strict'
// 自包含 loader：bytenode 被 esbuild 内联
// bytenode 用 vm.Script 运行 .jsc，不注入 CJS 的 __filename/__dirname，
// 通过全局变量传递路径工具，供源码中 import.meta.url 替换使用
const path = require('path')
const url = require('url')
globalThis.__JSC_DIR__ = __dirname
globalThis.__pathToFileURL = url.pathToFileURL
require('bytenode')
try {
  require(path.join(__dirname, 'index.jsc'))
} catch (err) {
  console.error('[loader] 加载 index.jsc 失败:', err)
  process.exit(1)
}
`

/**
 * esbuild plugin：将 import.meta.url 替换为 CJS 兼容写法
 *
 * CJS bundle 中 import.meta 为空对象，import.meta.url 不可用。
 * bytenode 用 vm.Script 运行 .jsc，不注入 __filename，
 * 通过 loader.cjs 设置的 globalThis.__JSC_DIR__ 传递 .jsc 所在目录。
 */
const importMetaUrlPlugin = {
  name: 'import-meta-url-shim',
  setup(build) {
    build.onLoad({ filter: /\.[cm]?[jt]s$/ }, async (args) => {
      const content = await readFile(args.path, 'utf-8')
      // 替换 import.meta.url：用全局变量构造 file URL，避免 require 作用域冲突
      const patched = content.replace(
        /import\.meta\.url/g,
        "globalThis.__pathToFileURL(globalThis.__JSC_DIR__ || process.cwd()).href"
      )
      const loader = args.path.endsWith('.ts') ? 'ts' : 'js'
      return { contents: patched, loader }
    })
  },
}

async function main() {
  console.log('[bytenode] 清理 dist/')
  await rm(DIST, { recursive: true, force: true })
  await mkdir(DIST, { recursive: true })

  // ── Step 1: esbuild bundle → CJS（处理顶层 await + import.meta.url）──
  console.log('[bytenode] esbuild 打包后端 bundle...')
  const bundlePath = join(DIST, 'sea-bundle.cjs')
  await build({
    entryPoints: [join(ROOT, 'src/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['node22'],
    outfile: bundlePath,
    external: EXTERNALS,
    minify: false,
    sourcemap: true,
    sourcesContent: true,
    legalComments: 'none',
    logLevel: 'warning',
    define: {
      'process.env.NODE_ENV': '"production"',
    },
    // 顶层 await 已在 index.ts 中用 async main() 包装，无需 banner/footer
    plugins: [importMetaUrlPlugin],
  })
  console.log('[bytenode] 后端 bundle 完成:', bundlePath)

  // ── Step 2: bytenode 编译 → .jsc ──
  console.log('[bytenode] 编译 V8 字节码...')
  const jscPath = join(DIST, 'index.jsc')
  await compileFile({
    filename: bundlePath,
    output: jscPath,
  })
  console.log('[bytenode] 字节码编译完成:', jscPath)

  // 调试：保留中间 bundle（确认无问题后改回删除）
  // await rm(bundlePath, { force: true })
  console.log('[bytenode] 保留中间 bundle 用于调试:', bundlePath)

  // ── Step 3: esbuild 打包自包含 loader.cjs（内联 bytenode）──
  console.log('[bytenode] 打包自包含 loader...')
  const loaderEntryPath = join(DIST, '_loader-entry.cjs')
  await writeFile(loaderEntryPath, LOADER_ENTRY, 'utf-8')

  const loaderPath = join(DIST, 'loader.cjs')
  await build({
    entryPoints: [loaderEntryPath],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['node22'],
    outfile: loaderPath,
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
  })
  await rm(loaderEntryPath, { force: true })
  console.log('[bytenode] loader 打包完成:', loaderPath)

  // ── Step 4: 复制运行时资源文件 ──
  console.log('[bytenode] 复制运行时资源...')
  const resources = [
    { src: join(ROOT, 'src/core/i18n/locales'), dest: join(DIST, 'locales') },
    { src: join(ROOT, 'src/plugins/novel-plugin/core/prompts'), dest: join(DIST, 'prompts') },
  ]
  for (const { src, dest } of resources) {
    if (existsSync(src)) {
      await cp(src, dest, { recursive: true })
      console.log(`[bytenode] 资源已复制: ${dirname(dest)}`)
    }
  }

  // ── 校验产物 ──
  const jscSize = (await readFile(jscPath)).length
  const loaderSize = (await readFile(loaderPath)).length
  console.log('[bytenode] 构建完成')
  console.log(`  index.jsc:  ${(jscSize / 1024).toFixed(0)} KB`)
  console.log(`  loader.cjs: ${(loaderSize / 1024).toFixed(0)} KB`)
  console.log(`  locales/:   ${existsSync(join(DIST, 'locales')) ? 'OK' : '缺失'}`)
  console.log(`  prompts/:   ${existsSync(join(DIST, 'prompts')) ? 'OK' : '缺失'}`)
}

main().catch((err) => {
  console.error('[bytenode] 构建失败:', err)
  process.exit(1)
})
