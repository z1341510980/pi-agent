/**
 * 插件包完整性校验（研究文档 §6.3 / §9）
 *
 * 产品边界：插件代码只在服务启动/重启阶段装载；安装侧负责锁定版本与完整性，
 * 加载侧负责在 import 之前校验。未经校验的代码不因为"已经在 node_modules 里"
 * 就被信任。
 *
 * 锁定格式（写入 plugins.yml 的 catalog 条目）：
 *
 *   - id: my-plugin
 *     source: npm
 *     sourceRef: wenlang-agent-plugin-my
 *     resolvedVersion: "1.2.3"                  # 必须与 package.json 的 version 一致
 *     integrity: sha256-BASE64_DIGEST           # SRI 格式，覆盖包目录全部文件
 *
 * 目录摘要的构造是确定性的：遍历包目录下所有普通文件（跳过 node_modules 与 .git），
 * 按 POSIX 相对路径排序，对每个文件取 `relPath \0 sha256(content) \0` 拼接后再做
 * sha256。任何文件的内容、增删或改名都会改变摘要。
 *
 * @module core/plugin/plugin-integrity
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * 唯一支持的摘要算法。
 *
 * 目录摘要固定用 sha256 构造（computePackageIntegrity），因此解析层也只接受
 * sha256——放行 sha384/sha512 只会得到"格式合法但永远校验失败"的锁，
 * 不如在解析处就明确拒绝。将来若要升级算法，改这里与 computePackageIntegrity 两处。
 */
const INTEGRITY_ALGORITHM = 'sha256'

/** 计算目录摘要时跳过的目录名 */
const SKIPPED_DIRS = new Set(['node_modules', '.git'])

/** 解析后的 SRI 完整性声明 */
export interface ParsedIntegrity {
  algorithm: string
  digest: Buffer
}

/**
 * 解析 SRI 格式的完整性声明（`sha256-<base64>`）。
 *
 * 只接受 sha256：这是目录摘要实际使用的算法。sha384/sha512 语法上像 SRI，
 * 但本实现无法产生对应摘要，接受它们等于埋一个永久失败的配置。
 *
 * @returns null 表示格式非法或算法不受支持 —— 调用方必须拒绝加载，
 *          不能当作"没有声明"处理
 */
export function parseIntegritySri(sri: string): ParsedIntegrity | null {
  const match = /^([a-z0-9]+)-([A-Za-z0-9+/]+={0,2})$/.exec(sri.trim())
  if (!match) return null
  if (match[1] !== INTEGRITY_ALGORITHM) return null
  return { algorithm: match[1], digest: Buffer.from(match[2], 'base64') }
}

interface CollectedFile {
  /** POSIX 风格相对路径，作为排序键 */
  relPath: string
  absolutePath: string
}

function collectFiles(packageDir: string, current: string, out: CollectedFile[]): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolutePath = join(current, entry.name)
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue
      collectFiles(packageDir, absolutePath, out)
      continue
    }
    if (!entry.isFile()) continue
    const relPath = relative(packageDir, absolutePath).split(sep).join('/')
    out.push({ relPath, absolutePath })
  }
}

export interface PackageIntegrity {
  /** SRI 格式：`sha256-<base64>` */
  sri: string
  /** 参与摘要的文件数 */
  fileCount: number
}

/**
 * 计算一个插件包目录的确定性完整性摘要。
 *
 * 同一内容两次计算结果一致；任何文件被改动、新增或删除都会得到不同摘要。
 */
export function computePackageIntegrity(packageDir: string): PackageIntegrity {
  const files: CollectedFile[] = []
  collectFiles(packageDir, packageDir, files)
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))

  const hash = createHash('sha256')
  for (const file of files) {
    const contentHash = createHash('sha256').update(readFileSync(file.absolutePath)).digest('hex')
    hash.update(`${file.relPath}\0${contentHash}\0`)
  }
  return { sri: `sha256-${hash.digest('base64')}`, fileCount: files.length }
}

export interface IntegrityCheckResult {
  ok: boolean
  /** 失败原因；ok 时为 undefined */
  reason?: string
  /** 实际计算的摘要（失败时用于诊断展示） */
  computedSri?: string
  /** package.json 中实际声明的 version（读取失败时为 undefined） */
  actualVersion?: string
  /** 参与摘要的文件数 */
  fileCount?: number
}

export interface VerifyPackageOptions {
  /** 插件包根目录（npm 为包目录；local 为入口文件所在目录） */
  packageDir: string
  /** plugins.yml 里锁定的完整性声明；缺省时跳过摘要校验 */
  integrity?: string
  /** 锁定的版本号；提供时与 package.json 的 version 精确比对 */
  resolvedVersion?: string
}

/**
 * 在 import 之前校验插件包。
 *
 * 校验规则：
 * - `integrity` 声明格式非法 → 直接失败（写错的锁不能静默降级为"未锁定"）
 * - `integrity` 存在 → 与实际目录摘要比对
 * - `resolvedVersion` 存在 → 与 package.json 的 version 精确比对；
 *   package.json 缺失或不可读视为失败
 */
export function verifyPackageIntegrity(options: VerifyPackageOptions): IntegrityCheckResult {
  const { packageDir } = options

  let actualVersion: string | undefined
  const pkgJsonPath = join(packageDir, 'package.json')
  try {
    if (statSync(pkgJsonPath).isFile()) {
      const parsed = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as { version?: unknown }
      if (typeof parsed.version === 'string') actualVersion = parsed.version
    }
  } catch {
    // package.json 存在但损坏：如果需要版本校验，下面会失败
  }

  if (options.resolvedVersion !== undefined) {
    if (actualVersion === undefined) {
      return { ok: false, reason: `无法读取 package.json 的 version，期望 ${options.resolvedVersion}` }
    }
    if (actualVersion !== options.resolvedVersion) {
      return {
        ok: false,
        reason: `版本不匹配：锁定 ${options.resolvedVersion}，实际 ${actualVersion}`,
        actualVersion
      }
    }
  }

  let computedSri: string | undefined
  let fileCount: number | undefined
  if (options.integrity !== undefined) {
    const expected = parseIntegritySri(options.integrity)
    if (!expected) {
      return {
        ok: false,
        reason: `integrity 声明格式非法（应为 ${INTEGRITY_ALGORITHM}-<base64>）: ${options.integrity}`
      }
    }
    const computed = computePackageIntegrity(packageDir)
    computedSri = computed.sri
    fileCount = computed.fileCount
    const actual = Buffer.from(computed.sri.slice(computed.sri.indexOf('-') + 1), 'base64')
    // 算法已由 parseIntegritySri 收敛为 INTEGRITY_ALGORITHM，此处只比摘要。
    const matches =
      actual.length === expected.digest.length && timingSafeEqual(actual, expected.digest)
    if (!matches) {
      return {
        ok: false,
        reason: `完整性校验失败：锁定 ${options.integrity}，实际 ${computed.sri}`,
        computedSri,
        fileCount
      }
    }
  }

  return { ok: true, computedSri, actualVersion, fileCount }
}

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}
