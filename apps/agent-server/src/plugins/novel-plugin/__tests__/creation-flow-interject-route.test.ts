/**
 * 插话 REST 端点 + SSE 回显 + chapterChatStore 落库测试（对话化交互形态 §3.1/§4，批次 1 任务 2/3）。
 *
 * 覆盖链路：
 * - POST /projects/:projectId/flows/:flowId/messages 校验与受理
 *   （空/超长 content 400；非法 targetAgent 400；无运行中 flow 409）；
 * - 201 + queued 响应 + chapterChatStore 落库（metadata.interject/messageId/targetAgent/flowMode）
 *   + 立即向目标 flow 的 SSE 通道推 status='queued' 事件；
 * - injected / dropped 状态：orchestrator hooks（createInterjectDispatchHooks）经注册表
 *   按 messageId/flowKey 路由到对应 flow 的推送回调；
 * - create-flow 路由级接线：启动时登记 publisher（事件落到 SSE write），终态后注销并 409。
 * - 群聊（kind='discussion'，批次 1 任务 3）：端点经 runner 登记的 engine enqueue 闭包路由；
 *   群聊无 targetAgent 语义（400 拒绝）；engine 的 injected/dropped 回调沿 create-discussion
 *   SSE 连接推送；落库 flowMode='discussion'。
 *
 * 测试策略：
 * - 端点单测沿用 creation-flow-routes.test.ts 的直调 handler 模式（mock request/reply）；
 * - 运行中 flow 用真实模块级注册表播种（registerNovelChapterTask + registerInterjectFlow），
 *   mock orchestrator 复刻任务 1 钉死的队列契约（enqueue/drain/终态 hooks）；
 * - 群聊侧 mock discussionRunner 复刻 runner 契约：engine 创建后登记 enqueue 闭包、
 *   options 携带 onInterjectInjected/onInterjectDropped（由路由接到 dispatchInterjectStatus）；
 * - SSE 事件以 publisher spy / reply.raw.write 捕获断言（等效 emitter.emit 参数校验）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCreationFlowRoutes } from '../routes/creation-flow-routes.js'
import {
  activeNovelChapterTasks,
  finishNovelChapterTask,
  registerNovelChapterTask,
  registerInterjectFlow,
  registerInterjectEnqueuer,
  unregisterInterjectFlow,
  createInterjectDispatchHooks,
  type ActiveNovelChapterTask,
} from '../utils/chapter-task-registry.js'
import type { InterjectMessage } from '../core/novel-orchestrator.js'

const PROJECT_ID = 'interject-proj'
const CHAPTER = 1
const RUN_ID = 'run-1'
const LOCK_KEY = `${PROJECT_ID}:${CHAPTER}`
const FLOW_KEY = `${PROJECT_ID}|${CHAPTER}|${RUN_ID}`
const INTERJECT_PATH = '/projects/:projectId/flows/:flowId/messages'
const CREATE_FLOW_PATH = '/projects/:projectId/chapters/:chapterNumber/create-flow'
const CREATE_DISCUSSION_PATH = '/projects/:projectId/chapters/:chapterNumber/create-discussion'

function createReply() {
  const reply = {
    statusCode: 200,
    payload: undefined as unknown,
    code: vi.fn((statusCode: number) => {
      reply.statusCode = statusCode
      return reply
    }),
    status: vi.fn((statusCode: number) => {
      reply.statusCode = statusCode
      return reply
    }),
    send: vi.fn((payload: unknown) => {
      reply.payload = payload
      return reply
    }),
  }
  return reply
}

function createSseReply() {
  const reply = createReply() as ReturnType<typeof createReply> & {
    raw: {
      writeHead: ReturnType<typeof vi.fn>
      write: ReturnType<typeof vi.fn>
      end: ReturnType<typeof vi.fn>
      once: ReturnType<typeof vi.fn>
      off: ReturnType<typeof vi.fn>
      writableEnded: boolean
    }
  }
  reply.raw = {
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    writableEnded: false,
  }
  return reply
}

function createRequest(overrides: {
  params?: Record<string, string>
  body?: unknown
  query?: Record<string, string | undefined>
} = {}) {
  const rawBody = overrides.body ?? { content: '打斗戏改用棍' }
  return {
    params: overrides.params ?? { projectId: PROJECT_ID, flowId: RUN_ID },
    body: rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)
      ? { chapterNumber: CHAPTER, ...rawBody }
      : rawBody,
    query: overrides.query ?? {},
    traceId: 'trace-interject',
    log: { warn: vi.fn(), error: vi.fn() },
  } as any
}

function interjectRequest(flowId: string, body: unknown = { content: '打斗戏改用棍' }) {
  return createRequest({ params: { projectId: PROJECT_ID, flowId }, body })
}

/** 后台 run 化之后，插话状态回显走事件流（type='agui'，payload 即原 AG-UI 事件）。 */
function collectWorkflowUserMessageEvents(store: { events: Array<{ type: string; payload: Record<string, unknown> }> }) {
  return store.events
    .filter(event => event.type === 'agui' && event.payload?.name === 'novel:user-message')
    .map(event => event.payload.value as Record<string, unknown>)
}

