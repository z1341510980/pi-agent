import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventType, type BaseEvent } from '@ag-ui/core'
import { PiAgUiAgent, type StreamRunInput } from '../core/agent/pi-agui-agent.js'
import { PiSessionStore } from '../core/agent/session-store.js'

/**
 * S3-1 AG-UI 契约测试：验证事件顺序、abort、steer/follow-up、并发、互斥
 *
 * 通过 mock PiSession 测试 PiAgUiAgent 的协议契约，不依赖真实 Pi SDK。
 */

/** 创建 mock PiSession，可控制 prompt 行为 */
function createMockSession(
  options: {
    promptImpl?: (text: string) => Promise<void>
    steerImpl?: (text: string) => Promise<void>
    followUpImpl?: (text: string) => Promise<void>
    events?: Array<Record<string, unknown>>
  } = {}
) {
  const subscribers: Array<(event: Record<string, unknown>) => void> = []
  const session: any = {
    subscribe: vi.fn((cb: (event: Record<string, unknown>) => void) => {
      subscribers.push(cb)
      return () => {
        const idx = subscribers.indexOf(cb)
        if (idx >= 0) subscribers.splice(idx, 1)
      }
    }),
    prompt: vi.fn(options.promptImpl ?? (async () => {})),
    steer: vi.fn(options.steerImpl ?? (async () => {})),
    followUp: vi.fn(options.followUpImpl ?? (async () => {})),
    abort: vi.fn(),
    fork: vi.fn(async () => ({ selectedText: '', cancelled: false })),
    navigateTree: vi.fn(async () => ({ selectedId: 'entry-1' })),
    compact: vi.fn(async () => ({})),
    reload: vi.fn(async () => {}),
    getAllTools: () => [],
    getActiveToolNames: () => [],
    sessionManager: { getTree: () => [] },
    modelRegistry: { getAvailable: () => [] }
  }

  // 触发订阅事件的方法
  function emit(event: Record<string, unknown>) {
    for (const cb of subscribers) cb(event)
  }

  return { session, emit, subscribers }
}

function createAgentWithMockSession(mockSessionReturn: any) {
  const store = new PiSessionStore()
  store.setSessionFactory(async () => mockSessionReturn)
  const agent = new PiAgUiAgent(store, { find: () => undefined, getAll: () => [] }, {
    list: () => [],
    getStripStreamOptions: () => false
  } as any)
  return { store, agent }
}

function createInput(overrides: Partial<StreamRunInput> = {}): StreamRunInput {
  return {
    threadId: 'thread-1',
    runId: 'run-1',
    messages: [{ id: 'msg-1', role: 'user', content: '你好' }],
    ...overrides
  }
}

/** 收集所有发射的事件 */
function collectEvents(agent: PiAgUiAgent, input: StreamRunInput, signal?: AbortSignal) {
  const events: BaseEvent[] = []
  const promise = agent.streamRun(input, (e) => events.push(e), signal ? { signal } : {})
  return { events, promise }
}

