import { describe, expect, it, vi } from 'vitest'
import { EventBus } from '@repo/shared/events'
import { ConfirmationManager } from '../core/tool/confirmation-manager.js'
import { Gate } from '../core/tool/gate.js'

const agent: any = {
  beforeToolCall: undefined,
}

const session: any = {
  agent,
  subscribe: vi.fn(),
}

vi.mock('@earendil-works/pi-coding-agent', () => {
  return {
    DefaultResourceLoader: class {
      async reload() {}
    },
    createAgentSession: vi.fn(async () => ({
      session,
    })),
  }
})

describe('createPiSession beforeToolCall integration', () => {
  it('installs beforeToolCall hook on session.agent', async () => {
    const { createPiSession } = await import('../core/agent/pi-session.js')

    await createPiSession({
      threadId: 'thread-1',
      authStorage: {
        setFallbackResolver: vi.fn(),
      },
      modelRegistry: {
        getAll: () => [
          {
            provider: 'deepseek',
            id: 'deepseek-chat',
          },
        ],
      },
      sessionManager: {},
      credentialBridge: {},
      gate: new Gate({ confirmationTools: ['bash'] }),
      confirmationManager: new ConfirmationManager(new EventBus()),
      eventBus: new EventBus(),
      config: {
        cwd: process.cwd(),
        dataDir: process.cwd(),
      },
    } as any)

    expect(typeof session.agent.beforeToolCall).toBe('function')
  })
})
