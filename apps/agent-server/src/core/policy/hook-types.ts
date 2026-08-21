/**
 * Hook 协议类型定义
 *
 * 参考 DSH hook-protocol 的设计，提供统一的 Hook 执行、解码和合并能力。
 * 用于 Pi 事件桥接（P1 阶段）。
 *
 * @module core/policy/hook-types
 */

/**
 * 单个 Hook 命令配置
 *
 * 从配置文件或代码中定义的 Hook，包含命令、超时和匹配规则。
 */
export interface CommandHook {
  /**
   * 要执行的命令。
   *
   * 默认按 argv 执行（无 shell）：`command` 为可执行文件，参数来自 `args`，
   * 未提供 `args` 时对 `command` 做引号感知分词。
   * 需要管道/重定向等 shell 语法时必须显式 `shell: true`，且仅在受信配置下生效。
   */
  command: string
  /** 显式 argv 参数；提供时不再对 command 分词 */
  args?: string[]
  /** 超时时间（秒），覆盖默认值 */
  timeoutSec?: number
  /** 显式要求完整 shell 求值；仅当执行上下文 trusted 时被接受 */
  shell?: boolean
}

/**
 * Hook 执行结果（从子进程 stdout/stderr 解码）
 *
 * 与 DSH HookOutput 保持语义一致。
 */
export interface HookOutput {
  /** 进程退出码（undefined 表示 spawn 失败或信号终止） */
  exitCode?: number
  /** stderr 原始内容 */
  stderr: string
  /** stdout 原始内容（非结构化时为纯文本） */
  stdout: string

  /** 是否继续执行（false 表示粘性停止） */
  continue?: boolean
  /** 停止原因（当 continue:false 时） */
  stopReason?: string

  /** 决策类型：deny > ask > allow (block/approve 已归一化) */
  decision?: 'deny' | 'ask' | 'allow' | 'approve' | 'block'
  /** 决策原因（用于审计和用户展示） */
  reason?: string

  /** 额外上下文（累积到会话中） */
  additionalContext?: string
  /** 系统消息（累积到系统提示词中） */
  systemMessage?: string

  /** 结构化输出中的 hookEventName 判别器 */
  hookEventName?: string
  /** 更新后的输入（仅 PreToolUse 可改写参数） */
  updatedInput?: Record<string, unknown>

  /** stdout 或 stderr 是否因超过上限而被截断 */
  truncated?: boolean
  /** 本次执行的终止原因，用于区分正常退出与超时/取消/启动失败 */
  terminationReason?: 'exit' | 'timeout' | 'cancelled' | 'spawn-failed'
}

/**
 * 合并后的 Hook 结果
 *
 * 多个 Hook 按 deny > ask > allow 优先级合并。
 */
export interface MergedHookOutcome {
  /** 合并后的决策：deny | ask | allow | none */
  decision: 'deny' | 'ask' | 'allow' | 'none'
  /** 合并后的原因（仅当决策为 deny 或 ask 时） */
  reason?: string
  /** 是否停止执行 */
  stop: boolean
  /** 停止原因 */
  stopReason?: string
  /** 累积的额外上下文（Hook 顺序） */
  additionalContext: string[]
  /** 累积的系统消息（Hook 顺序） */
  systemMessages: string[]
  /** 合并后的工具参数改写 */
  updatedInput?: Record<string, unknown>
}

/**
 * Hook 执行上下文
 *
 * 传递给 runHook 的运行时信息。
 */
export interface HookExecutionContext {
  /** 触发 Hook 的事件名称（用于 expectedEventName 守卫） */
  eventName: string
  /** JSON payload（写入 stdin） */
  payload: unknown
  /** 工作目录（默认使用进程 cwd） */
  cwd?: string
  /** 额外环境变量 */
  env?: Record<string, string>
  /** 取消信号 */
  signal: AbortSignal
  /** 超时时间（毫秒），覆盖默认值 */
  timeoutMs?: number
  /** 是否在 stdin 末尾追加换行（DSH 中 CC 为 true，Codex 为 false） */
  trailingNewline?: boolean
  /** 期望的 hookEventName（用于守卫 hookSpecificOutput 字段） */
  expectedEventName?: string
  /**
   * 配置是否来自受信来源。
   *
   * 非受信配置强制无 shell 执行（忽略 hook.shell），并且只继承环境变量白名单。
   * 默认 false：宿主必须显式声明信任，不能靠调用方省略参数取得完整环境。
   */
  trusted?: boolean
  /**
   * 允许继承的宿主环境变量名白名单。
   *
   * 未提供时使用内置最小白名单（PATH 等）。trusted 时继承完整 process.env。
   */
  envAllowlist?: string[]
  /** stdout/stderr 各自的字节上限，超出即截断并标记 truncated。默认 256KB。 */
  maxOutputBytes?: number
}

/**
 * Hook 执行结果（含耗时）
 */
export interface HookExecutionResult {
  /** 解码后的输出 */
  output: HookOutput
  /** 执行耗时（毫秒） */
  durationMs: number
}