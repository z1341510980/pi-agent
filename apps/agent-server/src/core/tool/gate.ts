import { resolve, isAbsolute, sep } from 'node:path'
import { realpathSync } from 'node:fs'

export type PermissionMode = 'auto' | 'plan' | 'readonly' | 'full'

export type ToolRiskLevel = 'safe' | 'moderate' | 'dangerous'

export interface GateCheckResult {
  allowed: boolean
  needsConfirmation?: boolean
  reason?: string
}

export interface GateOptions {
  /** 权限模式，默认 'auto' */
  mode?: PermissionMode
  /** 显式禁止的工具（优先级最高） */
  deniedTools?: string[]
  /** 显式需要确认的工具 */
  confirmationTools?: string[]
  /** 工作目录白名单根（文件工具的路径必须在此根下） */
  workspace?: string
  /** Agent 数据目录白名单根 */
  agentDir?: string
  /** 用户授权的外部只读路径 */
  externalReadPaths?: string[]
  /** 自定义检查（最后执行，可覆盖默认结果） */
  customCheck?: (toolName: string, args: Record<string, unknown>) => Promise<GateCheckResult>
}

/**
 * 工具风险分级
 * - safe: 只读工具（read, ls, find, grep, memory_search）
 * - moderate: 写工具（write, edit, web_fetch）
 * - dangerous: shell / 删除 / 可能触发 API 费用（bash, web_search）
 */
const RISK_LEVELS: Record<string, ToolRiskLevel> = {
  read: 'safe',
  ls: 'safe',
  find: 'safe',
  grep: 'safe',
  memory_search: 'safe',
  write: 'moderate',
  edit: 'moderate',
  web_fetch: 'moderate',
  bash: 'dangerous',
  shell: 'dangerous',
  delete_file: 'dangerous',
  web_search: 'dangerous',
}

/** 写操作工具集合（read-only 模式下禁止） */
const WRITE_TOOLS = new Set(['write', 'edit', 'bash', 'shell', 'delete_file'])

/** 文件路径参数候选键 */
const PATH_KEYS = ['path', 'filePath', 'file_path', 'filename', 'file']

/**
 * Gate：工具执行权限检查
 *
 * 三档权限模式（参考 ARCHITECTURE.md §11）：
 * - auto: 读自动，写危险操作弹确认，shell 弹确认
 * - plan: 读自动，写/shell 先输出计划再确认
 * - readonly: 读自动，写/shell 全部禁止
 *
 * 路径白名单：文件工具的路径必须在 workspace / agentDir / externalReadPaths 之下。
 */
export class Gate {
  private mode: PermissionMode
  private readonly deniedTools: Set<string>
  private readonly confirmationTools: Set<string>
  private workspace?: string
  private readonly agentDir?: string
  private readonly externalReadPaths: string[]
  private readonly customCheck?: GateOptions['customCheck']

  constructor(options: GateOptions = {}) {
    this.mode = options.mode ?? 'auto'
    this.deniedTools = new Set(options.deniedTools ?? [])
    this.confirmationTools = new Set(options.confirmationTools ?? [])
    this.workspace = options.workspace
    this.agentDir = options.agentDir
    this.externalReadPaths = options.externalReadPaths ?? []
    this.customCheck = options.customCheck
  }

  /** 获取当前权限模式 */
  getMode(): PermissionMode {
    return this.mode
  }

  /** 运行时切换权限模式 */
  setMode(mode: PermissionMode): void {
    this.mode = mode
  }

  /** 获取当前工作区路径 */
  getWorkspace(): string | undefined {
    return this.workspace
  }

  /** 运行时切换工作区路径 */
  setWorkspace(workspace: string): void {
    this.workspace = workspace
  }

  /** 获取工具风险等级 */
  getRiskLevel(toolName: string): ToolRiskLevel {
    return RISK_LEVELS[toolName] ?? 'moderate'
  }

  /** 获取被禁止的工具列表（用于 Pi SDK excludeTools 参数） */
  getDeniedTools(): string[] {
    return Array.from(this.deniedTools)
  }