/** 复刻任务 1 钉死的 orchestrator 插话契约（enqueue 追加 / drain 定向取走并触发 hooks / 启动清陈旧）。 */
function createMockOrchestrator() {
  const hooks = createInterjectDispatchHooks()
  const queue: InterjectMessage[] = []
  return {
    hooks,
    queue,
    enqueueUserMessage: vi.fn((msg: Omit<InterjectMessage, 'createdAt'>) => {
      queue.push({ ...msg, createdAt: Date.now() })
      return true
    }),
    drainPendingMessages: vi.fn((nextAgentType: string, flowKey?: string) => {
      const drained = queue.filter(m =>
        (!m.targetAgent || m.targetAgent === nextAgentType)
        && (!m.flowKey || !flowKey || m.flowKey === flowKey))
      for (const m of drained) queue.splice(queue.indexOf(m), 1)
      if (drained.length > 0) hooks.onInterjectInjected?.(drained.map(m => m.id), nextAgentType)
      return drained
    }),
    clearStaleInterjectMessages: vi.fn((flowKey: string) => {
      const stale = queue.filter(m => m.flowKey === flowKey)
      if (stale.length === 0) return []
      for (const m of stale) queue.splice(queue.indexOf(m), 1)
      const ids = stale.map(m => m.id)
      hooks.onInterjectDropped?.(ids, flowKey)
      return ids
    }),
    pendingMessages: vi.fn(() => queue.slice()),
  }
}

function createServices(mockOrchestrator: ReturnType<typeof createMockOrchestrator>, chapterChatAdd?: ReturnType<typeof vi.fn>) {
  return {
    store: {
      getProject: vi.fn(() => ({ id: PROJECT_ID })),
      getChapter: vi.fn(() => ({ id: 'chapter-1', chapterNumber: CHAPTER, status: 'drafting' })),
    },
    orchestrator: mockOrchestrator as any,
    chapterChatStore: { add: chapterChatAdd ?? vi.fn() },
    workflowEventStore: createWorkflowEventStore(),
  } as any
}

/**
 * create-flow 已改为后台 run：进度（含插话状态回显）不再写 SSE，
 * 而是镜像进 novel_workflow_events。测试用这个替身同时完成"捕获 + 读取"。
 */
function createWorkflowEventStore() {
  const events: Array<{ runId: string; type: string; payload: Record<string, unknown> }> = []
  return {
    events,
    append: vi.fn((runId: string, type: string, payload: Record<string, unknown> = {}) => {
      events.push({ runId, type, payload })
    }),
    list: vi.fn(() => []),
    lastSeq: vi.fn(() => 0),
    findActiveRun: vi.fn(),
    reconcileOrphanRuns: vi.fn(() => 0),
  }
}

