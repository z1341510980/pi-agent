import { describe, expect, it, vi } from 'vitest'
import { EventBus } from '@repo/shared/events'
import {
  ConfirmationManager,
  type ConfirmationRequestPayload,
} from '../core/tool/confirmation-manager.js'

function createPayload(
  overrides: Partial<ConfirmationRequestPayload> = {},
): ConfirmationRequestPayload {
  return {
    threadId: 'thread-1',
    toolCallId: 'tool-call-1',
    toolName: 'bash',
    args: {
      command: 'rm -rf dist',
    },
    reason: 'bash 需要用户确认',
    ...overrides,
  }
}

describe('ConfirmationManager', () => {
  it('emits confirmation requests and tracks pending state', () => {
    const eventBus = new EventBus()
    const manager = new ConfirmationManager(eventBus)
    const emitted: unknown[] = []
    eventBus.on('confirmation:request', (event) => emitted.push(event))

    void manager.requestConfirmation(createPayload())

    const pending = manager.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]?.toolName).toBe('bash')
    expect(emitted).toEqual([pending[0]])
  })

  it('resolves true when a pending request is approved', async () => {
    const manager = new ConfirmationManager(new EventBus())

    const decision = manager.requestConfirmation(createPayload())
    const pending = manager.listPending()[0]

    expect(pending).toBeDefined()
    expect(manager.respond(pending!.id, true)).toBe(true)
    await expect(decision).resolves.toBe(true)
    expect(manager.listPending()).toHaveLength(0)
  })

  it('resolves false when a pending request is denied', async () => {
    const manager = new ConfirmationManager(new EventBus())

    const decision = manager.requestConfirmation(createPayload())
    const pending = manager.listPending()[0]

    expect(manager.respond(pending!.id, false)).toBe(true)
    await expect(decision).resolves.toBe(false)
    expect(manager.listPending()).toHaveLength(0)
  })

  it('returns false for unknown responses', () => {
    const manager = new ConfirmationManager(new EventBus())

    expect(manager.respond('missing', true)).toBe(false)
  })

  it('times out pending confirmations as denied', async () => {
    vi.useFakeTimers()
    try {
      const manager = new ConfirmationManager(new EventBus(), {
        timeoutMs: 1_000,
      })

      const decision = manager.requestConfirmation(createPayload())
      await vi.advanceTimersByTimeAsync(1_000)

      await expect(decision).resolves.toBe(false)
      expect(manager.listPending()).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
