/**
 * Policy Hook Manager
 *
 * 管理 Hook 配置，在工具调用前后执行 Hook 并合并结果。
 * 与 Gate/Confirmation 协同工作。
 *
 * @module core/policy/policy-hook-manager
 */

import type {
  CommandHook,
  HookExecutionContext,
  HookExecutionResult,
  MergedHookOutcome
} from './hook-types.js'
import { runHook, mergeHookOutputs, parseHookOutput } from './policy-hook-runner.js'

/**
 * Hook 类型
 */
export type HookPoint = 'PreToolUse' | 'PostToolUse' | 'SessionStart' | 'UserPromptSubmit' | 'Stop'

/**
 * 单个 Hook 定义（从配置加载）
 */
export interface HookDefinition {
  /** 钩子点 */
  point: HookPoint
  /** 命令 */
  command: string
  /** 显式 argv 参数（无 shell 执行时优先于命令分词） */
  args?: string[]
  /** 超时（秒） */
  timeoutSec?: number
  /** 匹配器（正则或精确匹配） */
  matcher?: string | RegExp
  /** 是否启用 */
  enabled: boolean
  /** 显式要求 shell 求值；仅在 manager 被声明为 trusted 时生效 */
  shell?: boolean
}

/**
 * Hook 执行的宿主安全策略。
 *
 * 默认值是最保守的一组：无 shell、只继承环境变量白名单、输出有上限。
 * 宿主要放开任何一项都必须显式声明，避免"配置没写就等于放开"。
 */
export interface PolicyHookSecurityOptions {
  /** 配置来源是否受信；false 时忽略 hook.shell 且不继承完整环境变量 */
  trusted?: boolean
  /** 非受信配置可继承的环境变量白名单 */
  envAllowlist?: string[]
  /** stdout/stderr 各自的字节上限 */
  maxOutputBytes?: number
  /** Hook 子进程的工作目录；未提供时不向子进程指定 cwd */
  cwd?: string
}

/**
 * Hook 执行结果（含元数据）
 */
export interface HookExecutionSummary {
  /** 钩子点 */
  point: HookPoint
  /** 执行的命令 */
  command: string
  /** 执行耗时 */
  durationMs: number
  /** 合并后的结果 */
  outcome: MergedHookOutcome
  /** 原始输出列表（调试用） */
  rawOutputs?: HookExecutionResult[]
}

/**
 * Policy Hook Manager
 *
 * 负责：
 * 1. 存储 Hook 配置与宿主安全策略
 * 2. 根据 Hook 点匹配和执行 Hook
 * 3. 合并多个 Hook 结果
 * 4. 提供决策给调用方
 */
export class PolicyHookManager {
  private hooks: HookDefinition[] = []
  private security: PolicyHookSecurityOptions

  constructor(security: PolicyHookSecurityOptions = {}) {
    this.security = security
  }

  /**
   * 设置 Hook 配置
   */
  setHooks(hooks: HookDefinition[]): void {
    this.hooks = hooks.filter((h) => h.enabled)
  }

  /** 设置宿主安全策略（受信声明、环境白名单、输出上限、cwd） */
  setSecurity(security: PolicyHookSecurityOptions): void {
    this.security = security
  }

  /** 当前生效的安全策略（供诊断和 API 投影使用） */
  getSecurity(): Readonly<PolicyHookSecurityOptions> {
    return this.security
  }

  /**
   * 获取某个 Hook 点的所有匹配 Hook
   */
  private getMatchingHooks(point: HookPoint, context?: { toolName?: string }): HookDefinition[] {
    return this.hooks.filter((hook) => {
      if (hook.point !== point) return false
      if (!hook.matcher) return true // 无匹配器，匹配所有
      const toolName = context?.toolName ?? ''
      if (typeof hook.matcher === 'string') {
        // 兼容 `a|b` 精确候选集及普通正则；文档中的 matcher 语义二选一
        // 对纯候选集优先按完整 token 匹配，避免 `bash-extra` 误命中 `bash`。
        const candidates = hook.matcher
          .split('|')
          .map((item) => item.trim())
          .filter(Boolean)
        if (candidates.length > 1 && candidates.every((item) => /^[A-Za-z0-9_-]+$/.test(item))) {
          return candidates.includes(toolName)
        }
        try {
          return new RegExp(hook.matcher).test(toolName)
        } catch {
          return hook.matcher === toolName
        }
      }
      hook.matcher.lastIndex = 0
      return hook.matcher.test(toolName)
    })
  }

