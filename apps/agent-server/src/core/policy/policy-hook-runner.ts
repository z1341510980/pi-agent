/**
 * Policy Hook Runner
 *
 * 执行命令钩子，支持超时、取消、stdin JSON 传递、输出解码和结果合并。
 *
 * 安全边界（P1-2）：
 * - 默认按 argv 执行（无 shell）；shell 求值必须同时满足 `hook.shell` 与 `context.trusted`。
 * - 默认只继承环境变量白名单；完整 process.env 只在 trusted 配置下继承。
 * - cwd 必须存在且是目录，否则视为启动失败而不是静默回落到进程 cwd。
 * - stdout/stderr 各自有字节上限，超限截断并在输出中标记 truncated。
 * - 超时、外部取消、启动失败三种非正常结束在 terminationReason 中如实区分。
 *
 * @module core/policy/policy-hook-runner
 */

import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import type {
  CommandHook,
  HookExecutionContext,
  HookExecutionResult,
  HookOutput,
  MergedHookOutcome,
} from './hook-types.js'

/**
 * 默认超时时间（毫秒），与 DSH 保持一致：10 分钟
 */
export const DEFAULT_HOOK_TIMEOUT_MS = 600_000

/** stdout / stderr 各自的默认字节上限 */
export const DEFAULT_HOOK_MAX_OUTPUT_BYTES = 256 * 1024

/**
 * 非受信 Hook 配置可继承的环境变量白名单。
 *
 * 只包含「进程能被找到并正常启动」所需的变量；API Key、token 等一律不传递。
 */
export const DEFAULT_HOOK_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'LANG',
  'LC_ALL',
  'TZ',
]

/**
 * Hook 进程阻断退出码（exit 2 表示阻断）
 */
const BLOCKING_EXIT_CODE = 2

/**
 * 引号感知的命令分词。
 *
 * 无 shell 执行需要自己切分 argv。支持单/双引号包裹含空格的参数，
 * 引号内的换行按字面保留（hooks.yml 里的多行 `node -e "..."` 依赖这一点）。
 *
 * @throws 引号未闭合时抛错，避免把半截命令交给子进程
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quoted = false
  let quote: '"' | "'" | null = null

  for (const ch of command) {
    if (quote) {
      if (ch === quote) {
        quote = null
        continue
      }
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      quoted = true
      continue
    }
    if (/\s/.test(ch)) {
      if (quoted || current.length > 0) {
        tokens.push(current)
        current = ''
        quoted = false
      }
      continue
    }
    current += ch
  }

  if (quote) throw new Error('命令中的引号未闭合')
  if (quoted || current.length > 0) tokens.push(current)
  return tokens
}

/**
 * 构建子进程环境变量。
 *
 * trusted 配置继承完整 process.env；非受信配置只继承白名单。
 * 两种情况下 context.env 显式提供的变量都会被合并（宿主自己传的值由宿主负责）。
 */
export function buildHookEnv(context: HookExecutionContext): Record<string, string> {
  const extras = context.env ?? {}
  if (context.trusted === true) {
    return { ...(process.env as Record<string, string>), ...extras }
  }
  const allowlist = context.envAllowlist ?? DEFAULT_HOOK_ENV_ALLOWLIST
  const inherited: Record<string, string> = {}
  for (const name of allowlist) {
    const value = process.env[name]
    if (typeof value === 'string') inherited[name] = value
  }
  return { ...inherited, ...extras }
}

/** 非正常结束时的统一输出构造 */
function failureOutput(
  stderr: string,
  reason: NonNullable<HookOutput['terminationReason']>
): HookOutput {
  return { exitCode: undefined, stderr, stdout: '', terminationReason: reason }
}

/**
 * 执行一个命令钩子
 *
 * 将 payload 序列化为 JSON 写入 stdin，执行命令，解码 stdout/stderr 和退出码。
 * 基础设施错误（spawn 失败）不阻断，返回 exitCode: undefined 且带 terminationReason 的输出。
 *
 * @param hook - 命令钩子配置
 * @param context - 执行上下文
 * @param now - 时钟函数（用于计算耗时）
 * @returns 解码后的输出和执行耗时
 */
