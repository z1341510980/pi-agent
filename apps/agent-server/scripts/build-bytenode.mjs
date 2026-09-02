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
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const { compileElectronCode } = bytenode
const require = createRequire(import.meta.url)
const Module = require('node:module')
const moduleWrap = Module.wrap

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const DIST = join(ROOT, 'dist')

// ── 定位 Electron 可执行文件路径（与 rebuild-sqlite.mjs 一致）──
// bytenode .jsc 必须用 Electron 的 V8 编译，否则运行时 cachedDataRejected
// 系统 Node.js v24 V8 13.6 ≠ Electron v22 V8 14.2-electron.0
const DESKTOP_ROOT = resolve(ROOT, '../desktop')
function resolveElectronPath() {
  const electronPkgPath = resolve(DESKTOP_ROOT, 'node_modules/electron/path.txt')
  if (existsSync(electronPkgPath)) {
    const relPath = readFileSync(electronPkgPath, 'utf-8').trim()
    const absPath = resolve(DESKTOP_ROOT, 'node_modules/electron', relPath)
    if (existsSync(absPath)) return absPath
  }
  // 回退：直接从 electron 模块 require（返回可执行文件路径）
  try {
    return require(resolve(DESKTOP_ROOT, 'node_modules/electron'))
  } catch {
    throw new Error('无法定位 Electron 可执行文件，请在 apps/desktop 下先执行 pnpm install')
  }
}

/** 原生模块：标记 external，运行时从 node_modules 解析 */
const EXTERNALS = ['better-sqlite3']

