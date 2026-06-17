export interface GateCheckResult {
  allowed: boolean
  needsConfirmation?: boolean
  reason?: string
}

export interface GateOptions {
  deniedTools?: string[]
  confirmationTools?: string[]
  customCheck?: (toolName: string, args: Record<string, unknown>) => Promise<GateCheckResult>
}

/**
 * Gate：工具执行权限检查
 */
export class Gate {
  private readonly deniedTools: Set<string>
  private readonly confirmationTools: Set<string>
  private readonly customCheck?: GateOptions['customCheck']

  constructor(options: GateOptions = {}) {
    this.deniedTools = new Set(options.deniedTools ?? [])
    this.confirmationTools = new Set(options.confirmationTools ?? [])
    this.customCheck = options.customCheck
  }

  async check(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<GateCheckResult> {
    if (this.deniedTools.has(toolName)) {
      return {
        allowed: false,
        needsConfirmation: false,
        reason: `工具 '${toolName}' 被安全策略禁止`,
      }
    }

    if (this.confirmationTools.has(toolName)) {
      return {
        allowed: false,
        needsConfirmation: true,
        reason: `工具 '${toolName}' 需要用户确认`,
      }
    }

    if (this.customCheck) {
      return this.customCheck(toolName, args)
    }

    return { allowed: true }
  }

  /** 获取被禁止的工具列表（用于 Pi SDK excludeTools 参数） */
  getDeniedTools(): string[] {
    return Array.from(this.deniedTools)
  }
}