export async function runHook(
  hook: CommandHook,
  context: HookExecutionContext,
  now: () => number = Date.now,
): Promise<HookExecutionResult> {
  const started = now()
  const timeoutMs =
    context.timeoutMs ??
    (hook.timeoutSec !== undefined ? hook.timeoutSec * 1000 : DEFAULT_HOOK_TIMEOUT_MS)
  const maxOutputBytes = context.maxOutputBytes ?? DEFAULT_HOOK_MAX_OUTPUT_BYTES
  const trailingNewline = context.trailingNewline ?? true
  const stdinPayload = JSON.stringify(context.payload) + (trailingNewline ? '\n' : '')

  const signal = context.signal

  // 已经取消：不启动子进程
  if (signal.aborted) {
    return {
      output: failureOutput('cancelled', 'cancelled'),
      durationMs: now() - started,
    }
  }

  // cwd 必须真实存在，否则明确失败而不是回落到宿主 cwd 执行
  if (context.cwd !== undefined) {
    try {
      if (!statSync(context.cwd).isDirectory()) {
        return {
          output: failureOutput(`hook cwd 不是目录: ${context.cwd}`, 'spawn-failed'),
          durationMs: now() - started,
        }
      }
    } catch {
      return {
        output: failureOutput(`hook cwd 不存在: ${context.cwd}`, 'spawn-failed'),
        durationMs: now() - started,
      }
    }
  }

  // shell 求值只在受信配置下开放；非受信配置即使写了 shell: true 也按 argv 执行
  const useShell = context.trusted === true && hook.shell === true
  let file = hook.command
  let argv: string[] = []
  if (!useShell) {
    let tokens: string[]
    try {
      tokens = hook.args ? [hook.command, ...hook.args] : tokenizeCommand(hook.command)
    } catch (error) {
      return {
        output: failureOutput(
          error instanceof Error ? error.message : String(error),
          'spawn-failed'
        ),
        durationMs: now() - started,
      }
    }
    if (tokens.length === 0 || tokens[0].length === 0) {
      return {
        output: failureOutput('hook command 为空', 'spawn-failed'),
        durationMs: now() - started,
      }
    }
    file = tokens[0]
    argv = tokens.slice(1)
  }

  const controller = new AbortController()
  let terminationReason: NonNullable<HookOutput['terminationReason']> = 'exit'
  const onAbort = (): void => {
    terminationReason = 'cancelled'
    controller.abort()
  }
  signal.addEventListener('abort', onAbort)

  let timeoutId: NodeJS.Timeout | undefined
  if (timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      terminationReason = 'timeout'
      controller.abort()
    }, timeoutMs)
  }

  // 按字节累计并截断，防止 Hook 输出打爆内存或提示词
  let stdout = ''
  let stderr = ''
  let stdoutBytes = 0
  let stderrBytes = 0
  let truncated = false
  const append = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
    const used = stream === 'stdout' ? stdoutBytes : stderrBytes
    const remaining = maxOutputBytes - used
    if (remaining <= 0) {
      truncated = true
      return
    }
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
    if (slice.length < chunk.length) truncated = true
    if (stream === 'stdout') {
      stdout += slice.toString('utf-8')
      stdoutBytes += slice.length
    } else {
      stderr += slice.toString('utf-8')
      stderrBytes += slice.length
    }
  }

  let exitCode: number | undefined = undefined
  let spawnError: string | undefined

  try {
    const child = useShell
      ? spawn(file, {
          shell: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: context.cwd,
          env: buildHookEnv(context),
          signal: controller.signal,
        })
      : spawn(file, argv, {
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: context.cwd,
          env: buildHookEnv(context),
          signal: controller.signal,
        })

    // 子进程可能不读 stdin 就退出，EPIPE 不应升级为宿主异常
    child.stdin.on('error', () => {})
    child.stdin.write(stdinPayload)
    child.stdin.end()

    child.stdout.on('data', (data: Buffer) => append('stdout', data))
    child.stderr.on('data', (data: Buffer) => append('stderr', data))

    const code = await new Promise<number | null>((resolve) => {
      child.on('error', (error: NodeJS.ErrnoException) => {
        // AbortController 触发的 kill 也会走 error（ABORT_ERR），不算启动失败
        if (error.name !== 'AbortError' && error.code !== 'ABORT_ERR') {
          spawnError = error.message
        }
        resolve(null)
      })
      child.on('close', (closeCode) => resolve(closeCode))
    })

    if (controller.signal.aborted) {
      // 超时/取消：子进程被宿主杀掉，stderr 不代表 Hook 自身诊断
      exitCode = undefined
      stderr = ''
      if (terminationReason === 'exit') terminationReason = 'cancelled'
    } else if (spawnError !== undefined) {
      exitCode = undefined
      terminationReason = 'spawn-failed'
      if (stderr.trim().length === 0) stderr = spawnError
    } else if (code !== null) {
      exitCode = code
      if (code !== 0 && stderr.trim().length === 0) stderr = `hook exited with code ${code}`
    } else {
      // close 未给出退出码且无 error：进程被信号终止
      exitCode = undefined
      terminationReason = 'spawn-failed'
      if (stderr.trim().length === 0) stderr = 'hook process terminated without exit code'
    }
  } catch (error: unknown) {
    exitCode = undefined
    if (controller.signal.aborted) {
      stderr = ''
      if (terminationReason === 'exit') terminationReason = 'cancelled'
    } else {
      terminationReason = 'spawn-failed'
      stderr = error instanceof Error ? error.message : String(error)
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
    signal.removeEventListener('abort', onAbort)
  }

  const output = parseHookOutput(exitCode, stdout, stderr, context.expectedEventName)
  output.terminationReason = terminationReason
  if (truncated) output.truncated = true
  return {
    output,
    durationMs: now() - started,
  }
}