describe('插话端点 POST /projects/:projectId/flows/:flowId/messages', () => {
  let mockOrchestrator: ReturnType<typeof createMockOrchestrator>
  let chapterChatAdd: ReturnType<typeof vi.fn>
  let route: { handler: (request: any, reply: any) => Promise<any> }
  /** 播种态清理（模块级注册表跨用例共享，必须复位；支持多章节并发播种） */
  let seededTasks: Array<{ lockKey: string; task: ActiveNovelChapterTask }> = []
  let seededFlowKeys: string[] = []

  beforeEach(() => {
    mockOrchestrator = createMockOrchestrator()
    chapterChatAdd = vi.fn()
    const services = createServices(mockOrchestrator, chapterChatAdd)
    route = createCreationFlowRoutes(services).find(r => r.path === INTERJECT_PATH)! as typeof route
  })

  afterEach(() => {
    for (const { lockKey, task } of seededTasks) {
      finishNovelChapterTask(lockKey, task)
    }
    seededTasks = []
    for (const flowKey of seededFlowKeys) {
      unregisterInterjectFlow(flowKey)
    }
    seededFlowKeys = []
  })

  function seedRunningWorkflow(chapter: number = CHAPTER) {
    const lockKey = `${PROJECT_ID}:${chapter}`
    const flowId = chapter === CHAPTER ? RUN_ID : `run-${chapter}`
    seededTasks.push({ lockKey, task: registerNovelChapterTask(lockKey, 'workflow', flowId) })
  }

  function seedPublisher(chapter: number = CHAPTER, flowId = chapter === CHAPTER ? RUN_ID : `run-${chapter}`) {
    const publisher = vi.fn()
    const flowKey = `${PROJECT_ID}|${chapter}|${flowId}`
    seededFlowKeys.push(flowKey)
    registerInterjectFlow(flowKey, publisher)
    return publisher
  }

  // ───────────────────────── 受理 + queued 回显 ─────────────────────────

  it('201 + queued 响应 + chapterChatStore 落库 + SSE 推 queued 事件', async () => {
    seedRunningWorkflow()
    const publisher = seedPublisher()

    const reply = createReply()
    await route.handler(createRequest({ body: { content: '打斗戏改用棍', targetAgent: 'writer' } }), reply)

    expect(reply.statusCode).toBe(201)
    const payload = reply.payload as { ok: boolean; data: { flowId: string; messageId: string; status: string } }
    expect(payload.ok).toBe(true)
    expect(payload.data).toMatchObject({ flowId: RUN_ID, messageId: expect.any(String), status: 'queued' })

    // 入队参数：id 与响应一致，flowKey 定向到目标 flow
    expect(mockOrchestrator.enqueueUserMessage).toHaveBeenCalledWith({
      id: payload.data.messageId,
      content: '打斗戏改用棍',
      targetAgent: 'writer',
      flowKey: FLOW_KEY,
    })

    // 落库：role=user，metadata 携带 interject/messageId/targetAgent/flowMode（前端任务 4 按此渲染徽标）
    expect(chapterChatAdd).toHaveBeenCalledWith(expect.objectContaining({
      projectId: PROJECT_ID,
      chapterNumber: CHAPTER,
      role: 'user',
      content: '打斗戏改用棍',
      phase: 'checkpoint',
      metadata: {
        interject: true,
        messageId: payload.data.messageId,
        targetAgent: 'writer',
        flowMode: 'workflow',
        flowId: RUN_ID,
        interjectStatus: 'queued',
      },
    }))

    // SSE queued 事件：沿目标 flow 的推送回调发出
    expect(publisher).toHaveBeenCalledTimes(1)
    expect(publisher).toHaveBeenCalledWith(expect.objectContaining({
      flowId: RUN_ID,
      messageId: payload.data.messageId,
      content: '打斗戏改用棍',
      targetAgent: 'writer',
      status: 'queued',
      timestamp: expect.any(Number),
    }))
  })

  it('落库失败不阻断受理：仍 201 且 SSE queued 事件已推', async () => {
    seedRunningWorkflow()
    const publisher = seedPublisher()
    const failingAdd = vi.fn(() => { throw new Error('db locked') })
    const services = createServices(mockOrchestrator, failingAdd)
    const failingRoute = createCreationFlowRoutes(services).find(r => r.path === INTERJECT_PATH)! as typeof route

    const reply = createReply()
    await failingRoute.handler(createRequest(), reply)

    expect(reply.statusCode).toBe(201)
    expect(failingAdd).toHaveBeenCalledTimes(1)
    expect(publisher).toHaveBeenCalledTimes(1)
  })

  it('非数字 flowId 结合 body.chapterNumber 定位并精确匹配目标运行', async () => {
    const lockKey = `${PROJECT_ID}:${CHAPTER}`
    seededTasks.push({ lockKey, task: registerNovelChapterTask(lockKey, 'workflow', 'run-abc') })
    const publisher = seedPublisher(CHAPTER, 'run-abc')

    const reply = createReply()
    await route.handler(createRequest({
      params: { projectId: PROJECT_ID, flowId: 'run-abc' },
      body: { content: '结尾留悬念', chapterNumber: CHAPTER },
    }), reply)

    expect(reply.statusCode).toBe(201)
    expect(mockOrchestrator.enqueueUserMessage).toHaveBeenCalledWith(expect.objectContaining({ flowKey: `${PROJECT_ID}|${CHAPTER}|run-abc` }))
    expect(publisher).toHaveBeenCalledWith(expect.objectContaining({ flowId: 'run-abc', status: 'queued' }))
  })

  it('同章旧运行 ID 不得注入当前运行', async () => {
    seedRunningWorkflow()
    seedPublisher()

    const reply = createReply()
    await route.handler(interjectRequest('stale-run', { content: '旧运行残留反馈' }), reply)

    expect(reply.statusCode).toBe(409)
    expect((reply.payload as { error?: string }).error).toContain('flowId 已过期')
    expect(mockOrchestrator.enqueueUserMessage).not.toHaveBeenCalled()
    expect(chapterChatAdd).not.toHaveBeenCalled()
  })

  // ───────────────────────── 校验失败 400 ─────────────────────────

  it('空 content 400；超长 content 400；非法 targetAgent 400', async () => {
    seedRunningWorkflow()
    const publisher = seedPublisher()

    for (const body of [
      { content: '' },
      { content: '好'.repeat(4001) },
      { content: '合法内容', targetAgent: 'narrator' },
    ]) {
      const reply = createReply()
      await route.handler(createRequest({ body }), reply)
      expect(reply.statusCode, `body=${JSON.stringify(body).slice(0, 40)}`).toBe(400)
    }
    // 校验失败不产生任何副作用
    expect(mockOrchestrator.enqueueUserMessage).not.toHaveBeenCalled()
    expect(chapterChatAdd).not.toHaveBeenCalled()
    expect(publisher).not.toHaveBeenCalled()
  })

  it('targetAgent=memory：201 排队并保留定向元数据，供 Finalizer 结构化消费', async () => {
    seedRunningWorkflow()
    const publisher = seedPublisher()

    const reply = createReply()
    await route.handler(createRequest({ body: { content: '本章要回收伏笔', targetAgent: 'memory' } }), reply)

    expect(reply.statusCode).toBe(201)
    const payload = reply.payload as { ok: boolean; data: { messageId: string; status: string } }
    expect(payload.ok).toBe(true)
    expect(payload.data.status).toBe('queued')
    expect(mockOrchestrator.queue).toEqual([
      expect.objectContaining({
        id: payload.data.messageId,
        content: '本章要回收伏笔',
        targetAgent: 'memory',
        flowKey: FLOW_KEY,
      }),
    ])
    expect(chapterChatAdd).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ targetAgent: 'memory', interjectStatus: 'queued' }),
    }))
    expect(publisher).toHaveBeenCalledWith(expect.objectContaining({
      messageId: payload.data.messageId,
      targetAgent: 'memory',
      status: 'queued',
    }))
  })

  it('仅凭运行级 flowId 也能定位当前项目的活动任务', async () => {
    const lockKey = `${PROJECT_ID}:${CHAPTER}`
    seededTasks.push({ lockKey, task: registerNovelChapterTask(lockKey, 'workflow', 'run-direct') })
    const publisher = seedPublisher(CHAPTER, 'run-direct')
    const reply = createReply()
    await route.handler(createRequest({
      params: { projectId: PROJECT_ID, flowId: 'run-direct' },
      body: { content: '仅凭运行 ID 定位', chapterNumber: undefined },
    }), reply)
    expect(reply.statusCode).toBe(201)
    expect(mockOrchestrator.enqueueUserMessage).toHaveBeenCalledWith(expect.objectContaining({ flowKey: `${PROJECT_ID}|${CHAPTER}|run-direct` }))
    expect(publisher).toHaveBeenCalledWith(expect.objectContaining({ flowId: 'run-direct', status: 'queued' }))
  })

  // ───────────────────────── 无运行中 flow 409 ─────────────────────────

  it('无运行中 flow 409；运行中的是编排等不可插话流程同样 409', async () => {
    const reply = createReply()
    await route.handler(createRequest(), reply)
    expect(reply.statusCode).toBe(409)
    expect(mockOrchestrator.enqueueUserMessage).not.toHaveBeenCalled()

    // 编排/反推等流程没有插话 drain/终态收尾通道，视为不可插话
    // （群聊 kind='discussion' 已接入插话通道，见下方群聊用例）
    seededTasks.push({ lockKey: LOCK_KEY, task: registerNovelChapterTask(LOCK_KEY, 'ai-arrange') })
    const replyArrange = createReply()
    await route.handler(createRequest(), replyArrange)
    expect(replyArrange.statusCode).toBe(409)
    expect(mockOrchestrator.enqueueUserMessage).not.toHaveBeenCalled()
  })

  // ───────────────────────── injected / dropped 状态回显 ─────────────────────────

  it('injected：drain 消费插话后，hooks 按 messageId 路由推送 injected 事件', async () => {
    seedRunningWorkflow()
    const publisher = seedPublisher()

    const reply = createReply()
    await route.handler(createRequest({ body: { content: '多写点对话' } }), reply)
    const messageId = (reply.payload as { data: { messageId: string } }).data.messageId
    expect(publisher).toHaveBeenCalledTimes(1)

    // 模拟 orchestrator runAgentOnce 内的 drain（消费 + 触发 onInterjectInjected）
    const drained = mockOrchestrator.drainPendingMessages('director', FLOW_KEY)
    expect(drained.map(m => m.id)).toEqual([messageId])

    expect(publisher).toHaveBeenCalledTimes(2)
    expect(publisher).toHaveBeenLastCalledWith(expect.objectContaining({
      messageId,
      content: '多写点对话',
      status: 'injected',
      agentType: 'director',
      timestamp: expect.any(Number),
    }))
    // 已消费的插话不再流转（重复 drain 不重复推事件）
    expect(mockOrchestrator.drainPendingMessages('director', FLOW_KEY)).toEqual([])
    expect(publisher).toHaveBeenCalledTimes(2)
  })

  it('dropped：flow 终态回调 onInterjectDropped 后推送 dropped 事件', async () => {
    seedRunningWorkflow()
    const publisher = seedPublisher()

    const reply = createReply()
    await route.handler(createRequest({ body: { content: '来不及注入的反馈', targetAgent: 'reviser' } }), reply)
    const messageId = (reply.payload as { data: { messageId: string } }).data.messageId

    // 模拟 orchestrator createChapterWithFlow finally 的终态收尾回调
    mockOrchestrator.hooks.onInterjectDropped?.([messageId], FLOW_KEY)

    expect(publisher).toHaveBeenLastCalledWith(expect.objectContaining({
      messageId,
      content: '来不及注入的反馈',
      targetAgent: 'reviser',
      status: 'dropped',
      timestamp: expect.any(Number),
    }))
  })

  // ───────────────────────── 并发 flow 隔离 ─────────────────────────

  it('并发章节 flow 隔离：A drain 后 injected 事件按 messageId 只路由到 A 的 emitter，不串台到 B', async () => {
    const CHAPTER_B = 2
    const flowKeyA = `${PROJECT_ID}|${CHAPTER}|${RUN_ID}`
    const flowKeyB = `${PROJECT_ID}|${CHAPTER_B}|run-2`
    seedRunningWorkflow(CHAPTER)
    seedRunningWorkflow(CHAPTER_B)
    const publisherA = seedPublisher(CHAPTER)
    const publisherB = seedPublisher(CHAPTER_B)

    // 两个运行实例各自受理一条插话（flowId=RUN_STARTED.runId）
    const replyA = createReply()
    await route.handler(createRequest({
      params: { projectId: PROJECT_ID, flowId: RUN_ID },
      body: { content: '第一章的中途反馈' },
    }), replyA)
    const replyB = createReply()
    await route.handler(createRequest({
      params: { projectId: PROJECT_ID, flowId: 'run-2' },
      body: { content: '第二章的中途反馈', chapterNumber: CHAPTER_B },
    }), replyB)
    expect(replyA.statusCode).toBe(201)
    expect(replyB.statusCode).toBe(201)
    const messageIdA = (replyA.payload as { data: { messageId: string } }).data.messageId
    const messageIdB = (replyB.payload as { data: { messageId: string } }).data.messageId
    expect(messageIdA).not.toBe(messageIdB)

    // queued 事件各归各通道
    expect(publisherA).toHaveBeenCalledTimes(1)
    expect(publisherB).toHaveBeenCalledTimes(1)

    // flowA 的 director drain：只消费 flowA 定向的插话
    const drainedA = mockOrchestrator.drainPendingMessages('director', flowKeyA)
    expect(drainedA.map(m => m.id)).toEqual([messageIdA])

    // injected 事件按 messageId 路由：A 收到，B 不收到 A 的
    expect(publisherA).toHaveBeenCalledTimes(2)
    expect(publisherA).toHaveBeenLastCalledWith(expect.objectContaining({
      messageId: messageIdA,
      status: 'injected',
      agentType: 'director',
    }))
    expect(publisherB).toHaveBeenCalledTimes(1)
    expect(publisherB.mock.calls.flat().some(event => (event as { messageId?: string }).messageId === messageIdA)).toBe(false)

    // flowB drain：B 收到自己的 injected，A 不再收到任何 B 的事件
    mockOrchestrator.drainPendingMessages('director', flowKeyB)
    expect(publisherB).toHaveBeenCalledTimes(2)
    expect(publisherB).toHaveBeenLastCalledWith(expect.objectContaining({
      messageId: messageIdB,
      status: 'injected',
      agentType: 'director',
    }))
    expect(publisherA).toHaveBeenCalledTimes(2)
    expect(publisherA.mock.calls.flat().some(event => (event as { messageId?: string }).messageId === messageIdB)).toBe(false)
  })
})