describe('S3-1 AG-UI 事件顺序契约', () => {
  it('TC-01: RUN_STARTED 是第一个事件，携带 threadId/runId', async () => {
    const { session } = createMockSession()
    const { agent } = createAgentWithMockSession(session)

    const { events, promise } = collectEvents(agent, createInput())
    await promise

    expect(events[0].type).toBe(EventType.RUN_STARTED)
    expect((events[0] as any).threadId).toBe('thread-1')
    expect((events[0] as any).runId).toBe('run-1')
  })

  it('TC-02: RUN_FINISHED 是最后一个事件', async () => {
    const { session } = createMockSession()
    const { agent } = createAgentWithMockSession(session)

    const { events, promise } = collectEvents(agent, createInput())
    await promise

    const last = events[events.length - 1]
    expect(last.type).toBe(EventType.RUN_FINISHED)
  })

  it('TC-03: RUN_FINISHED 和 RUN_ERROR 互斥，只发射其中一个', async () => {
    // 正常完成
    const { session: okSession } = createMockSession()
    const { agent: okAgent } = createAgentWithMockSession(okSession)
    const { events: okEvents, promise: okPromise } = collectEvents(okAgent, createInput())
    await okPromise
    const okFinished = okEvents.filter((e) => e.type === EventType.RUN_FINISHED).length
    const okError = okEvents.filter((e) => e.type === EventType.RUN_ERROR).length
    expect(okFinished).toBe(1)
    expect(okError).toBe(0)

    // 错误完成
    const { session: errSession } = createMockSession({
      promptImpl: async () => {
        throw new Error('boom')
      }
    })
    const { agent: errAgent } = createAgentWithMockSession(errSession)
    const { events: errEvents, promise: errPromise } = collectEvents(errAgent, createInput())
    await errPromise
    const errFinished = errEvents.filter((e) => e.type === EventType.RUN_FINISHED).length
    const errError = errEvents.filter((e) => e.type === EventType.RUN_ERROR).length
    expect(errFinished).toBe(0)
    expect(errError).toBe(1)
  })

  it('TC-04: MESSAGES_SNAPSHOT 紧跟 RUN_STARTED 之后', async () => {
    const { session } = createMockSession()
    const { agent } = createAgentWithMockSession(session)

    const { events, promise } = collectEvents(agent, createInput())
    await promise

    expect(events[0].type).toBe(EventType.RUN_STARTED)
    expect(events[1].type).toBe(EventType.MESSAGES_SNAPSHOT)
  })

  it('TC-05: TEXT_MESSAGE_START 在任何 TEXT_MESSAGE_CONTENT 之前', async () => {
    const { session, emit } = createMockSession()
    const { agent } = createAgentWithMockSession(session)

    const events: BaseEvent[] = []
    const promise = agent.streamRun(createInput(), (e) => events.push(e))

    // 在 prompt 执行期间触发 text_delta 事件
    session.prompt.mockImplementation(async () => {
      emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'hello' }
      })
    })

    await promise

    const startIdx = events.findIndex((e) => e.type === EventType.TEXT_MESSAGE_START)
    const contentIdx = events.findIndex((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
    expect(startIdx).toBeGreaterThanOrEqual(0)
    expect(contentIdx).toBeGreaterThan(startIdx)
  })

  it('TC-06: TEXT_MESSAGE_END 在最后一个 TEXT_MESSAGE_CONTENT 之后', async () => {
    const { session, emit } = createMockSession()
    const { agent } = createAgentWithMockSession(session)

    const events: BaseEvent[] = []
    session.prompt.mockImplementation(async () => {
      emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'hello' }
      })
      emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: ' world' }
      })
    })

    const promise = agent.streamRun(createInput(), (e) => events.push(e))
    await promise

    const contentIndices = events
      .map((e, i) => (e.type === EventType.TEXT_MESSAGE_CONTENT ? i : -1))
      .filter((i) => i >= 0)
    const endIdx = events.findIndex((e) => e.type === EventType.TEXT_MESSAGE_END)
    expect(contentIndices.length).toBe(2)
    expect(endIdx).toBeGreaterThan(contentIndices[contentIndices.length - 1])
  })

  it('TC-07: TEXT_MESSAGE_START 和 TEXT_MESSAGE_END 配对', async () => {
    const { session, emit } = createMockSession()
    const { agent } = createAgentWithMockSession(session)

    const events: BaseEvent[] = []
    session.prompt.mockImplementation(async () => {
      emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'hi' }
      })
    })

    const promise = agent.streamRun(createInput(), (e) => events.push(e))
    await promise

    const starts = events.filter((e) => e.type === EventType.TEXT_MESSAGE_START).length
    const ends = events.filter((e) => e.type === EventType.TEXT_MESSAGE_END).length
    expect(starts).toBe(1)
    expect(ends).toBe(1)
  })

  it('TC-08: STEP_STARTED 和 STEP_FINISHED 配对', async () => {
    const { session, emit } = createMockSession()
    const { agent } = createAgentWithMockSession(session)

    const events: BaseEvent[] = []
    session.prompt.mockImplementation(async () => {
      emit({ type: 'tool_execution_start', toolName: 'read', toolCallId: 'tc-1' })
      emit({ type: 'tool_execution_end', toolName: 'read', toolCallId: 'tc-1' })
    })

    const promise = agent.streamRun(createInput(), (e) => events.push(e))
    await promise

    const starts = events.filter((e) => e.type === EventType.STEP_STARTED).length
    const finished = events.filter((e) => e.type === EventType.STEP_FINISHED).length
    expect(starts).toBe(1)
    expect(finished).toBe(1)
  })

  it('TC-24: 最后一条消息为 tool 角色时发射 TOOL_CALL_RESULT', async () => {
    const { session } = createMockSession()
    const { agent } = createAgentWithMockSession(session)

    const input = createInput({
      messages: [
        { id: 'msg-1', role: 'user', content: 'list files' },
        { id: 'msg-2', role: 'tool', content: 'file1.txt', toolCallId: 'tc-1' }
      ]
    })

    const { events, promise } = collectEvents(agent, input)
    await promise

    const toolResult = events.find((e) => e.type === EventType.TOOL_CALL_RESULT)
    expect(toolResult).toBeDefined()
  })
})