/**
 * 解析 Hook 进程输出
 *
 * - exit 0 + JSON → 解码结构化字段
 * - exit 0 + 非 JSON → 保留原文本
 * - exit 2 → 阻断，stderr 作为阻断原因
 * - 其他 exit code / spawn 失败 → 记录错误但不阻断
 * - expectedEventName 守卫：hookSpecificOutput.hookEventName 不匹配时丢弃事件字段
 *
 * @param exitCode - 进程退出码（undefined 表示 spawn 失败或信号终止）
 * @param stdout - 原始 stdout
 * @param stderr - 原始 stderr
 * @param expectedEventName - 期望的 hookEventName（守卫）
 * @returns 解码后的输出
 */
export function parseHookOutput(
  exitCode: number | undefined,
  stdout: string,
  stderr: string,
  expectedEventName?: string,
): HookOutput {
  const trimmedErr = stderr.trim()
  const trimmedOut = stdout.trim()

  const output: HookOutput = {
    exitCode,
    stderr: trimmedErr,
    stdout: trimmedOut,
  }

  // exit 2 → 阻断
  if (exitCode === BLOCKING_EXIT_CODE) {
    output.decision = 'block'
    if (trimmedErr.length > 0) output.reason = trimmedErr
  }

  // exit 0 → 尝试解析 JSON
  if (exitCode === 0 && trimmedOut.startsWith('{')) {
    let parsed: Record<string, unknown> | undefined
    try {
      parsed = JSON.parse(trimmedOut) as Record<string, unknown>
    } catch {
      // 解析失败，保留原文本（非结构化 stdout）
    }
    if (parsed) {
      applyStructuredOutput(output, parsed, expectedEventName)
    }
  }

  return output
}

/**
 * 将结构化 JSON 输出应用到 HookOutput
 *
 * 支持：
 * - continue / stopReason（粘性停止）
 * - decision（top-level: approve/block；hookSpecificOutput.permissionDecision: allow/deny/ask）
 * - additionalContext / systemMessage
 * - hookEventName 守卫
 * - updatedInput（PreToolUse 改写参数）
 *
 * @param output - 目标输出对象（原地修改）
 * @param parsed - 解析后的 JSON 对象
 * @param expectedEventName - 期望的 hookEventName（守卫）
 */