describe('create-flow 路由级插话接线（后台 run + 事件流）', () => {
  let seededTask: { lockKey: string; task: ActiveNovelChapterTask } | undefined
  let seededFlowKey: string | undefined

  afterEach(() => {
    if (seededTask) {
      finishNovelChapterTask(seededTask.lockKey, seededTask.task)
      seededTask = undefined
    }
    if (seededFlowKey) unregisterInterjectFlow(seededFlowKey)
    seededFlowKey = undefined
  })

  it('create-flow 启动即登记 publisher：插话状态落事件流；flow 终态注销后再插话 409', async () => {
    const mockOrchestrator = createMockOrchestrator()
    let resolveFlow!: (value: unknown) => void
    const createChapterWithFlow = vi.fn(() => new Promise(resolve => { resolveFlow = resolve }))
    const services = {
      ...createServices(mockOrchestrator),
      orchestrator: { ...mockOrchestrator, createChapterWithFlow } as any,
    }
    const routes = createCreationFlowRoutes(services)
    const createFlowRoute = routes.find(r => r.path === CREATE_FLOW_PATH)! as { handler: (request: any, reply: any) => Promise<any> }
    const interjectRoute = routes.find(r => r.path === INTERJECT_PATH)! as { handler: (request: any, reply: any) => Promise<any> }

    // 启动 create-flow：orchestrator 挂起模拟后台运行中
    const acceptedReply = createSseReply()
    await createFlowRoute.handler({
      params: { projectId: PROJECT_ID, chapterNumber: String(CHAPTER) },
      body: {},
      headers: {},
      query: {},
      traceId: 'trace-flow',
      raw: { socket: { setNoDelay: vi.fn() } },
      log: { error: vi.fn(), warn: vi.fn() },
    } as any, acceptedReply as any)

    // T8：受理即 202 + runId，执行转后台（不再占用本请求）
    expect(acceptedReply.statusCode).toBe(202)
    expect(acceptedReply.payload).toMatchObject({
      ok: true,
      runId: expect.any(String),
      eventsPath: expect.stringContaining('/workflow-runs/'),
    })
    expect(createChapterWithFlow).toHaveBeenCalledTimes(1)
    const activeTask = activeNovelChapterTasks.get(LOCK_KEY)
    expect(activeTask?.kind).toBe('workflow')
    expect(activeTask?.flowId).toEqual(expect.any(String))
    seededFlowKey = `${PROJECT_ID}|${CHAPTER}|${activeTask!.flowId}`
    // 启动路径接线陈旧插话清理：清上一 flow 竞态窗口残留（本例无残留 → 空）
    expect(mockOrchestrator.clearStaleInterjectMessages).toHaveBeenCalledWith(seededFlowKey)

    // 运行中插话：201，且 queued 事件经登记的 publisher 落到本 run 的事件流
    const reply = createReply()
    await interjectRoute.handler(createRequest({ params: { projectId: PROJECT_ID, flowId: activeTask!.flowId }, body: { content: '中途反馈' } }), reply)
    expect(reply.statusCode).toBe(201)

    const userMessageEvents = collectWorkflowUserMessageEvents(services.workflowEventStore)
    expect(userMessageEvents).toHaveLength(1)
    expect(userMessageEvents[0]).toMatchObject({
      flowId: activeTask!.flowId,
      messageId: (reply.payload as { data: { messageId: string } }).data.messageId,
      content: '中途反馈',
      status: 'queued',
      timestamp: expect.any(Number),
    })

    // flow 到达终态：注册表注销（finishNovelChapterTask + unregisterInterjectFlow）
    resolveFlow({ status: 'completed', stateChanges: [] })
    await vi.waitFor(() => expect(activeNovelChapterTasks.has(LOCK_KEY)).toBe(false))

    // 终态后再插话 → 409（无运行中 workflow）
    const afterReply = createReply()
    await interjectRoute.handler(createRequest({ params: { projectId: PROJECT_ID, flowId: activeTask!.flowId } }), afterReply)
    expect(afterReply.statusCode).toBe(409)
  })
})

