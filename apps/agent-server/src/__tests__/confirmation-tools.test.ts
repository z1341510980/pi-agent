import { describe, expect, it } from 'vitest'
import type { BeforeToolCallContext } from '@earendil-works/pi-agent-core'
import { EventBus } from '@repo/shared/events'
import { ConfirmationManager } from '../core/tool/confirmation-manager.js'
import { createBeforeToolCall } from '../core/tool/confirmation-tools.js'
import { Gate } from '../core/tool/gate.js'

function createContext(overrides: Partial<BeforeToolCallContext> = {}): BeforeToolCallContext {
  return {
    assistantMessage: { content: [] } as any,
    toolCall: {
      type: 'toolCall',
      id: 'tool-call-1',
      name: 'bash',
      arguments: { command: 'pnpm test' },
    },
    args: { command: 'pnpm test' },
    context: { systemPrompt: '', messages: [] },
    ...overrides,
  } as BeforeToolCallContext
}

describe('createBeforeToolCall hook', () => {
  it('returns undefined when Gate allows the tool', async () => {
    const hook = createBeforeToolCall({
      threadId: 'thread-1',
      gate: new Gate(),
      confirmationManager: new ConfirmationManager(new EventBus()),
    })

    // 用 read 工具（safe 等级，auto 模式下自动允许）
    const result = await hook(
      createContext({
        toolCall: {
          type: 'toolCall',
          id: 'tool-call-1',
          name: 'read',
          arguments: { path: '/tmp/test.txt' },
        },
        args: { path: '/tmp/test.txt' },
      }),
    )
    expect(result).toBeUndefined()
  })

  it('returns { block: true } when Gate denies the tool', async () => {
    const hook = createBeforeToolCall({
      threadId: 'thread-1',
      gate: new Gate({ deniedTools: ['bash'] }),
      confirmationManager: new ConfirmationManager(new EventBus()),
    })

    const result = await hook(createContext())
    expect(result).toEqual({
      block: true,
      reason: "工具 'bash' 被安全策略禁止",
    })
  })

  it('blocks when confirmation is denied', async () => {
    const manager = new ConfirmationManager(new EventBus())
    const hook = createBeforeToolCall({
      threadId: 'thread-1',
      gate: new Gate({ confirmationTools: ['bash'] }),
      confirmationManager: manager,
    })

    const decision = hook(createContext())
    await Promise.resolve()
    const pending = manager.listPending()[0]
    expect(pending).toMatchObject({
      threadId: 'thread-1',
      toolCallId: 'tool-call-1',
      toolName: 'bash',
      args: { command: 'pnpm test' },
    })

    manager.respond(pending!.id, false)

    await expect(decision).resolves.toEqual({
      block: true,
      reason: "用户拒绝执行工具 'bash'",
    })
  })

  it('allows execution when confirmation is approved', async () => {
    const manager = new ConfirmationManager(new EventBus())
    const hook = createBeforeToolCall({
      threadId: 'thread-1',
      gate: new Gate({ confirmationTools: ['bash'] }),
      confirmationManager: manager,
    })

    const decision = hook(createContext())
    await Promise.resolve()
    const pending = manager.listPending()[0]
    manager.respond(pending!.id, true)

    await expect(decision).resolves.toBeUndefined()
  })

  it('normalizes non-object args to empty record', async () => {
    const manager = new ConfirmationManager(new EventBus())
    const hook = createBeforeToolCall({
      threadId: 'thread-1',
      gate: new Gate({ confirmationTools: ['bash'] }),
      confirmationManager: manager,
    })

    const decision = hook(createContext({ args: null }))
    await Promise.resolve()
    const pending = manager.listPending()[0]
    expect(pending?.args).toEqual({})
    manager.respond(pending!.id, true)
    await expect(decision).resolves.toBeUndefined()
  })
})