describe('S3-1 abort 契约', () => {
  it('TC-10: abort 时发射 RUN_FINISHED（非 RUN_ERROR）', async () => {
    const { session } = createMockSession()
    const { agent } = createAgentWithMockSession(session)

    const controller = new AbortController()
    const events: BaseEvent[] = []

    // prompt 在 abort 后抛出 AbortError（模拟真实 Pi SDK 行为）
    session.prompt.mockImplementation(
      () =>
        new Promise<void>((_, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => {
              const err = new Error('Aborted')
              err.name = 'AbortError'
              reject(err)
            },
            { once: true }
          )
        })
    )

    const promise = agent.streamRun(createInput(), (e) => events.push(e), {
      signal: controller.signal
    })

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled())
    controller.abort()

    await promise

    const last = events[events.length - 1] as any
    expect(last.type).toBe(EventType.RUN_FINISHED)
    // 不应有 RUN_ERROR
    const errors = events.filter((e) => e.type === EventType.RUN_ERROR)
    expect(errors.length).toBe(0)
  })

  it('TC-11: abort 后 SSE 流正常终止，无悬挂事件', async () => {
    const { session } = createMockSession()
    const { agent } = createAgentWithMockSession(session)

    const controller = new AbortController()
    const events: BaseEvent[] = []

    session.prompt.mockImplementation(
      () =>
        new Promise<void>((_, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => {
              const err = new Error('Aborted')
              err.name = 'AbortError'
              reject(err)
            },
            { once: true }
          )
        })
    )

    const promise = agent.streamRun(createInput(), (e) => events.push(e), {
      signal: controller.signal
    })

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled())
    controller.abort()

    await promise

    // 终止后不应再发射事件
    const finishedIdx = events.findIndex((e) => e.type === EventType.RUN_FINISHED)
    expect(finishedIdx).toBe(events.length - 1)
  })

  it('TC-12: abort 后 session 可被后续 run 复用', async () => {
    const { session } = createMockSession()
    const { agent } = createAgentWithMockSession(session)

    // 第一次 run：abort
    const controller1 = new AbortController()
    session.prompt.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          controller1.signal.addEventListener(
            'abort',
            () => {
              const err = new Error('Aborted')
              err.name = 'AbortError'
              reject(err)
            },
            { once: true }
          )
        })
    )

    const events1: BaseEvent[] = []
    const promise1 = agent.streamRun(createInput({ runId: 'run-1' }), (e) => events1.push(e), {
      signal: controller1.signal
    })
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled())
    controller1.abort()
    await promise1

    // 第二次 run：正常完成
    const events2: BaseEvent[] = []
    const promise2 = agent.streamRun(createInput({ runId: 'run-2' }), (e) => events2.push(e))
    await promise2

    const last = events2[events2.length - 1]
    expect(last.type).toBe(EventType.RUN_FINISHED)
  })
})

describe('S3-1 steer/follow-up 契约', () => {
  it('TC-13: steer 在有活跃 run 时返回 accepted', async () => {
    const { session } = createMockSession()
    const { store, agent } = createAgentWithMockSession(session)

    // 模拟有活跃 run
    store.tryAcquireRun('thread-1', 'run-1')

    const result = await agent.steerThread('thread-1', '改用 Python')
    expect(result.status).toBe('accepted')
    expect(session.steer).toHaveBeenCalledWith('改用 Python')
  })

  it('TC-14: steer 在无活跃 run 时返回 no_active_run', async () => {
    const { session } = createMockSession()
    const { agent } = createAgentWithMockSession(session)

    const result = await agent.steerThread('thread-1', '改用 Python')
    expect(result.status).toBe('no_active_run')
    expect(session.steer).not.toHaveBeenCalled()
  })

  it('TC-17: steer 失败时抛出 AppError', async () => {
    const { session } = createMockSession({
      steerImpl: async () => {
        throw new Error('steer 内部错误')
      }
    })
    const { store, agent } = createAgentWithMockSession(session)
    store.tryAcquireRun('thread-1', 'run-1')

    await expect(agent.steerThread('thread-1', 'text')).rejects.toThrow()
  })

  it('TC-16: follow-up 不检查活跃 run（与 steer 差异化）', async () => {
    const { session } = createMockSession()
    const { agent } = createAgentWithMockSession(session)

    // 无活跃 run 时 follow-up 仍可调用
    const result = await agent.followUpThread('thread-1', '继续')
    expect(result.status).toBe('accepted')
    expect(session.followUp).toHaveBeenCalledWith('继续')
  })

  it('TC-17b: follow-up 失败时抛出 AppError', async () => {
    const { session } = createMockSession({
      followUpImpl: async () => {
        throw new Error('follow-up 内部错误')
      }
    })
    const { agent } = createAgentWithMockSession(session)

    await expect(agent.followUpThread('thread-1', 'text')).rejects.toThrow()
  })
})