// ═══════════════════════════════════════════════════════════════
// 群聊插话（kind='discussion'，批次 1 任务 3）
// ═══════════════════════════════════════════════════════════════

describe('群聊插话端点（kind=discussion）', () => {
  let chapterChatAdd: ReturnType<typeof vi.fn>
  let route: { handler: (request: any, reply: any) => Promise<any> }
  /** 播种态清理（模块级注册表跨用例共享，必须复位） */
  let seededTasks: Array<{ lockKey: string; task: ActiveNovelChapterTask }> = []
  let seededFlowKeys: string[] = []

  beforeEach(() => {
    chapterChatAdd = vi.fn()
    const services = {
      store: {
        getProject: vi.fn(() => ({ id: PROJECT_ID })),
        getChapter: vi.fn(() => ({ id: 'chapter-1', chapterNumber: CHAPTER, status: 'drafting' })),
      },
      orchestrator: createMockOrchestrator() as any,
      chapterChatStore: { add: chapterChatAdd },
      discussionEventStore: { append: vi.fn(), list: vi.fn(() => []), lastSeq: vi.fn(() => 0) },
      workflowEventStore: createWorkflowEventStore(),
    } as any
    route = createCreationFlowRoutes(services).find(r => r.path === INTERJECT_PATH)! as typeof route
  })

  afterEach(() => {
    for (const { lockKey, task } of seededTasks) {
      finishNovelChapterTask(lockKey, task)
    }
    seededTasks = []
    for (const flowKey of seededFlowKeys) {
      unregisterInterjectFlow(flowKey)
    }
    seededFlowKeys = []
  })

  function seedRunningDiscussion(chapter: number = CHAPTER) {
    const lockKey = `${PROJECT_ID}:${chapter}`
    const flowId = chapter === CHAPTER ? RUN_ID : `run-${chapter}`
    seededTasks.push({ lockKey, task: registerNovelChapterTask(lockKey, 'discussion', flowId) })
  }

  function seedEnqueuer(chapter: number = CHAPTER, flowId = chapter === CHAPTER ? RUN_ID : `run-${chapter}`) {
    const queue: Array<{ id: string; content: string; createdAt: number }> = []
    const flowKey = `${PROJECT_ID}|${chapter}|${flowId}`
    seededFlowKeys.push(flowKey)
    registerInterjectEnqueuer(flowKey, msg => {
      queue.push(msg)
      return true
    })
    return queue
  }

  /** 登记已收尾的 enqueuer（engine 存活标记失效，投递返回 false） */
  function seedDeadEnqueuer(chapter: number = CHAPTER, flowId = chapter === CHAPTER ? RUN_ID : `run-${chapter}`) {
    const flowKey = `${PROJECT_ID}|${chapter}|${flowId}`
    seededFlowKeys.push(flowKey)
    registerInterjectEnqueuer(flowKey, () => false)
  }

  function seedPublisherSpy(chapter: number = CHAPTER, flowId = chapter === CHAPTER ? RUN_ID : `run-${chapter}`) {
    const publisher = vi.fn()
    const flowKey = `${PROJECT_ID}|${chapter}|${flowId}`
    seededFlowKeys.push(flowKey)
    registerInterjectFlow(flowKey, publisher)
    return publisher
  }

  it('discussion 插话 201 + queued：经 engine enqueue 闭包入队，落库 flowMode=discussion，SSE 推 queued（无 targetAgent）', async () => {
    seedRunningDiscussion()
    const enqueuerQueue = seedEnqueuer()
    const publisher = seedPublisherSpy()

    const reply = createReply()
    await route.handler(createRequest({ body: { content: '群聊中途反馈：多写点对话' } }), reply)

    expect(reply.statusCode).toBe(201)
    const payload = reply.payload as { ok: boolean; data: { flowId: string; messageId: string; status: string } }
    expect(payload.data).toMatchObject({ flowId: RUN_ID, messageId: expect.any(String), status: 'queued' })

    // 入队：投递到 runner 登记的 engine enqueue 闭包（不走 orchestrator 队列）
    expect(enqueuerQueue).toEqual([{
      id: payload.data.messageId,
      content: '群聊中途反馈：多写点对话',
      createdAt: expect.any(Number),
    }])

    // 落库：role=user，metadata 携带 interject/messageId，flowMode 用群聊既有标签
    expect(chapterChatAdd).toHaveBeenCalledWith(expect.objectContaining({
      projectId: PROJECT_ID,
      chapterNumber: CHAPTER,
      role: 'user',
      content: '群聊中途反馈：多写点对话',
      phase: 'discussion',
      metadata: {
        interject: true,
        messageId: payload.data.messageId,
        flowMode: 'discussion',
        flowId: RUN_ID,
        interjectStatus: 'queued',
      },
    }))

    // SSE queued 事件：无 targetAgent 字段（群聊无定向语义）
    expect(publisher).toHaveBeenCalledTimes(1)
    expect(publisher).toHaveBeenCalledWith(expect.objectContaining({
      flowId: RUN_ID,
      messageId: payload.data.messageId,
      content: '群聊中途反馈：多写点对话',
      status: 'queued',
      timestamp: expect.any(Number),
    }))
    expect((publisher.mock.calls[0][0] as Record<string, unknown>).targetAgent).toBeUndefined()
  })

  it('discussion 插话带 targetAgent → 400（Moderator 自主决定响应，无定向语义），不产生任何副作用', async () => {
    seedRunningDiscussion()
    const enqueuerQueue = seedEnqueuer()
    const publisher = seedPublisherSpy()

    const reply = createReply()
    await route.handler(createRequest({ body: { content: '定向给导演', targetAgent: 'director' } }), reply)

    expect(reply.statusCode).toBe(400)
    const payload = reply.payload as { ok: boolean; error?: string }
    expect(payload.ok).toBe(false)
    expect(payload.error).toContain('targetAgent')
    expect(enqueuerQueue).toHaveLength(0)
    expect(chapterChatAdd).not.toHaveBeenCalled()
    expect(publisher).not.toHaveBeenCalled()
  })

  it('discussion 任务已注册但 engine 尚未就绪（无 enqueue 闭包）→ 409', async () => {
    seedRunningDiscussion()
    // 不 seedEnqueuer：模拟 runner 创建 engine 前的极小竞态窗口
    const reply = createReply()
    await route.handler(createRequest(), reply)
    expect(reply.statusCode).toBe(409)
    expect(chapterChatAdd).not.toHaveBeenCalled()
  })

  it('discussion 插话投递返回 false（engine 已收尾的 TOCTOU 微窗口）→ 409，不落库不推事件', async () => {
    seedRunningDiscussion()
    seedDeadEnqueuer()
    const publisher = seedPublisherSpy()

    const reply = createReply()
    await route.handler(createRequest({ body: { content: '收尾窗口内的插话' } }), reply)

    // 闭包存活标记失效：端点按已收尾拒绝，消息不进死队列（SSE 不会永停 queued）
    expect(reply.statusCode).toBe(409)
    const payload = reply.payload as { ok: boolean; error?: string }
    expect(payload.ok).toBe(false)
    expect(payload.error).toContain('已收尾')
    expect(chapterChatAdd).not.toHaveBeenCalled()
    expect(publisher).not.toHaveBeenCalled()
  })
})

