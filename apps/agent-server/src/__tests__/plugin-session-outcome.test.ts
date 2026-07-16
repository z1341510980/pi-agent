import { describe, expect, it } from 'vitest'
import {
  getAssistantTerminalError,
  isFinalAssistantSuccess,
  waitForFinalAssistantOrPrompt,
} from '../core/plugin/plugin-session-outcome.js'

describe('getAssistantTerminalError', () => {
  it('clears a transient error when an SDK retry succeeds', () => {
    let lastErrorMessage = ''
    const messages = [
      { role: 'assistant', stopReason: 'error', errorMessage: 'Request timed out.' },
      { role: 'assistant', stopReason: 'stop' },
    ]

    for (const message of messages) {
      const terminalError = getAssistantTerminalError(message)
      if (terminalError !== null) lastErrorMessage = terminalError
    }

    expect(lastErrorMessage).toBe('')
  })

  it('keeps the final assistant error', () => {
    expect(getAssistantTerminalError({
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'Stream ended without finish_reason',
    })).toBe('Stream ended without finish_reason')
  })

  it('ignores non-assistant terminal messages', () => {
    expect(getAssistantTerminalError({ role: 'user' })).toBeNull()
  })
})

describe('isFinalAssistantSuccess', () => {
  it('accepts final text responses', () => {
    expect(isFinalAssistantSuccess({ role: 'assistant', stopReason: 'stop' })).toBe(true)
    expect(isFinalAssistantSuccess({ role: 'assistant', stopReason: 'length' })).toBe(true)
  })

  it('does not finish on tool use or errors', () => {
    expect(isFinalAssistantSuccess({ role: 'assistant', stopReason: 'toolUse' })).toBe(false)
    expect(isFinalAssistantSuccess({ role: 'assistant', stopReason: 'error' })).toBe(false)
  })
})

describe('waitForFinalAssistantOrPrompt', () => {
  it('returns as soon as the final assistant response arrives', async () => {
    let resolveAssistant!: () => void
    const finalAssistantPromise = new Promise<void>((resolve) => {
      resolveAssistant = resolve
    })
    const promptPromise = new Promise<void>(() => {})

    const waiting = waitForFinalAssistantOrPrompt({
      promptPromise,
      finalAssistantPromise,
      timeoutMs: 1_000,
    })
    resolveAssistant()

    await expect(waiting).resolves.toBe('assistant')
  })

  it('propagates prompt failures before a final response', async () => {
    await expect(waitForFinalAssistantOrPrompt({
      promptPromise: Promise.reject(new Error('provider failed')),
      finalAssistantPromise: new Promise<void>(() => {}),
      timeoutMs: 1_000,
    })).rejects.toThrow('provider failed')
  })

  it('preserves the configured timeout', async () => {
    await expect(waitForFinalAssistantOrPrompt({
      promptPromise: new Promise<void>(() => {}),
      finalAssistantPromise: new Promise<void>(() => {}),
      timeoutMs: 10,
    })).rejects.toThrow('LLM 调用超时（0.01s）')
  })
})
