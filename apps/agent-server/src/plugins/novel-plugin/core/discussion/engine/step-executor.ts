/**
 * 群聊 Step 执行器
 *
 * 一次 agent 调用 = 一个 Step。执行器统一负责"工具主路径 + 空终答 + 重试预算 + 取消"，
 * 调度器与引擎只描述"要谁做什么"，不再各自处理 provider 的怪异行为。
 *
 * ⚠️ 收口动机（2026-08-28 控制平面重排 T1）：
 * gpt-5.6-luna 已实证会在工具执行成功后返回空 stop —— 工具 draft 里有完整 payload，
 * 但 `session.prompt()` 只返回第二轮的 text delta = 空串。此前 Director 规划、
 * 角色回合、Moderator 决策、Reviewer 验收四个调用点各写了一遍"终答空就再查工具"的
 * 补救逻辑，语义还不完全一致（Director 补救两轮、角色回合只补救一轮）。
 * 这里统一为一条规则：**只认闭包 payload，终答文本仅作 provider 不支持工具时的兜底**。
 */

import type { FastifyBaseLogger } from 'fastify'

/** Step 重试原因；用于让调用方决定重试前追加什么纠正提示。 */
export type StepRetryReason =
  /** 终答为空且工具未提交（provider 既没产文本也没调工具） */
  | 'empty_without_payload'
  /** 终答有文本但工具未提交（模型改用自由文本，需要纠正回工具主路径） */
  | 'text_without_payload'
  /** 调用抛错（非取消） */
  | 'invocation_failed'

/** 一个带工具闭包捕获的 Step。 */
export interface ToolPayloadStep<T> {
  /** 步骤类型，仅用于日志定位。 */
  kind: string
  /** 执行一次 agent 调用，返回终答文本。attempt 从 1 起。 */
  invoke: (attempt: number) => Promise<string>
  /** 读取工具闭包 payload；未提交返回 null/undefined。 */
  extract: () => T | null | undefined
  /** 最大尝试次数（含首次）。缺省 1，即不重试。 */
  maxAttempts?: number
  /**
   * 是否对该失败原因重试。缺省全部重试。
   *
   * 调用方可能只想对部分原因重试：例如 planning 阶段"终答为空"值得立刻重来，
   * 而"有文本但没调工具"要先尝试解析文本，解析失败才由调用方自己发起纠正轮。
   */
  shouldRetry?: (reason: StepRetryReason) => boolean
  /**
   * 重试前回调：调用方在此追加纠正消息、发降级事件。
   * 抛错会中断整个 Step（视为不可重试）。
   */
  onRetry?: (input: { attempt: number; reason: StepRetryReason; error?: unknown }) => void | Promise<void>
  signal?: AbortSignal
  logger?: FastifyBaseLogger
}

/** Step 执行结果。 */
export interface ToolPayloadOutcome<T> {
  /** 工具闭包捕获的结构化结果；null 表示所有尝试都没拿到。 */
  payload: T | null
  /** 最后一次尝试的终答文本（可能为空串）。 */
  text: string
  /** 实际尝试次数。 */
  attempts: number
  /**
   * 是否出现过"工具已提交但终答为空"。
   * 调用方据此判断"不能把空串当成没产出"，并可用于诊断统计。
   */
  emptyFinalAnswer: boolean
}

/**
 * 执行一个工具闭包 Step。
 *
 * 判定顺序（每次尝试）：
 * 1. 取消 → 立即抛出，不重试。
 * 2. 拿到 payload → 成功返回（终答是否为空都不影响）。
 * 3. 没拿到 payload 但仍有重试预算 → onRetry 后再来一轮。
 * 4. 预算耗尽 → 返回 payload=null + 最后一次终答文本，由调用方决定兜底或失败。
 */
export async function runToolPayloadStep<T>(step: ToolPayloadStep<T>): Promise<ToolPayloadOutcome<T>> {
  const maxAttempts = Math.max(1, step.maxAttempts ?? 1)
  let text = ''
  let emptyFinalAnswer = false
  let attempt = 0

  while (attempt < maxAttempts) {
    throwIfAborted(step.signal)
    attempt++

    let invocationError: unknown
    try {
      text = await step.invoke(attempt)
    } catch (err) {
      // 取消不算失败，也不消耗重试预算：直接抛给上层冻结整个 run。
      throwIfAborted(step.signal)
      invocationError = err
      text = ''
      step.logger?.warn(
        { err, kind: step.kind, attempt },
        'Step 调用失败，检查工具是否已提交',
      )
    }

    // 关键：先看闭包 payload。调用抛错也要查——工具可能已执行成功，
    // 错误发生在工具结果之后的第二轮往返里。
    const payload = step.extract() ?? null
    if (payload != null) {
      if (!text.trim()) emptyFinalAnswer = true
      return { payload, text, attempts: attempt, emptyFinalAnswer }
    }

    if (invocationError && attempt >= maxAttempts) throw invocationError

    if (attempt < maxAttempts) {
      const reason: StepRetryReason = invocationError
        ? 'invocation_failed'
        : text.trim()
          ? 'text_without_payload'
          : 'empty_without_payload'
      if (step.shouldRetry && !step.shouldRetry(reason)) {
        return { payload: null, text, attempts: attempt, emptyFinalAnswer }
      }
      await step.onRetry?.({ attempt, reason, error: invocationError })
    }
  }

  return { payload: null, text, attempts: attempt, emptyFinalAnswer }
}

/** 取消检查：优先抛出 signal.reason，保留调用方的取消语义。 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw signal.reason ?? new Error('群聊步骤已取消')
}