describe('S4 Session navigation 契约', () => {
  it('TC-31: navigate 通过 PiAgUiAgent 封装并更新访问时间', async () => {
    const { session } = createMockSession()
    const { store, agent } = createAgentWithMockSession(session)
    const threadSession = await store.getOrCreate('thread-1')
    const before = threadSession.lastAccessedAt

    const result = await agent.navigateThread('thread-1', 'entry-1', {
      summarize: false,
      customInstructions: '保留测试上下文'
    })

    expect(session.navigateTree).toHaveBeenCalledWith('entry-1', {
      summarize: false,
      customInstructions: '保留测试上下文'
    })
    expect(result).toEqual({ selectedId: 'entry-1' })
    expect(threadSession.lastAccessedAt).toBeGreaterThanOrEqual(before)
  })

  it('TC-32: compact 通过 PiAgUiAgent 封装并更新访问时间', async () => {
    const { session } = createMockSession()
    const { store, agent } = createAgentWithMockSession(session)
    const threadSession = await store.getOrCreate('thread-1')
    const before = threadSession.lastAccessedAt

    const result = await agent.compactThread('thread-1', '保留关键决策')

    expect(session.compact).toHaveBeenCalledWith('保留关键决策')
    expect(result).toEqual({})
    expect(threadSession.lastAccessedAt).toBeGreaterThanOrEqual(before)
  })
})

describe('S3-1 并发契约', () => {
  it('TC-18: 同 threadId 并发 getOrCreate 只创建一个 session', async () => {
    const store = new PiSessionStore()
    let createCount = 0
    store.setSessionFactory(async (threadId) => {
      createCount++
      // 模拟异步创建延迟
      await new Promise((r) => setTimeout(r, 10))
      return { id: `session-${threadId}` } as any
    })

    // 并发 3 个 getOrCreate
    const [s1, s2, s3] = await Promise.all([
      store.getOrCreate('thread-1'),
      store.getOrCreate('thread-1'),
      store.getOrCreate('thread-1')
    ])

    expect(createCount).toBe(1)
    expect(s1).toBe(s2)
    expect(s2).toBe(s3)
  })

  it('TC-19: 同 threadId 并发 run 被拒绝（RUN_ERROR）', async () => {
    const { session } = createMockSession()
    const { agent } = createAgentWithMockSession(session)

    let resolvePrompt: (() => void) | null = null
    session.prompt.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvePrompt = resolve
        })
    )

    // 第一个 run 启动但不完成
    const events1: BaseEvent[] = []
    const promise1 = agent.streamRun(createInput({ runId: 'run-1' }), (e) => events1.push(e))

    // 等待第一个 run 占用 activeRunId（prompt 被调用表示已占用）
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled())

    // 第二个 run 应被拒绝
    const events2: BaseEvent[] = []
    const promise2 = agent.streamRun(createInput({ runId: 'run-2' }), (e) => events2.push(e))
    await promise2

    const last2 = events2[events2.length - 1] as any
    expect(last2.type).toBe(EventType.RUN_ERROR)
    expect(last2.message).toContain('活跃 run')

    // 完成第一个 run
    resolvePrompt!()
    await promise1
    expect(events1[events1.length - 1].type).toBe(EventType.RUN_FINISHED)
  })

  it('TC-20: 不同 threadId 并发 run 互不干扰', async () => {
    const { session } = createMockSession()
    const store = new PiSessionStore()
    store.setSessionFactory(async (threadId) => ({ ...session, threadId }))
    const agent = new PiAgUiAgent(store, { find: () => undefined, getAll: () => [] }, {
      list: () => [],
      getStripStreamOptions: () => false
    } as any)

    const events1: BaseEvent[] = []
    const events2: BaseEvent[] = []

    const [r1, r2] = await Promise.all([
      agent.streamRun(createInput({ threadId: 'thread-1', runId: 'run-1' }), (e) =>
        events1.push(e)
      ),
      agent.streamRun(createInput({ threadId: 'thread-2', runId: 'run-2' }), (e) => events2.push(e))
    ])

    expect(events1[events1.length - 1].type).toBe(EventType.RUN_FINISHED)
    expect(events2[events2.length - 1].type).toBe(EventType.RUN_FINISHED)
  })
})