describe('create-discussion 路由级插话接线（SSE write 捕获）', () => {
  /**
   * mock discussionRunner 复刻 runner 契约（novel-discussion-runner.ts）：
   * - engine 创建成功即把 enqueue 闭包登记到共享注册表（registerInterjectEnqueuer）；
   * - options 携带路由接线的 onInterjectInjected/onInterjectDropped（engine drain/收尾时回调）。
   */
  function createDiscussionServices() {
    const enqueuerQueue: Array<{ id: string; content: string; createdAt: number }> = []
    let capturedRunnerOptions: any
    let resolveFlow!: (value: unknown) => void
    const eventAppends: Array<{ runId: string; type: string; payload: Record<string, unknown> }> = []
    const services = {
      store: {
        getProject: vi.fn(() => ({ id: PROJECT_ID })),
        getChapter: vi.fn(() => ({ id: 'chapter-1', chapterNumber: CHAPTER, status: 'drafting' })),
        getNovelModelId: vi.fn(() => undefined),
      },
      orchestrator: createMockOrchestrator() as any,
      discussionRunner: {
        run: vi.fn((projectId: string, chapterNumber: number, options: any) => {
          capturedRunnerOptions = options
          registerInterjectEnqueuer(options.flowKey, msg => {
            enqueuerQueue.push(msg)
            return true
          })
          return new Promise(resolve => { resolveFlow = resolve })
        }),
      } as any,
      discussionSettingsStore: { get: vi.fn(() => ({})) } as any,
      discussionRunStore: { save: vi.fn() } as any,
      discussionEventStore: {
        append: vi.fn((runId: string, type: string, payload: Record<string, unknown> = {}) => {
          eventAppends.push({ runId, type, payload })
        }),
        list: vi.fn(() => []),
        lastSeq: vi.fn(() => 0),
      } as any,
      chapterChatStore: { add: vi.fn(), addMany: vi.fn() } as any,
      confirmationManager: { listPending: vi.fn(() => []), requestDecision: vi.fn() } as any,
    } as any
    return {
      services,
      enqueuerQueue,
      runnerOptions: () => capturedRunnerOptions,
      resolveFlow: (value: unknown) => resolveFlow(value),
      eventAppends,
    }
  }

  function collectUserMessageEvents(sseReply: ReturnType<typeof createSseReply>) {
    return sseReply.raw.write.mock.calls
      .map(([data]) => String(data))
      .filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice('data: '.length)))
      .filter(event => event?.name === 'novel:user-message')
      .map(event => event.value)
  }

  function createSseRequest() {
    return {
      params: { projectId: PROJECT_ID, chapterNumber: String(CHAPTER) },
      body: {},
      headers: {},
      query: {},
      traceId: 'trace-discussion',
      raw: { socket: { setNoDelay: vi.fn() } },
      log: { error: vi.fn(), warn: vi.fn() },
    } as any
  }

  afterEach(() => {
    const task = activeNovelChapterTasks.get(LOCK_KEY)
    if (task) finishNovelChapterTask(LOCK_KEY, task)
    if (task) unregisterInterjectFlow(`${PROJECT_ID}|${CHAPTER}|${task.flowId}`)
  })

  it('injected：后台 run 中插话 201，queued/injected 状态落事件流；终态后再插话 409', async () => {
    const { services, enqueuerQueue, runnerOptions, resolveFlow, eventAppends } = createDiscussionServices()
    const routes = createCreationFlowRoutes(services)
    const discussionRoute = routes.find(r => r.path === CREATE_DISCUSSION_PATH)! as { handler: (request: any, reply: any) => Promise<any> }
    const interjectRoute = routes.find(r => r.path === INTERJECT_PATH)! as { handler: (request: any, reply: any) => Promise<any> }

    // 启动 create-discussion：T6 后台执行，受理即 202 + runId（runner 挂起模拟运行中）
    const reply202 = createReply()
    await discussionRoute.handler(createSseRequest(), reply202 as any)
    expect(reply202.statusCode).toBe(202)
    expect(reply202.payload).toMatchObject({ ok: true, runId: expect.any(String), eventsPath: expect.any(String) })
    expect(services.discussionRunner.run).toHaveBeenCalledTimes(1)
    const activeTask = activeNovelChapterTasks.get(LOCK_KEY)
    expect(activeTask?.kind).toBe('discussion')
    const flowId = activeTask!.flowId
    // run_started 同步入流，202 前事件流即可定位
    expect(eventAppends.some(e => e.runId === flowId && e.type === 'run_started')).toBe(true)

    // 运行中插话：201，消息经 runner 登记的 enqueue 闭包进入 engine 队列
    const reply = createReply()
    await interjectRoute.handler(interjectRequest(flowId, { content: '群聊运行中的反馈' }), reply)
    expect(reply.statusCode).toBe(201)
    const messageId = (reply.payload as { data: { messageId: string } }).data.messageId
    expect(enqueuerQueue.map(m => m.id)).toEqual([messageId])

    // queued 状态经 publisher → emitter → agui mirror 落事件流（与旧 SSE 同一事件契约）
    const queuedMirror = eventAppends.find(e => e.runId === flowId
      && e.type === 'agui'
      && (e.payload as { name?: string; value?: { status?: string; messageId?: string } }).name === 'novel:user-message'
      && (e.payload as { value?: { status?: string; messageId?: string } }).value?.status === 'queued'
      && (e.payload as { value?: { messageId?: string } }).value?.messageId === messageId)
    expect(queuedMirror).toBeDefined()

    // 模拟一轮 engine drain：onInterjectInjected 回调把 injected 状态经同一通道落事件流
    runnerOptions().onInterjectInjected([messageId])
    const injectedMirror = eventAppends.find(e => e.runId === flowId
      && e.type === 'agui'
      && (e.payload as { name?: string; value?: { status?: string; messageId?: string } }).name === 'novel:user-message'
      && (e.payload as { value?: { status?: string; messageId?: string } }).value?.status === 'injected'
      && (e.payload as { value?: { messageId?: string } }).value?.messageId === messageId)
    expect(injectedMirror).toBeDefined()

    // flow 终态：后台 executeRun 补 run_finished 并清理任务表
    resolveFlow({ status: 'completed', transcript: [], scenes: [] })
    await vi.waitFor(() => expect(eventAppends.some(e =>
      e.runId === flowId && e.type === 'run_finished' && e.payload.status === 'completed')).toBe(true))
    expect(activeNovelChapterTasks.get(LOCK_KEY)).toBeUndefined()

    // 终态后再插话 → 409（无运行中 discussion）
    const afterReply = createReply()
    await interjectRoute.handler(interjectRequest(flowId), afterReply)
    expect(afterReply.statusCode).toBe(409)
  })

  it('dropped：engine 收尾 flush 的未消费插话，dropped 状态落事件流', async () => {
    const { services, runnerOptions, resolveFlow, eventAppends } = createDiscussionServices()
    const routes = createCreationFlowRoutes(services)
    const discussionRoute = routes.find(r => r.path === CREATE_DISCUSSION_PATH)!
    const interjectRoute = routes.find(r => r.path === INTERJECT_PATH)!
    void discussionRoute

    const reply202 = createReply()
    await discussionRoute.handler(createSseRequest(), reply202 as any)
    expect(reply202.statusCode).toBe(202)
    const flowId = activeNovelChapterTasks.get(LOCK_KEY)!.flowId

    const reply = createReply()
    await interjectRoute.handler(interjectRequest(flowId, { content: '来不及注入的群聊反馈' }), reply)
    expect(reply.statusCode).toBe(201)
    const messageId = (reply.payload as { data: { messageId: string } }).data.messageId

    // 模拟 engine 收尾（runDiscussion finally 的 flushInterjectDropped）：
    // 未被消费的插话以 dropped 回调暴露，状态经 agui mirror 落事件流
    runnerOptions().onInterjectDropped([messageId])
    const droppedMirror = eventAppends.find(e => e.runId === flowId
      && e.type === 'agui'
      && (e.payload as { name?: string; value?: { status?: string; messageId?: string } }).name === 'novel:user-message'
      && (e.payload as { value?: { status?: string; messageId?: string } }).value?.status === 'dropped'
      && (e.payload as { value?: { messageId?: string } }).value?.messageId === messageId)
    expect(droppedMirror).toBeDefined()

    resolveFlow({ status: 'completed', transcript: [], scenes: [] })
    await vi.waitFor(() => expect(eventAppends.some(e =>
      e.runId === flowId && e.type === 'run_finished')).toBe(true))
  })
})