  async check(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<GateCheckResult> {
    // 1. 显式禁止列表（最高优先级）
    if (this.deniedTools.has(toolName)) {
      return {
        allowed: false,
        needsConfirmation: false,
        reason: `工具 '${toolName}' 被安全策略禁止`,
      }
    }

    // 2. read-only 模式：禁止所有写操作和 shell
    if (this.mode === 'readonly' && WRITE_TOOLS.has(toolName)) {
      return {
        allowed: false,
        needsConfirmation: false,
        reason: `read-only 模式：工具 '${toolName}' 被禁止`,
      }
    }

    // 3. 路径白名单检查（文件工具，所有模式都生效）
    const pathCheck = this.checkPath(toolName, args)
    if (pathCheck && !pathCheck.allowed) {
      return pathCheck
    }

    // 3.5 full 模式：跳过所有确认，直接允许（路径白名单已在上方检查）
    if (this.mode === 'full') {
      return { allowed: true }
    }

    // 4. 显式确认列表
    if (this.confirmationTools.has(toolName)) {
      return {
        allowed: false,
        needsConfirmation: true,
        reason: `工具 '${toolName}' 需要用户确认`,
      }
    }

    // 5. 按权限模式 + 风险分级的默认策略
    const risk = this.getRiskLevel(toolName)
    if (this.mode === 'auto') {
      // auto：dangerous 弹确认
      if (risk === 'dangerous') {
        return {
          allowed: false,
          needsConfirmation: true,
          reason: `工具 '${toolName}' 为危险操作，需要用户确认`,
        }
      }
    } else if (this.mode === 'plan') {
      // plan：moderate 和 dangerous 都弹确认
      if (risk === 'moderate' || risk === 'dangerous') {
        return {
          allowed: false,
          needsConfirmation: true,
          reason: `Plan 模式：工具 '${toolName}' 需要用户确认后执行`,
        }
      }
    }

    // 6. 自定义检查（可覆盖默认结果）
    if (this.customCheck) {
      return this.customCheck(toolName, args)
    }

    return { allowed: true }
  }

  /** 检查文件工具的路径是否在白名单内 */
  private checkPath(
    toolName: string,
    args: Record<string, unknown>,
  ): GateCheckResult | null {
    if (!this.isFileTool(toolName)) return null
    if (!this.workspace && !this.agentDir && this.externalReadPaths.length === 0) {
      return null // 未配置白名单则跳过
    }

    const rawPath = this.extractPath(args)
    if (!rawPath) return null

    const abs = isAbsolute(rawPath) ? rawPath : resolve(this.workspace ?? process.cwd(), rawPath)
    const real = this.safeRealpath(abs)

    const allowedRoots = [
      this.workspace,
      this.agentDir,
      ...this.externalReadPaths,
    ].filter((p): p is string => Boolean(p))

    const inside = allowedRoots.some((root) => {
      const realRoot = this.safeRealpath(root)
      return real === realRoot || real.startsWith(realRoot + sep)
    })

    if (!inside) {
      return {
        allowed: false,
        needsConfirmation: false,
        reason: `路径超出工作区白名单：${rawPath}`,
      }
    }

    // 写工具不能写 externalReadPaths（只读）
    if (WRITE_TOOLS.has(toolName)) {
      const writableRoots = [this.workspace, this.agentDir].filter(
        (p): p is string => Boolean(p),
      )
      const writable = writableRoots.some((root) => {
        const realRoot = this.safeRealpath(root)
        return real === realRoot || real.startsWith(realRoot + sep)
      })
      if (!writable) {
        return {
          allowed: false,
          needsConfirmation: false,
          reason: `写操作不允许在外部只读路径：${rawPath}`,
        }
      }
    }

    return { allowed: true }
  }

  private isFileTool(toolName: string): boolean {
    return ['read', 'write', 'edit', 'ls', 'find', 'grep'].includes(toolName)
  }

  private extractPath(args: Record<string, unknown>): string | undefined {
    for (const key of PATH_KEYS) {
      const value = args[key]
      if (typeof value === 'string' && value.length > 0) {
        return value
      }
    }
    return undefined
  }

  private safeRealpath(p: string): string {
    try {
      return realpathSync(p)
    } catch {
      return resolve(p)
    }
  }
}
