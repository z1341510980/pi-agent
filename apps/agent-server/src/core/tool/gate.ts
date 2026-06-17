export interface GateCheckResult {
  allowed: boolean
  reason?: string
}

export interface GateOptions {
  deniedTools?: string[]
  customCheck?: (toolName: string, args: Record<string, unknown>) => Promise<GateCheckResult>
}

/**
 * Gate：工具执行权限检查
 */
export class Gate {
  private readonly deniedTools: Set<string>
  private readonly customCheck?: GateOptions['customCheck']

  constructor(options: GateOptions = {}) {
    this.deniedTools = new Set(options.deniedTools ?? [])
    this.customCheck = options.customCheck
  }

  async check(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<GateCheckResult> {
    if (this.deniedTools.has(toolName)) {
      return {
        allowed: false,
        reason: `工具 '${toolName}' 被安全策略禁止`,
      }
    }

    if (this.customCheck) {
      return this.customCheck(toolName, args)
    }

    return { allowed: true }
  }
}
