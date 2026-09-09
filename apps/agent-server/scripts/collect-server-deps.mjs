/**
 * 收集后端运行时依赖到 dist/node_modules
 *
 * 配合 build-bytenode 的 externals.json（自动探测的路径敏感包清单）：
 * 这些包以真实文件树随包发布（bundle 会摊平 __dirname，破坏包内相对路径）。
 * 本脚本（主路径，pnpm deploy 产物存在时）：
 *   1. 修剪 .deploy-tmp/node_modules（*.map/*.d.ts/*.md/tests 等运行时无用文件）
 *   2. 闭包平铺真实复制到 dist/node_modules（见 deployed 分支内注释；
 *      deploy 树的 junction 是指向 .deploy-tmp 的绝对目标，不能 rename/直接
 *      复制，产物必须零链接自包含）
 *   3. better-sqlite3 等原生模块以 Electron ABI 重编译产物放置为顶层真实文件
 *      （rebuild:sqlite 在 deploy 树内完成，执行顺序：deploy → rebuild:sqlite
 *      → build:bytenode → collect-deps；workspace 保持系统 Node ABI 不被污染）
 * 无 deploy 产物时回退：闭包收集 + .pnpm 忠实复制。
 */

import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, dirname, relative, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const REPO_ROOT = resolve(ROOT, '../..')
const DIST = join(ROOT, 'dist')
const DEPS_DIR = join(DIST, 'node_modules')

const require = createRequire(join(ROOT, 'package.json'))

/** 从 deploy 根解析包入口（走 deploy 顶层 junction） */
function deployRequireResolve(deployTarget, name) {
  const req = createRequire(join(deployTarget, 'package.json'))
  return req.resolve(name)
}

/**
 * 解析依赖入口：裸名命中 Node 内置模块时（如 tr46 的 punycode——运行时
 * require('punycode/') 带尾斜线强制 npm 包），同样加尾斜线重试，
 * 否则该包会被漏收集、打包后 loader 启动即 MODULE_NOT_FOUND。
 */
function resolveDepEntry(req, dep) {
  const resolved = req.resolve(dep)
  if (resolved === dep) return req.resolve(`${dep}/`)
  return resolved
}

/**
 * 平铺真实复制：包目录 → dest，跳过链接与包内 node_modules 子目录
 * （pnpm 布局中包的依赖在 .pnpm 兄弟位置，不在包内；闭包已平铺到顶层）
 */
function copyDirFlat(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    if (entry.name === 'node_modules') continue
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    if (entry.isDirectory()) copyDirFlat(srcPath, destPath)
    else cpSync(srcPath, destPath)
  }
}



/** Electron ABI 覆盖的原生模块（rebuild:sqlite 产物） */
const NATIVE_OVERLAYS = ['better-sqlite3', 'bindings', 'file-uri-to-path']

/** 已收集的包（避免重复；版本冲突时记录告警） */
const collected = new Map()

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
 * 递归收集包及其运行时依赖闭包。
 * 顶层包的真实目录直接来自 build-bytenode 的探测结果（externals.json），
 * 无需解析；子依赖用每个包自己的 package.json 解析（pnpm 结构正确）。
 * 闭包跟随 dependencies + peerDependencies + optionalDependencies：
 * flat 布局下 peer 不会被提升，必须显式随包。
 *
 * 关键：Windows pnpm 顶层是 junction，require.resolve 返回的是 junction
 * 路径（agent-server/node_modules/<pkg>），必须 realpathSync 解析到
 * .pnpm/<hash>/node_modules/<pkg> 真实位置，否则 .pnpm 布局判断全部失效。
 */