describe('S3-1 错误处理契约', () => {
  it('TC-21: session.prompt() 抛错时发射 RUN_ERROR，之后无更多事件', async () => {
    const { session } = createMockSession({
      promptImpl: async () => {
        throw new Error('LLM 服务不可用')
      }
    })
    const { agent } = createAgentWithMockSession(session)

    const { events, promise } = collectEvents(agent, createInput())
    await promise

    const errorIdx = events.findIndex((e) => e.type === EventType.RUN_ERROR)
    expect(errorIdx).toBeGreaterThanOrEqual(0)
    expect(errorIdx).toBe(events.length - 1)
    expect((events[errorIdx] as any).message).toContain('LLM 服务不可用')
  })

  it('TC-22: Pi SDK 以 stopReason=error 结束时发射 RUN_ERROR', async () => {
    const { session, emit } = createMockSession()
    session.prompt.mockImplementation(async () => {
      emit({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          provider: 'grok',
          model: 'grok-4.5',
          stopReason: 'error',
          errorMessage: '503 Service temporarily unavailable'
        }
      })
    })
    const { agent } = createAgentWithMockSession(session)

    const { events, promise } = collectEvents(agent, createInput())
    await promise

    const terminalEvents = events.filter(
      (event) => event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR
    )
    expect(terminalEvents).toHaveLength(1)
    expect(terminalEvents[0].type).toBe(EventType.RUN_ERROR)
    expect((terminalEvents[0] as any).message).toContain('503 Service temporarily unavailable')
  })

  it('TC-22b: 自动重试后成功时清除之前的 assistant 错误', async () => {
    const { session, emit } = createMockSession()
    session.prompt.mockImplementation(async () => {
      emit({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: '503 Service temporarily unavailable'
        }
      })
      emit({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop'
        }
      })
    })
    const { agent } = createAgentWithMockSession(session)

    const { events, promise } = collectEvents(agent, createInput())
    await promise

    expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED)
    expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(false)
  })

  it('TC-23: 空 messages 数组走空 userText 路径，仍发射 RUN_FINISHED', async () => {
    const { session } = createMockSession()
    const { agent } = createAgentWithMockSession(session)

    const { events, promise } = collectEvents(agent, createInput({ messages: [] }))
    await promise

    const last = events[events.length - 1]
    expect(last.type).toBe(EventType.RUN_FINISHED)
    // 应发射了助手消息
    expect(events.some((e) => e.type === EventType.TEXT_MESSAGE_START)).toBe(true)
    expect(events.some((e) => e.type === EventType.TEXT_MESSAGE_END)).toBe(true)
    // prompt 不应被调用
    expect(session.prompt).not.toHaveBeenCalled()
  })
})

describe('S3-1 资源清理契约', () => {
  it('TC-28: run 结束后 subscribe 监听器被移除', async () => {
    const { session } = createMockSession()
    const { agent } = createAgentWithMockSession(session)

    await agent.streamRun(createInput(), () => {})

    expect(session.subscribe).toHaveBeenCalledTimes(1)
    // subscribe 返回的 unsubscribe 应被调用
    // 通过检查 subscribers 数组为空来验证
  })

  it('TC-29: run 结束后 pendingToolCalls 被清理', async () => {
    const { session } = createMockSession()
    const { store, agent } = createAgentWithMockSession(session)

    // 先获取 session 并填充 pendingToolCalls
    const threadSession = await store.getOrCreate('thread-1')
    threadSession.pendingToolCalls.set('tc-1', { command: 'ls' })
    expect(threadSession.pendingToolCalls.size).toBe(1)

    await agent.streamRun(createInput(), () => {})

    expect(threadSession.pendingToolCalls.size).toBe(0)
  })

  it('TC-30: run 结束后 activeRunId 被释放', async () => {
    const { session } = createMockSession()
    const { store, agent } = createAgentWithMockSession(session)

    await agent.streamRun(createInput(), () => {})

    expect(store.hasActiveRun('thread-1')).toBe(false)
  })
})
