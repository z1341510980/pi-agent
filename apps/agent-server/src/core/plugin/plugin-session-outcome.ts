/**
 * Return the error represented by an assistant terminal message.
 * An empty string means the latest assistant attempt completed successfully;
 * null means the message is unrelated and must not change the current state.
 *
 * 识别两种失败 stopReason：
 * - 'error'：LLM 网关/SDK 报错（如截断、空响应）
 * - 'aborted'：PI SDK session.abort() 触发（runWithLifecycle catch → handleRunFailure
 *   emit message_end with stopReason='aborted'）。PI SDK 设计上不抛错给上层，
 *   需要调用方检查 stopReason 才能感知 abort。
 *   若不识别，prompt() 会返回空内容，orchestrator 无法进入 catch 块清理锁，
 *   导致后续 onCheckpoint 创建的 pending 永远不会被 reject，cancel-active-flow 路由
 *   await 的 donePromise 永不 resolve，整个取消流程卡死。
 */
export function getAssistantTerminalError(
  message: Record<string, unknown> | undefined,
  options: { requireComplete?: boolean } = {},
): string | null {
  if (!message || message.role !== 'assistant') return null
  if (message.stopReason === 'error') {
    return (message.errorMessage as string) || 'Unknown LLM error'
  }
  if (message.stopReason === 'aborted') {
    return (message.errorMessage as string) || 'LLM 调用已被中止'
  }
  if (message.stopReason === 'length' && options.requireComplete) {
    return 'LLM 输出达到 token 上限，结构化响应未完整生成'
  }
  return ''
}

/** A final text response can be returned before Pi finishes auto-compaction. */
export function isFinalAssistantSuccess(message: Record<string, unknown> | undefined): boolean {
  if (!message || message.role !== 'assistant') return false
  return message.stopReason === 'stop' || message.stopReason === 'length'
}

type PromptWaitResult = 'assistant' | 'prompt'

/**
 * Wait for either the final assistant response or the full Pi prompt lifecycle.
 * The prompt rejection handler stays attached when the assistant wins, so a
 * later compaction failure cannot become an unhandled rejection.
 */
export async function waitForFinalAssistantOrPrompt(options: {
  promptPromise: Promise<unknown>
  finalAssistantPromise: Promise<void>
  timeoutMs: number
}): Promise<PromptWaitResult> {
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  const observedPrompt = options.promptPromise.then(
    () => ({ type: 'prompt' as const }),
    (error: unknown) => ({ type: 'error' as const, error }),
  )
  const timeoutPromise = new Promise<{ type: 'timeout' }>((resolve) => {
    timeoutTimer = setTimeout(() => resolve({ type: 'timeout' }), options.timeoutMs)
  })

  try {
    const outcome = await Promise.race([
      options.finalAssistantPromise.then(() => ({ type: 'assistant' as const })),
      observedPrompt,
      timeoutPromise,
    ])

    if (outcome.type === 'error') throw outcome.error
    if (outcome.type === 'timeout') {
      throw new Error(`LLM 调用超时（${options.timeoutMs / 1000}s）`)
    }
    return outcome.type
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer)
  }
}