  /**
   * 执行指定 Hook 点的所有匹配 Hook
   */
  async executeHooks(
    point: HookPoint,
    payload: unknown,
    signal: AbortSignal,
    context?: { toolName?: string; cwd?: string; env?: Record<string, string> }
  ): Promise<HookExecutionSummary> {
    const matched = this.getMatchingHooks(point, context)
    if (matched.length === 0) {
      return {
        point,
        command: 'none',
        durationMs: 0,
        outcome: {
          decision: 'none',
          stop: false,
          additionalContext: [],
          systemMessages: []
        },
        rawOutputs: []
      }
    }

    const results: HookExecutionResult[] = []
    for (const hook of matched) {
      const execContext: HookExecutionContext = {
        eventName: point,
        payload,
        signal,
        timeoutMs: hook.timeoutSec ? hook.timeoutSec * 1000 : undefined,
        // cwd 只取宿主策略或调用方显式值；不回落到 process.cwd()，
        // 避免 Hook 默认拿到整个仓库工作目录。
        cwd: context?.cwd ?? this.security.cwd,
        env: context?.env,
        expectedEventName: point,
        trailingNewline: true,
        trusted: this.security.trusted === true,
        ...(this.security.envAllowlist ? { envAllowlist: this.security.envAllowlist } : {}),
        ...(this.security.maxOutputBytes !== undefined
          ? { maxOutputBytes: this.security.maxOutputBytes }
          : {})
      }
      const result = await runHook(
        {
          command: hook.command,
          ...(hook.args ? { args: hook.args } : {}),
          timeoutSec: hook.timeoutSec,
          ...(hook.shell !== undefined ? { shell: hook.shell } : {})
        },
        execContext
      )
      results.push(result)
    }

    const outputs = results.map((r) => r.output)
    const outcome = mergeHookOutputs(outputs)

    return {
      point,
      command: matched.map((h) => h.command).join(', '),
      durationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
      outcome,
      rawOutputs: results
    }
  }

  /**
   * 执行 PreToolUse Hook
   */
  async runPreToolUseHooks(
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<HookExecutionSummary> {
    return this.executeHooks(
      'PreToolUse',
      { hookEventName: 'PreToolUse', toolName, args },
      signal,
      { toolName }
    )
  }

  /**
   * 执行 PostToolUse Hook
   */
  async runPostToolUseHooks(
    toolName: string,
    result: unknown,
    signal: AbortSignal
  ): Promise<HookExecutionSummary> {
    return this.executeHooks(
      'PostToolUse',
      { hookEventName: 'PostToolUse', toolName, result },
      signal,
      { toolName }
    )
  }

  /**
   * 执行 UserPromptSubmit Hook
   *
   * 在用户提交消息时执行，可阻断或修改消息内容。
   *
   * @param userMessage - 用户消息内容
   * @param signal - 取消信号
   * @returns Hook 执行结果
   */
  async runUserPromptSubmitHooks(
    userMessage: string,
    signal: AbortSignal
  ): Promise<HookExecutionSummary> {
    return this.executeHooks(
      'UserPromptSubmit',
      { hookEventName: 'UserPromptSubmit', userMessage },
      signal
    )
  }

  /** 执行 Stop Hook。停止阶段不接收用户输入，只携带时间戳。 */
  async runStopHooks(signal: AbortSignal): Promise<HookExecutionSummary> {
    return this.executeHooks('Stop', { hookEventName: 'Stop', timestamp: Date.now() }, signal)
  }

  /**
   * 执行 SessionStart Hook
   *
   * 在会话创建时执行，可注入系统消息或上下文。
   *
   * @param signal - 取消信号
   * @returns Hook 执行结果
   */
  async runSessionStartHooks(signal: AbortSignal): Promise<HookExecutionSummary> {
    return this.executeHooks(
      'SessionStart',
      { hookEventName: 'SessionStart', timestamp: Date.now() },
      signal
    )
  }
}
