import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthStorage, ModelRegistry, SessionManager } from '@earendil-works/pi-coding-agent'
import Database from 'better-sqlite3'
import { EventBus } from '@repo/shared/events'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { runMigrations } from '../core/db/migrations.js'
import { ConfirmationManager } from '../core/tool/confirmation-manager.js'
import { Gate } from '../core/tool/gate.js'
import type { CredentialBridge } from '../core/config/credential-bridge.js'
import type { ProviderConfigStore } from '../core/config/provider-config-store.js'
import type { PiSessionDeps } from '../core/agent/pi-session.js'

interface ModelStub {
  provider: string
  id: string
}

interface MockAgent {
  beforeToolCall?: unknown
  afterToolCall?: unknown
}

interface MockSession {
  agent: MockAgent
  subscribe: ReturnType<typeof vi.fn>
}

interface CreateAgentSessionOptionsStub {
  model?: ModelStub
}

const mocks = vi.hoisted(() => {
  const agent: MockAgent = {
    beforeToolCall: undefined,
  }

  const session: MockSession = {
    agent,
    subscribe: vi.fn(),
  }

  return {
    agent,
    session,
    createAgentSession: vi.fn(async () => ({
      session,
    })),
  }
})

vi.mock('@earendil-works/pi-coding-agent', () => {
  return {
    DefaultResourceLoader: class {
      async reload() {}
    },
    createAgentSession: mocks.createAgentSession,
  }
})

describe('createPiSession beforeToolCall integration', () => {
  beforeEach(() => {
    mocks.agent.beforeToolCall = undefined
    mocks.agent.afterToolCall = undefined
    mocks.session.subscribe.mockClear()
    mocks.createAgentSession.mockClear()
  })

  it('TC-01: installs beforeToolCall hook on session.agent', async () => {
    const { createPiSession } = await import('../core/agent/pi-session.js')

    await createPiSession(createDeps([
      { provider: 'openai', id: 'gpt-4.1-mini' },
    ]))

    expect(typeof mocks.session.agent.beforeToolCall).toBe('function')
  })

  it('TC-02: selects configured OpenAI model instead of DeepSeek when both exist', async () => {
    const { createPiSession } = await import('../core/agent/pi-session.js')

    await createPiSession(createDeps([
      { provider: 'deepseek', id: 'deepseek-chat' },
      { provider: 'openai', id: 'gpt-4.1-mini' },
    ]))

    const firstCall = mocks.createAgentSession.mock.calls[0] as unknown as [CreateAgentSessionOptionsStub] | undefined
    const options = firstCall?.[0]
    expect(options?.model).toEqual({ provider: 'openai', id: 'gpt-4.1-mini' })
  })

  it('TC-03: throws CONFIG_ERROR when configured model is missing', async () => {
    const { createPiSession } = await import('../core/agent/pi-session.js')

    await expect(createPiSession(createDeps([
      { provider: 'deepseek', id: 'deepseek-chat' },
    ]))).rejects.toMatchObject({
      code: ErrorCode.CONFIG_ERROR,
    } satisfies Partial<AppError>)
  })
})

function createDeps(
  models: ModelStub[],
): PiSessionDeps {
  const db = new Database(':memory:')
  runMigrations(db)
  return {
    threadId: 'thread-1',
    authStorage: {
      setFallbackResolver: vi.fn(),
    } as unknown as AuthStorage,
    modelRegistry: {
      getAll: () => models,
      find: (provider: string, modelId: string) => (
        models.find((model) => model.provider === provider && model.id === modelId)
      ),
    } as unknown as ModelRegistry,
    sessionManager: {} as unknown as SessionManager,
    credentialBridge: {} as CredentialBridge,
    providerConfigStore: {
      getApiKey: (provider: string) => provider === 'openai' ? 'test-key' : undefined,
      list: () => [{ id: 'openai', models: [{ id: 'gpt-4.1-mini' }] }],
    } as unknown as ProviderConfigStore,
    getApiKey: async (provider: string) => provider === 'openai' ? 'test-key' : undefined,
    gate: new Gate({ confirmationTools: ['bash'] }),
    confirmationManager: new ConfirmationManager(new EventBus()),
    eventBus: new EventBus(),
    db,
    config: {
      cwd: process.cwd(),
      dataDir: process.cwd(),
    },
  }
}
