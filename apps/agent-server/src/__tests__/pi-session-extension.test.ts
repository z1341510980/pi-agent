/**
 * P0-0: 验证 Pi Extension 的 tool_call / tool_result 事件被产品编排器保留
 *
 * 问题：pi-session.ts 曾直接覆盖 session.agent.beforeToolCall / afterToolCall，
 * 导致 SDK 原生安装的 Extension 管道被绕过。
 *
 * 修复后：原生回调被捕获进唯一的产品编排器，工具调用时先走原生管道。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import Database from 'better-sqlite3'
import { EventBus } from '@repo/shared/events'
import { runMigrations } from '../core/db/migrations.js'
import { ConfirmationManager } from '../core/tool/confirmation-manager.js'
import { Gate } from '../core/tool/gate.js'
import type { ProviderConfigStore } from '../core/config/provider-config-store.js'
import { createPiSession, type PiSessionDeps } from '../core/agent/pi-session.js'

interface MockAgent {
  beforeToolCall?: unknown
  afterToolCall?: unknown
  // 记录原生回调是否被调用
  _nativeBeforeCalled?: boolean
  _nativeAfterCalled?: boolean
}

interface MockSession {
  agent: MockAgent
  subscribe: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => {
  const agent: MockAgent = {
    beforeToolCall: undefined,
    afterToolCall: undefined,
    _nativeBeforeCalled: false,
    _nativeAfterCalled: false,
  }

  const session: MockSession = {
    agent,
    subscribe: vi.fn(),
  }

  // SDK 的 createAgentSession 会安装一个原生 beforeToolCall
  // 我们模拟这个行为：安装一个会设置 _nativeBeforeCalled 的回调
  const createAgentSession = vi.fn(async () => {
    // 模拟 SDK 安装原生 beforeToolCall
    agent.beforeToolCall = async () => {
      agent._nativeBeforeCalled = true
      return undefined // 继续执行
    }
    agent.afterToolCall = async () => {
      agent._nativeAfterCalled = true
      return undefined
    }
    return { session }
  })
  const createBashToolDefinition = vi.fn(() => ({ name: 'bash' }))
  const defineTool = vi.fn((tool: unknown) => tool)

  return {
    agent,
    session,
    createAgentSession,
    createBashToolDefinition,
    defineTool,
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
    createBashToolDefinition: mocks.createBashToolDefinition,
    defineTool: mocks.defineTool,
    SessionManager: {
      create: mocks.createSessionManager,
      open: mocks.openSessionManager,
    },
  }
})

describe('P0-0: Pi Extension 管道保留', () => {
  beforeEach(() => {
    mocks.agent.beforeToolCall = undefined
    mocks.agent.afterToolCall = undefined
    mocks.agent._nativeBeforeCalled = false
    mocks.agent._nativeAfterCalled = false
    mocks.session.subscribe.mockClear()
    mocks.createAgentSession.mockClear()
    mocks.createSessionManager.mockClear()
    mocks.openSessionManager.mockClear()
  })

  // ============================================================
  // 原生回调是否被保留：只有真正发起一次工具调用才能验证。
  // 仅在 createPiSession 之后检查布尔值是无效断言 —— 回调只在
  // 工具执行窗口内被触发。
  // ============================================================
  it('TC-01: 产品编排器执行时原生 Extension 的 tool_call 被调用', async () => {
    await createPiSession(createDeps())

    const orchestrator = mocks.session.agent.beforeToolCall as unknown as (
      params: unknown
    ) => Promise<unknown>
    expect(typeof orchestrator).toBe('function')

    await orchestrator({
      toolCall: { id: 'call-1', name: 'read' },
      args: {},
      context: {},
    })

    expect(mocks.agent._nativeBeforeCalled).toBe(true)
  })

  it('TC-02: 产品编排器执行时原生 Extension 的 tool_result 被调用', async () => {
    await createPiSession(createDeps())

    const orchestrator = mocks.session.agent.afterToolCall as unknown as (
      context: unknown
    ) => Promise<unknown>
    expect(typeof orchestrator).toBe('function')

    await orchestrator({
      toolCall: { id: 'call-1', name: 'read' },
      args: {},
      result: { content: [] },
      isError: false,
    })

    expect(mocks.agent._nativeAfterCalled).toBe(true)
  })

  it('TC-03: beforeToolCall 仍然被安装（产品功能保留）', async () => {
    await createPiSession(createDeps())

    // 产品代码安装了 beforeToolCall（Gate + Confirmation）
    expect(typeof mocks.session.agent.beforeToolCall).toBe('function')
  })

  it('TC-04: afterToolCall 仍然被安装（产品功能保留）', async () => {
    await createPiSession(createDeps())

    expect(typeof mocks.session.agent.afterToolCall).toBe('function')
  })
})

function createDeps(): PiSessionDeps {
  const db = new Database(':memory:')
  runMigrations(db)
  return {
    threadId: 'thread-1',
    modelRuntime: {
      getModel: () => ({ provider: 'openai', id: 'gpt-4.1-mini' }),
    } as unknown as ModelRuntime,
    sessionManager: { getSessionDir: () => '/sessions' } as unknown as SessionManager,
    settingsManager: {} as SettingsManager,
    providerConfigStore: {
      getApiKey: () => 'test-key',
      list: () => [{ id: 'openai', models: [{ id: 'gpt-4.1-mini' }] }],
      getDefaultProviderId: () => undefined,
    } as unknown as ProviderConfigStore,
    getApiKey: async () => 'test-key',
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