function applyStructuredOutput(
  output: HookOutput,
  parsed: Record<string, unknown>,
  expectedEventName?: string,
): void {
  // continue / stopReason
  if (typeof parsed.continue === 'boolean') {
    output.continue = parsed.continue
  }
  if (typeof parsed.stopReason === 'string') {
    output.stopReason = parsed.stopReason
  }

  // systemMessage
  if (typeof parsed.systemMessage === 'string') {
    output.systemMessage = parsed.systemMessage
  }

  // top-level decision: approve/block ONLY
  const topDecision = parsed.decision
  if (topDecision === 'approve' || topDecision === 'block') {
    output.decision = topDecision
  }
  if (typeof parsed.reason === 'string') {
    output.reason = parsed.reason
  }

  // hookSpecificOutput
  const hso = parsed.hookSpecificOutput as Record<string, unknown> | undefined
  if (hso && typeof hso === 'object') {
    const eventName = hso.hookEventName as string | undefined
    if (eventName !== undefined) {
      output.hookEventName = eventName
    }

    // 守卫：如果 expectedEventName 存在且不匹配，丢弃事件字段
    if (expectedEventName !== undefined && eventName !== expectedEventName) {
      return
    }

    // permissionDecision: allow/deny/ask
    const permission = hso.permissionDecision as string | undefined
    if (permission === 'allow' || permission === 'deny' || permission === 'ask') {
      output.decision = permission
    }
    if (typeof hso.permissionDecisionReason === 'string') {
      output.reason = hso.permissionDecisionReason
    }

    if (typeof hso.additionalContext === 'string') {
      output.additionalContext = hso.additionalContext
    }

    const updated = hso.updatedInput as Record<string, unknown> | undefined
    if (updated && typeof updated === 'object' && !Array.isArray(updated)) {
      output.updatedInput = updated
    }
  }
}

/**
 * 合并多个 Hook 输出为一个结果
 *
 * 规则：
 * - 决策优先级：deny > ask > allow（block/deny 归一化为 deny，approve/allow 归一化为 allow）
 * - 第一处 continue:false 为粘性停止
 * - additionalContext 和 systemMessage 按顺序累积
 * - 原因只保留最高优先级决策的原因
 *
 * @param outputs - Hook 输出列表（按执行顺序）
 * @returns 合并后的结果
 */
export function mergeHookOutputs(outputs: HookOutput[]): MergedHookOutcome {
  let maxRank = 0
  const reasonsByRank = new Map<number, string[]>()
  let stop = false
  let stopReason: string | undefined
  const additionalContext: string[] = []
  const systemMessages: string[] = []
  let updatedInput: Record<string, unknown> | undefined

  for (const out of outputs) {
    const rank = decisionRank(out.decision)
    if (rank > maxRank) maxRank = rank

    // 记录原因
    if ((rank === 3 || rank === 2) && out.reason !== undefined && out.reason.length > 0) {
      const list = reasonsByRank.get(rank) ?? []
      list.push(out.reason)
      reasonsByRank.set(rank, list)
    }

    // 粘性停止：第一处 continue:false 生效
    if (out.continue === false && !stop) {
      stop = true
      if (out.stopReason !== undefined) stopReason = out.stopReason
    }

    // 累积上下文
    if (out.additionalContext !== undefined && out.additionalContext.length > 0) {
      additionalContext.push(out.additionalContext)
    }
    if (out.systemMessage !== undefined && out.systemMessage.length > 0) {
      systemMessages.push(out.systemMessage)
    }
    if (out.updatedInput !== undefined) {
      updatedInput = { ...(updatedInput ?? {}), ...out.updatedInput }
    }
  }

  const decision = decisionFromRank(maxRank)
  const reasons = reasonsByRank.get(maxRank) ?? []

  return {
    decision,
    ...(reasons.length > 0 ? { reason: reasons.join('\n\n') } : {}),
    stop,
    ...(stopReason !== undefined ? { stopReason } : {}),
    additionalContext,
    systemMessages,
    ...(updatedInput !== undefined ? { updatedInput } : {}),
  }
}

/**
 * 决策优先级排名（rank 越高越严格）
 */
function decisionRank(decision: HookOutput['decision']): number {
  switch (decision) {
    case 'deny':
    case 'block':
      return 3
    case 'ask':
      return 2
    case 'allow':
    case 'approve':
      return 1
    default:
      return 0
  }
}

/**
 * 从排名反推决策类型
 */
function decisionFromRank(rank: number): MergedHookOutcome['decision'] {
  switch (rank) {
    case 3:
      return 'deny'
    case 2:
      return 'ask'
    case 1:
      return 'allow'
    default:
      return 'none'
  }
}