/**
 * Return the error represented by an assistant terminal message.
 * An empty string means the latest assistant attempt completed successfully;
 * null means the message is unrelated and must not change the current state.
 */
export function getAssistantTerminalError(message: Record<string, unknown> | undefined): string | null {
  if (!message || message.role !== 'assistant') return null
  if (message.stopReason !== 'error') return ''
  return (message.errorMessage as string) || 'Unknown LLM error'
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