/** loader 入口源码（会被 esbuild 打包，内联 bytenode） */
const LOADER_ENTRY = `'use strict'
// 自包含 loader：bytenode 被 esbuild 内联
//
// bytenode 默认的 .jsc handler 用 vm.Script.runInThisContext() 运行字节码，
// 但 vm.Script 不支持 import() 动态导入（报 ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING）。
//
// 解决方案：在构建时把 bundle 中的 dynamic import() 调用 patch 为
// Promise.resolve(require())（见 Step 1.5），这样 .jsc 中不再有 import() 调用。
//
// 这里覆盖 Module._extensions['.jsc']，复用 bytenode 的 fixBytecode/compileCode
// 逻辑修复 bytecode header，并注入 CJS 的 require/exports/module 等。
//
// 另：bytenode 用 vm.Script 运行 .jsc，不注入 CJS 的 __filename/__dirname，
// 通过全局变量传递 .jsc 文件路径，供源码中 import.meta.url 替换使用。
// 源码用 dirname(fileURLToPath(import.meta.url)) 取所在目录，
// 所以这里传文件路径而非目录，dirname 后正好是 dist/。
const path = require('path')
const fs = require('fs')
const vm = require('vm')
const Module = require('module')
const url = require('url')
const bytenode = require('bytenode')

const jscFile = path.join(__dirname, 'index.jsc')
globalThis.__JSC_FILE__ = jscFile
globalThis.__pathToFileURL = url.pathToFileURL

// ── 复用 bytenode 的 bytecode 修复逻辑（bytenode 未导出 fixBytecode/generateScript）──
const MAGIC_NUMBER = Buffer.from([0xde, 0xc0])
const ZERO_LENGTH_EXT_REF = Buffer.alloc(2)

function isBufferV8Bytecode(buf) {
  return Buffer.isBuffer(buf) &&
    !buf.subarray(0, 2).equals(ZERO_LENGTH_EXT_REF) &&
    buf.subarray(2, 4).equals(MAGIC_NUMBER)
}

// 复制 bytenode fixBytecode 的 Node>=12 分支：仅 patch flag hash (offset 12-16)
function fixBytecode(buf) {
  const dummy = bytenode.compileCode('"\\u0ca0_\\u0ca0"')
  dummy.subarray(12, 16).copy(buf, 12)
}

function readSourceHash(buf) {
  return buf.subarray(8, 12).reduce((sum, n, p) => sum + n * Math.pow(256, p), 0)
}

function generateScript(cachedData, filename) {
  if (!isBufferV8Bytecode(cachedData)) {
    const { brotliDecompressSync } = require('zlib')
    cachedData = brotliDecompressSync(cachedData)
  }
  fixBytecode(cachedData)
  const length = readSourceHash(cachedData)
  let dummyCode = ''
  if (length > 1) {
    dummyCode = '"' + '\\u200b'.repeat(length - 2) + '"'
  }
  const script = new vm.Script(dummyCode, { cachedData, filename })
  if (script.cachedDataRejected) {
    throw new Error('Invalid or incompatible cached data (cachedDataRejected)')
  }
  return script
}

// 覆盖 bytenode 注册的 .jsc handler，注入 CJS 运行时（require/exports/module 等）
Module._extensions['.jsc'] = function (fileModule, filename) {
  const bytecodeBuffer = fs.readFileSync(filename)
  const script = generateScript(bytecodeBuffer, filename)

  function require(id) { return fileModule.require(id) }
  require.resolve = function (request, options) {
    return Module._resolveFilename(request, fileModule, false, options)
  }
  if (process.main) require.main = process.main
  require.extensions = Module._extensions
  require.cache = Module._cache

  const compiledWrapper = script.runInThisContext({
    filename: filename,
    lineOffset: 0,
    columnOffset: 0,
    displayErrors: true,
  })

  const dirname = path.dirname(filename)
  const args = [fileModule.exports, require, fileModule, filename, dirname, process, global]
  return compiledWrapper.apply(fileModule.exports, args)
}

try {
  require(jscFile)
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
      // 源码用 dirname(fileURLToPath(import.meta.url)) 取目录，
      // 所以传 .jsc 文件路径，dirname 后正好是 dist/
      const patched = content.replace(
        /import\.meta\.url/g,
        "globalThis.__pathToFileURL(globalThis.__JSC_FILE__ || __filename || process.cwd()).href"
      )
      const loader = args.path.endsWith('.ts') ? 'ts' : 'js'
      return { contents: patched, loader }
    })
  },
}

/**
 * 把 bundle 中的 dynamic import() 调用转换为 Promise.resolve(require())
 *
 * 原因：bytenode 用 vm.Script 运行 .jsc 字节码，vm.Script 不支持 import()
 * 动态导入（报 ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING）。
 * 后端依赖（如 codex SDK、gaxios）中有通过变量传递的 import(specifier) 调用，
 * esbuild 无法静态分析，会保留运行时 import()。
 *
 * 这里在 bundle 输出后做一次词法级扫描替换，精确处理真正的 import() 调用，
 * 同时正确跳过：字符串、模板字面量、注释、正则字面量，
 * 并排除方法调用 obj.import() 和方法定义 import() {}。
 *
 * 关键改进（相比初版）：增加了正则字面量 /regex/ 的识别。
 * minified 代码是单行，正则字面量中的 / 会干扰除法/正则的判断，
 * 导致扫描器把正则内容误判为代码，从而漏识别或误识别 import()。
 * 通过跟踪前一个有意义字符 + 关键字判断，区分 / 是除法还是正则开始。
 */
function patchDynamicImports(code) {
  const isIdent = (ch) => ch !== undefined && /[A-Za-z0-9_$]/.test(ch)

  // 这些关键字后跟 / 时，/ 是正则开始（而非除法）
  const KEYWORDS_BEFORE_REGEX = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'do', 'else',
    'delete', 'void', 'new', 'yield', 'await', 'throw', 'case',
  ])

  function consumeString(start, quote) {
    let i = start + 1
    while (i < code.length) {
      if (code[i] === '\\') { i += 2; continue }
      if (code[i] === quote) return i + 1
      i++
    }
    return i
  }

  // 跳过模板字面量：从 ` 开始，到匹配的 ` 结束
  // 关键：必须正确处理 ${...} 表达式——表达式内的 ` 是嵌套模板的开始而非外层结束，
  // 表达式内的 } 在花括号深度归零时才结束表达式。
  // 不处理 ${} 内的正则字面量（边缘情况，实际 bundle 中极少出现 /}/g 这种）。
  function consumeTemplate(start) {
    let i = start + 1
    while (i < code.length) {
      const ch = code[i]
      if (ch === '\\') { i += 2; continue }
      if (ch === '`') return i + 1
      if (ch === '$' && code[i + 1] === '{') {
        // 进入 ${...} 表达式，追踪花括号深度
        i += 2
        let depth = 1
        while (i < code.length && depth > 0) {
          const c = code[i]
          if (c === '\\') { i += 2; continue }
          if (c === '"' || c === "'") { i = consumeString(i, c); continue }
          if (c === '`') { i = consumeTemplate(i); continue }
          if (c === '/' && code[i + 1] === '*') {
            const e = code.indexOf('*/', i + 2); i = e === -1 ? code.length : e + 2; continue
          }
          if (c === '/' && code[i + 1] === '/') {
            const e = code.indexOf('\n', i); i = e === -1 ? code.length : e + 1; continue
          }
          if (c === '{') depth++
          else if (c === '}') depth--
          i++
        }
        continue
      }
      i++
    }
    return i
  }

  // 跳过正则字面量：从 / 开始，到匹配的 / 结束（含 flag），处理转义和字符类 [...]
  function consumeRegex(start) {
    let i = start + 1
    let inClass = false
    while (i < code.length) {
      const ch = code[i]
      if (ch === '\\') { i += 2; continue }
      if (ch === '[') { inClass = true; i++; continue }
      if (ch === ']') { inClass = false; i++; continue }
      if (ch === '/' && !inClass) {
        i++
        while (i < code.length && /[gimsuyd]/.test(code[i])) i++
        return i
      }
      if (ch === '\n') return i + 1
      i++
    }
    return i
  }

  // 从 end 往前回溯，取完整的标识符词（用于判断是否关键字）
  function getPrevWord(end) {
    let s = end - 1
    while (s >= 0 && isIdent(code[s])) s--
    return s + 1 < end ? code.slice(s + 1, end) : null
  }

  let out = ''
  let i = 0
  let count = 0
  const n = code.length
  let prevSignificant = '' // 前一个有意义字符（非空白）

  while (i < n) {
    const ch = code[i]

    // 块注释 /* ... */
    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      out += code.slice(i, stop)
      i = stop
      prevSignificant = '*'
      continue
    }
    // 行注释 // ...
    if (ch === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i)
      const stop = end === -1 ? n : end + 1
      out += code.slice(i, stop)
      i = stop
      prevSignificant = '/'
      continue
    }
    // 字符串
    if (ch === '"' || ch === "'") {
      const stop = consumeString(i, ch)
      out += code.slice(i, stop)
      i = stop
      prevSignificant = ch
      continue
    }
    // 模板字面量
    if (ch === '`') {
      const stop = consumeTemplate(i)
      out += code.slice(i, stop)
      i = stop
      prevSignificant = '`'
      continue
    }
    // 正则字面量 vs 除法：根据前一个有意义字符判断
    if (ch === '/') {
      let isRegex = false
      if (prevSignificant === '') {
        isRegex = true
      } else if (')]}'.includes(prevSignificant)) {
        isRegex = false // 闭合括号后是除法
      } else if (isIdent(prevSignificant)) {
        // 标识符字符：可能是普通标识符（除法）或关键字（正则）
        const word = getPrevWord(i)
        isRegex = !!(word && KEYWORDS_BEFORE_REGEX.has(word))
      } else {
        isRegex = true // 运算符/标点后是正则
      }

      if (isRegex) {
        const stop = consumeRegex(i)
        out += code.slice(i, stop)
        i = stop
        prevSignificant = '/'
        continue
      }
      // 除法，当作普通字符
      out += ch
      i++
      prevSignificant = ch
      continue
    }

    // 识别 import 标识符（前后不能是标识符字符，排除 importX、ximport）
    if (
      ch === 'i' &&
      code.slice(i, i + 6) === 'import' &&
      !isIdent(code[i - 1]) &&
      !isIdent(code[i + 6])
    ) {
      // 前一个非空白字符：若是 '.' 则为方法调用（obj.import()），跳过
      const isMethodCall = prevSignificant === '.'

      // import 后是否紧跟 '('（跳过空白）
      let j = i + 6
      while (j < n && /\s/.test(code[j])) j++
      const isCall = code[j] === '('

      if (!isMethodCall && isCall) {
        // 匹配配对括号（跳过字符串/模板/注释/正则）
        let depth = 1
        let k = j + 1
        while (k < n && depth > 0) {
          const c = code[k]
          if (c === '"' || c === "'") {
            k = consumeString(k, c)
            continue
          }
          if (c === '`') {
            k = consumeTemplate(k)
            continue
          }
          if (c === '/' && code[k + 1] === '*') {
            const e = code.indexOf('*/', k + 2)
            k = e === -1 ? n : e + 2
            continue
          }
          if (c === '/' && code[k + 1] === '/') {
            const e = code.indexOf('\n', k)
            k = e === -1 ? n : e + 1
            continue
          }
          if (c === '(') depth++
          else if (c === ')') depth--
          k++
        }
        // k 是 ')' 的下一位；参数区为 code.slice(j+1, k-1)
        const argText = code.slice(j + 1, k - 1)

        // 检查 ')' 后第一个非空白字符：若是 '{' 则为方法定义（import() {}），跳过
        let next = k
        while (next < n && /\s/.test(code[next])) next++
        const isMethodDef = code[next] === '{'

        if (!isMethodDef) {
          // 真正的 dynamic import() 调用 → 替换为 Promise.resolve(require(...))
          out += `Promise.resolve(require(${argText}))`
          i = k
          count++
          prevSignificant = ')'
          continue
        }
        // 方法定义，原样输出
        out += code.slice(i, k)
        i = k
        prevSignificant = ')'
        continue
      }
      // 非 import() 调用（如 import 声明语句），原样输出 import
      out += ch
      i++
      if (!/\s/.test(ch)) prevSignificant = ch
      continue
    }

    out += ch
    i++
    if (!/\s/.test(ch)) prevSignificant = ch
  }

  return { code: out, count }
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
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
    define: {
      'process.env.NODE_ENV': '"production"',
    },
    // 顶层 await 已在 index.ts 中用 async main() 包装，无需 banner/footer
    plugins: [importMetaUrlPlugin],
  })
  console.log('[bytenode] 后端 bundle 完成:', bundlePath)

  // ── Step 1.5: patch dynamic import() → Promise.resolve(require()) ──
  // bytenode 用 vm.Script 运行 .jsc，不支持 import() 动态导入，
  // 需把 bundle 中的 import() 调用转为 require（目标都是 CJS 模块：node: 内置、external 依赖）
  console.log('[bytenode] patch dynamic import()...')
  const bundleRaw = await readFile(bundlePath, 'utf8')
  const { code: patched, count: patchCount } = patchDynamicImports(bundleRaw)
  await writeFile(bundlePath, patched, 'utf8')
  console.log(`[bytenode] 已替换 ${patchCount} 处 dynamic import() → require()`)
  if (patchCount === 0) {
    console.warn('[bytenode] 警告: 未发现 dynamic import()，可能无需 patch（请确认）')
  }

  // ── Step 2: bytenode 编译 → .jsc（用 Electron 的 V8 编译）──
  // 关键：.jsc 运行时用 ELECTRON_RUN_AS_NODE 复用 Electron 内置 Node，
  // 必须用相同 V8 编译，否则 cachedDataRejected
  // 系统 Node.js v24 V8 13.6 ≠ Electron v22 V8 14.2-electron.0
  //
  // compileElectronCode 不会自动 Module.wrap（它用 cli.js --no-module），
  // 而 loader.cjs 的 .jsc handler 会用 c.apply(exports, [exports, require, module, ...])，
  // 因此这里手动 Module.wrap，与 compileFile(compileAsModule=true) 行为一致
  const electronPath = resolveElectronPath()
  console.log('[bytenode] 使用 Electron 编译 V8 字节码:', electronPath)
  const jscPath = join(DIST, 'index.jsc')
  const bundleSource = await readFile(bundlePath, 'utf8')
  const wrappedSource = moduleWrap(bundleSource)
  const jscBuffer = await compileElectronCode(wrappedSource, { electronPath })
  await writeFile(jscPath, jscBuffer)
  console.log('[bytenode] 字节码编译完成:', jscPath)

  // 删除中间 bundle（源码不落盘，仅保留 .jsc 字节码）
  await rm(bundlePath, { force: true })

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