async function collectPackage(name, pkgDir) {
  if (collected.has(name)) return
  try {
    if (pkgDir) pkgDir = realpathSync(pkgDir)
  } catch {
    /* 解析失败的目录走下面统一校验 */
  }
  if (!pkgDir || !existsSync(join(pkgDir, 'package.json'))) {
    console.warn(`[collect] 无法定位 ${name} 的真实目录，跳过`)
    return
  }
  collected.set(name, pkgDir)

  const pkgJson = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8'))
  console.log(`[collect] 闭包: ${name} v${pkgJson.version}`)

  const childRequire = createRequire(join(pkgDir, 'package.json'))
  const deps = [
    ...Object.keys(pkgJson.dependencies || {}),
    ...Object.keys(pkgJson.peerDependencies || {}).filter((dep) => !dep.startsWith('@types/')),
    ...Object.keys(pkgJson.optionalDependencies || {})
  ]
  for (const depName of deps) {
    if (depName === 'prebuild-install' || depName.startsWith('@types/')) continue
    if (collected.has(depName)) continue
    try {
      const entryPath = childRequire.resolve(depName)
      let dir = dirname(realpathSync(entryPath))
      while (dir !== dirname(dir) && !existsSync(join(dir, 'package.json'))) dir = dirname(dir)
      await collectPackage(depName, dir)
    } catch (err) {
      console.warn(`[collect] 无法解析 ${name} 的依赖 ${depName}: ${err.message}`)
    }
  }
}

function countFiles(dir) {
  let files = 0
  let bytes = 0
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const p = join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(p)
      else {
        files += 1
        bytes += statSync(p).size
      }
    }
  }
  walk(dir)
  return { files, bytes: bytes / (1024 * 1024) }
}

/** 修剪运行时用不到的文件：*.map、*.d.ts、*.md（保留 LICENSE）、tests、.bin、TS 源码 */
function pruneTree(dir) {
  const PRUNE_DIRS = new Set(['.bin', '.github', '__tests__', 'tests', 'test', 'coverage', 'docs'])
  let removed = 0
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const p = join(current, entry.name)
      if (entry.isDirectory()) {
        if (PRUNE_DIRS.has(entry.name)) {
          rmSync(p, { recursive: true, force: true })
          continue
        }
        walk(p)
        continue
      }
      const name = entry.name
      const isMap = name.endsWith('.map')
      const isDts = name.endsWith('.d.ts') || name.endsWith('.d.mts') || name.endsWith('.d.cts')
      const isMd = name.endsWith('.md') && !name.startsWith('LICENSE')
      const isTsSource = name.endsWith('.ts')
      if (isMap || isDts || isMd || isTsSource) {
        rmSync(p, { force: true })
        removed += 1
      }
    }
  }
  walk(dir)
  return removed
}

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    // 符号链接（pnpm 的依赖/peer 链接，目标是相对路径）：重建为 junction，
    // 相对布局随 .pnpm 整体复制后天然有效。绝不跟随，避免循环复制卡死。
    if (entry.isSymbolicLink()) {
      const target = readlinkSync(srcPath)
      try {
        symlinkSync(target, destPath, 'junction')
      } catch {
        /* 已存在等情况忽略 */
      }
      continue
    }
    if (entry.isDirectory()) copyDir(srcPath, destPath)
    else cpSync(srcPath, destPath)
  }
}

/**
 * 闭包平铺收集：只复制运行时真正被 require 的依赖闭包为真实文件。
 *
 * 体积考量：整棵 deploy 树 553 包 / 2 万+ 文件，Windows 上逐文件复制过慢
 * 且解引用 junction 产生大量重复；闭包仅 56 包 / 约 30MB。
 *
 * 布局规则：
 *   - 首个版本平铺到 dist/node_modules/<name>（node 解析走目录上溯，天然可达）
 *   - 同名不同版本（如 real-require 双版本）嵌套到需要它的父包
 *     node_modules 下，与 npm flat 布局语义一致
 *   - 原生三件套由第 3 步统一放置（Electron ABI）
 *
 * 解析基点是 deploy 树（junction 有效）；解析失败的依赖（如 punycode 在
 * deploy 树缺失）回退 workspace 同名 .pnpm 位置——纯 JS 包无 ABI 之分。
 */

/** 包真实目录 → 所属 .pnpm/<hash> 目录（布局：.pnpm/<hash>/node_modules/<pkg>） */
function hashDirOf(pkgDir) {
  const nodeModules = dirname(pkgDir) // .pnpm/<hash>/node_modules
  if (basename(nodeModules) !== 'node_modules') return null
  const hashDir = dirname(nodeModules) // .pnpm/<hash>
  if (basename(dirname(hashDir)) !== '.pnpm') return null
  return hashDir
}

