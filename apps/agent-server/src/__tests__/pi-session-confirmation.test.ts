import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import Database from 'better-sqlite3'
import { EventBus } from '@repo/shared/events'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { runMigrations } from '../core/db/migrations.js'
import { ConfirmationManager } from '../core/tool/confirmation-manager.js'
import { Gate } from '../core/tool/gate.js'
import type { ProviderConfigStore } from '../core/config/provider-config-store.js'
import { createPiSession, type PiSessionDeps } from '../core/agent/pi-session.js'

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
    // §10.12-1：每个线程首次创建都会新建独立 SessionManager，因此 mock 必须提供它。
    createSessionManager: vi.fn(() => ({ getSessionDir: () => '/sessions' })),
    openSessionManager: vi.fn(() => ({ getSessionDir: () => '/sessions' })),
  }
})

vi.mock('@earendil-works/pi-coding-agent', () => {
  return {
    DefaultResourceLoader: class {
      async reload() {}
    },
    createAgentSession: mocks.createAgentSession,
    SessionManager: {
      create: mocks.createSessionManager,
      open: mocks.openSessionManager,
    },
  }
})

describe('createPiSession beforeToolCall integration', () => {
  beforeEach(() => {
    mocks.agent.beforeToolCall = undefined
    mocks.agent.afterToolCall = undefined
    mocks.session.subscribe.mockClear()
    mocks.createAgentSession.mockClear()
    mocks.createSessionManager.mockClear()
    mocks.openSessionManager.mockClear()
  })

  it('TC-01: installs beforeToolCall hook on session.agent', async () => {
    await createPiSession(createDeps([
      { provider: 'openai', id: 'gpt-4.1-mini' },
    ]))

    expect(typeof mocks.session.agent.beforeToolCall).toBe('function')
  })

  it('TC-01b: chat 线程无 resumePath 时也新建独立 SessionManager', async () => {
    await createPiSession(createDeps([{ provider: 'openai', id: 'gpt-4.1-mini' }]))

    expect(mocks.createSessionManager).toHaveBeenCalledTimes(1)
    expect(mocks.openSessionManager).not.toHaveBeenCalled()
  })

  it('TC-02: selects configured OpenAI model instead of DeepSeek when both exist', async () => {
    await createPiSession(createDeps([
      { provider: 'deepseek', id: 'deepseek-chat' },
      { provider: 'openai', id: 'gpt-4.1-mini' },
    ]))

    const firstCall = mocks.createAgentSession.mock.calls[0] as unknown as [CreateAgentSessionOptionsStub] | undefined
    const options = firstCall?.[0]
    expect(options?.model).toEqual({ provider: 'openai', id: 'gpt-4.1-mini' })
  })

  it('TC-03: throws CONFIG_ERROR when configured model is missing', async () => {
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
    modelRuntime: {
      getModel: (provider: string, modelId: string) => (
        models.find((model) => model.provider === provider && model.id === modelId)
      ),
    } as unknown as ModelRuntime,
    sessionManager: { getSessionDir: () => '/sessions' } as unknown as SessionManager,
    settingsManager: {} as SettingsManager,
    providerConfigStore: {
      getApiKey: (provider: string) => provider === 'openai' ? 'test-key' : undefined,
      list: () => [{ id: 'openai', models: [{ id: 'gpt-4.1-mini' }] }],
      getDefaultProviderId: () => undefined,
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