async function main() {
  const externalsFile = join(DIST, 'externals.json')
  let entries = []
  if (existsSync(externalsFile)) {
    entries = JSON.parse(readFileSync(externalsFile, 'utf8'))
  } else {
    console.warn('[collect] 警告: dist/externals.json 不存在，回退到默认清单（请先跑 build:bytenode）')
    entries = [{ name: 'better-sqlite3', dir: resolvePackageDir('better-sqlite3') }]
  }
  console.log(`[collect] externals 清单: ${entries.map((entry) => entry.name).join(', ')}`)

  console.log('[collect] 清理 dist/node_modules/')
  rmSync(DEPS_DIR, { recursive: true, force: true })
  mkdirSync(DEPS_DIR, { recursive: true })

  // deploy 由 pnpm 编排在 build:server 里完成（desktop/package.json），
  // 产物位于 <repo>/.deploy-tmp（放在包目录外，避免 pnpm 依赖状态检查误判）；
  //   本脚本负责修剪、物化复制、原生模块覆盖。
  // 若 .deploy-tmp 不存在则回退到闭包收集 + .pnpm 忠实复制。
  const deployTarget = join(REPO_ROOT, '.deploy-tmp')
  const deployedNodeModules = join(deployTarget, 'node_modules')
  const deployed = existsSync(deployedNodeModules)
  if (deployed) {
    console.log('[collect] 检测到 pnpm deploy 产物，修剪并启用...')
    const removed = pruneTree(deployedNodeModules)
    const pruned = countFiles(deployedNodeModules)
    console.log(`[collect] 已删除 ${removed} 个文件；剩余 ${pruned.files} 个 / ${pruned.bytes.toFixed(1)}MB`)
  }

  if (!deployed) {
    // 回退路径：闭包收集 + .pnpm 忠实复制（保留 junction，多版本共存）
    for (const entry of entries) {
      await collectPackage(entry.name, entry.dir)
    }
    const hashDirs = new Map()
    const copiedPkgDirs = []
    for (const [name, pkgDir] of collected) {
      const hash = hashDirOf(pkgDir)
      if (!hash) {
        const dest = join(DEPS_DIR, name)
        console.log(`[collect] flat 复制 ${name} ← ${relative(REPO_ROOT, pkgDir)}`)
        rmSync(dest, { recursive: true, force: true })
        copyDir(pkgDir, dest)
        copiedPkgDirs.push(dest)
        continue
      }
      const hashName = basename(hash)
      hashDirs.set(hashName, hash)
      copiedPkgDirs.push(join(DEPS_DIR, '.pnpm', hashName, 'node_modules', basename(pkgDir)))
    }
    console.log(`[collect] 复制 ${hashDirs.size} 个 .pnpm 目录...`)
    for (const [hashName, hash] of hashDirs) {
      copyDir(hash, join(DEPS_DIR, '.pnpm', hashName))
    }
    for (const [name, pkgDir] of collected) {
      const hash = hashDirOf(pkgDir)
      if (!hash) continue
      const linkPath = join(DEPS_DIR, name)
      if (existsSync(linkPath)) continue
      const relTarget = relative(DEPS_DIR, join(hash, 'node_modules', name))
      try {
        symlinkSync(relTarget, linkPath, 'junction')
      } catch {
        /* 已存在等情况忽略 */
      }
    }
    let removedTotal = 0
    for (const copied of copiedPkgDirs) {
      if (existsSync(copied)) removedTotal += pruneTree(copied)
    }
    console.log(`[collect] 闭包键: ${[...collected.keys()].join(', ')}`)
  }

  if (deployed) {
    // ── 主路径：闭包平铺真实复制（见函数头注释）──
    const WS_NM = join(REPO_ROOT, 'node_modules')
    const toDeployPath = (wsDir) => {
      const rel = relative(WS_NM, wsDir)
      if (rel.startsWith('..')) return null
      const mapped = join(deployedNodeModules, rel)
      return existsSync(mapped) ? mapped : null
    }
    const toWorkspacePath = (deployDir) => {
      const rel = relative(deployedNodeModules, deployDir)
      if (rel.startsWith('..')) return null
      const mapped = join(WS_NM, rel)
      return existsSync(mapped) ? mapped : null
    }

    /** 入口文件 → 向上找包根（package.json 所在目录） */
    const pkgRootOf = (entryPath) => {
      let dir = dirname(realpathSync(entryPath))
      while (dir !== dirname(dir) && !existsSync(join(dir, 'package.json'))) dir = dirname(dir)
      return dir
    }

    const NATIVE_TRIO = ['better-sqlite3', 'bindings', 'file-uri-to-path']
    const placement = new Map() // name → { dir, dest }（首个版本，顶层）
    const conflictPlacements = [] // { name, dir, dest }（嵌套版本）
    const walkedDirs = new Set()
    const queue = [] // { name, dir, dest }

    const visit = (parent, name, dir) => {
      if (NATIVE_TRIO.includes(name)) return
      const existing = placement.get(name)
      if (existing) {
        if (existing.dir !== dir) {
          const dest = join(parent.dest, 'node_modules', name)
          if (!conflictPlacements.some((item) => item.dir === dir)) {
            conflictPlacements.push({ name, dir, dest })
            if (!walkedDirs.has(dir)) {
              walkedDirs.add(dir)
              queue.push({ name, dir, dest })
            }
            console.warn(`[collect] 版本冲突: ${name} 嵌套到 ${parent.name} 下`)
          }
        }
        return
      }
      const dest = join(DEPS_DIR, name)
      placement.set(name, { dir, dest })
      if (!walkedDirs.has(dir)) {
        walkedDirs.add(dir)
        queue.push({ name, dir, dest })
      }
    }

    // 种子：externals 清单（workspace .pnpm 路径映射到 deploy 树等价位置）
    const rootParent = { name: '<root>', dest: DEPS_DIR }
    for (const entry of entries) {
      if (NATIVE_TRIO.includes(entry.name)) continue
      let dir = entry.dir ? toDeployPath(entry.dir) : null
      if (!dir) {
        try {
          dir = pkgRootOf(deployRequireResolve(deployTarget, entry.name))
        } catch {
          /* 走下面统一告警 */
        }
      }
      if (!dir) {
        console.warn(`[collect] 警告: ${entry.name} 无法在 deploy 树定位`)
        continue
      }
      visit(rootParent, entry.name, dir)
    }

    // 闭包遍历（BFS）
    while (queue.length) {
      const item = queue.shift()
      const pkg = JSON.parse(readFileSync(join(item.dir, 'package.json'), 'utf-8'))
      const deps = [
        ...Object.keys(pkg.dependencies || {}),
        ...Object.keys(pkg.peerDependencies || {}).filter((dep) => !dep.startsWith('@types/')),
        ...Object.keys(pkg.optionalDependencies || {})
      ]
      const req = createRequire(join(item.dir, 'package.json'))
      for (const dep of deps) {
        if (dep === 'prebuild-install' || dep.startsWith('@types/')) continue
        let dir = null
        try {
          dir = pkgRootOf(resolveDepEntry(req, dep))
        } catch {
          // deploy 树缺失 → 回退 workspace 等价位置解析
          const wsDir = toWorkspacePath(item.dir)
          if (wsDir) {
            try {
              const wsReq = createRequire(join(wsDir, 'package.json'))
              dir = pkgRootOf(resolveDepEntry(wsReq, dep))
            } catch {
              /* 可选依赖未安装等，正常 */
            }
          }
        }
        if (!dir) {
          console.warn(`[collect] ${item.name} 的依赖 ${dep} 无法解析（可能为未安装的可选依赖）`)
          continue
        }
        visit(item, dep, dir)
      }
    }

    console.log(
      `[collect] 闭包：顶层 ${placement.size} 包 + 嵌套 ${conflictPlacements.length} 包，开始平铺复制...`
    )
    for (const { dir, dest } of placement.values()) {
      copyDirFlat(dir, dest)
    }
    for (const { dir, dest } of conflictPlacements) {
      copyDirFlat(dir, dest)
    }

    // 原生三件套：从 deploy 树解析（rebuild:sqlite 已写入 Electron ABI 的
    // .node，workspace 保持系统 Node ABI 不被污染），交给第 3 步放置。
    try {
      const entryPath = deployRequireResolve(deployTarget, 'better-sqlite3')
      let dir = dirname(realpathSync(entryPath))
      while (dir !== dirname(dir) && !existsSync(join(dir, 'package.json'))) dir = dirname(dir)
      collected.set('better-sqlite3', dir)
      const bsqliteRequire = createRequire(join(dir, 'package.json'))
      for (const name of ['bindings', 'file-uri-to-path']) {
        try {
          let depDir = dirname(realpathSync(bsqliteRequire.resolve(name)))
          while (depDir !== dirname(depDir) && !existsSync(join(depDir, 'package.json'))) {
            depDir = dirname(depDir)
          }
          collected.set(name, depDir)
        } catch (err) {
          console.warn(`[collect] 无法解析 ${name}: ${err.message}`)
        }
      }
    } catch (err) {
      console.warn(`[collect] 无法从 deploy 树解析 better-sqlite3: ${err.message}`)
    }
  }

  // 3. 原生模块三件套放置为顶层真实文件：从 deploy 树（Electron ABI .node
  //    所在，rebuild:sqlite 产物）复制，跳过包内 node_modules 软链。
  const NATIVE_REAL = ['better-sqlite3', 'bindings', 'file-uri-to-path']
  for (const name of NATIVE_REAL) {
    const realDir = collected.get(name)
    if (!realDir) {
      console.warn(`[collect] 警告: ${name} 不在闭包中，跳过真实复制`)
      continue
    }
    const dest = join(DEPS_DIR, name)
    rmSync(dest, { recursive: true, force: true })
    copyDirFlat(realDir, dest)
  }

  // 4. （仅回退路径有意义）external 里其余的 transitive 包不在顶层：
  //    补建顶层 junction 指向 .pnpm 内真实目录，否则 index.jsc 的 require 失败。
  //    主路径（deploy 闭包平铺）无 .pnpm 目录，本段自动跳过。
  const pnDir = join(DEPS_DIR, '.pnpm')
  if (existsSync(pnDir)) {
    for (const entry of entries) {
      const top = join(DEPS_DIR, entry.name)
      if (existsSync(top)) continue
      if (NATIVE_REAL.includes(entry.name)) continue
      const [scope, short] = entry.name.includes('/')
        ? [entry.name.split('/')[0], entry.name.split('/')[1]]
        : [null, entry.name]
      const prefix = scope ? `${scope}+${short}@` : `${short}@`
      const hit = readdirSync(pnDir).find((d) => d.startsWith(prefix))
      if (!hit) {
        console.warn(`[collect] 警告: .pnpm 内未找到 ${entry.name}`)
        continue
      }
      const target = join(pnDir, hit, 'node_modules', entry.name)
      if (!existsSync(target)) {
        console.warn(`[collect] 警告: ${entry.name} 的 .pnpm 目录缺少入口文件`)
        continue
      }
      const rel = relative(DEPS_DIR, target)
      try {
        symlinkSync(rel, top, 'junction')
        console.log(`[collect] 补链 ${entry.name} → .pnpm/${hit}`)
      } catch {
        /* 已存在等情况忽略 */
      }
    }
  }

  // 闭包复制完成后清理 deploy 树（第 3 步已从中取完原生三件套真实目录）
  if (deployed) {
    rmSync(deployTarget, { recursive: true, force: true })
  }

  const after = countFiles(DEPS_DIR)
  console.log(`[collect] 完成：${after.files} 个文件 / ${after.bytes.toFixed(1)}MB`)
  writeFileSync(join(DIST, 'node_modules-count.txt'), `${after.files} files / ${after.bytes.toFixed(1)}MB\n`, 'utf8')
}

main().catch((err) => {
  console.error('[collect] 收集失败:', err)
  process.exit(1)
})
