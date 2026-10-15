import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationManager } from '../../../core/tool/confirmation-manager.js'
import { createCreationFlowRoutes } from '../routes/creation-flow-routes.js'
import { NOVEL_AGENT_CONFIGS } from '../core/domain/novel-agents.js'
import { finishNovelChapterTask, registerNovelChapterTask, activeNovelChapterTasks } from '../utils/chapter-task-registry.js'

function createReply() {
  const reply = {
    statusCode: 200,
    payload: undefined as unknown,
    code: vi.fn((statusCode: number) => {
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
      on: ReturnType<typeof vi.fn>
      once: ReturnType<typeof vi.fn>
      off: ReturnType<typeof vi.fn>
      writableEnded: boolean
    }
  }
  reply.raw = {
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    writableEnded: false,
  }
  return reply
}

/**
 * create-flow / resume 现在跑在后台（2026-10 脱离 HTTP 生命周期），
 * 进度与终态经事件流下发。测试用这个替身接住 append 调用。
 */
function createWorkflowEventStore() {
  return {
    append: vi.fn(),
    list: vi.fn(() => []),
    lastSeq: vi.fn(() => 0),
    findActiveRun: vi.fn(),
    reconcileOrphanRuns: vi.fn(() => 0),
  }
}

describe('creation-flow checkpoint decisions', () => {
  it('rejects an arbitrary or stale action before messages or run state are changed', async () => {
    const confirmationManager = new ConfirmationManager({ emit: vi.fn() } as any, { timeoutMs: 0 })
    const decisionPromise = confirmationManager.requestDecision({
      threadId: 'novel-checkpoint-project-1',
      toolCallId: 'tool-1',
      toolName: 'checkpoint_review',
      args: {
        checkpoint: {
          type: 'review',
          options: ['approve', 'revise', 'reject'],
        },
      },
      reason: 'test',
    }, 0)
    const pending = confirmationManager.listPending()[0]!
    const setUserMessages = vi.fn()
    const add = vi.fn()
    const services = {
      store: {},
      confirmationManager,
      orchestrator: { setUserMessages },
      chapterChatStore: { add },
    } as any
    const route = createCreationFlowRoutes(services).find(item => (
      item.path === '/projects/:projectId/checkpoint/:checkpointId/decision'
    ))!
    const reply = createReply()

    const result = await route.handler({
      params: { projectId: 'project', checkpointId: pending.id },
      body: { decision: 'rewrite', userMessages: ['stale client message'] },
    } as any, reply as any)

    expect(reply.statusCode).toBe(400)
    expect(reply.payload).toMatchObject({ ok: false })
    expect(setUserMessages).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
    expect(confirmationManager.listPending()).toHaveLength(1)

    confirmationManager.respondDecision(pending.id, 'reject')
    await expect(decisionPromise).resolves.toBe('reject')
  })
})

describe('chapter SSE route preconditions', () => {
  const cases = [
    {
      path: '/projects/:projectId/chapters/:chapterNumber/create-flow',
      body: {},
      forbiddenCall: 'createChapterWithFlow',
    },
    {
      path: '/projects/:projectId/chapters/:chapterNumber/re-revise',
      body: { content: '待修订正文' },
      forbiddenCall: 'reviseOnly',
    },
    {
      path: '/projects/:projectId/chapters/:chapterNumber/create-discussion',
      body: {},
      forbiddenCall: 'discussionRun',
    },
    {
      path: '/projects/:projectId/chapters/:chapterNumber/ai-arrange',
      body: {},
      forbiddenCall: 'generateAndArrange',
    },
    {
      path: '/projects/:projectId/chapters/:chapterNumber/reverse-arrange',
      body: {},
      forbiddenCall: 'generateAndArrange',
    },
  ] as const

  for (const testCase of cases) {
    it(`${testCase.path} rejects a missing chapter before opening SSE or invoking agents`, async () => {
      const createChapterWithFlow = vi.fn()
      const reviseOnly = vi.fn()
      const discussionRun = vi.fn()
      const generateAndArrange = vi.fn()
      const services = {
        store: {
          getProject: vi.fn(() => ({ id: 'project-1' })),
          getChapter: vi.fn(() => undefined),
        },
        orchestrator: { createChapterWithFlow, reviseOnly },
        discussionRunner: { run: discussionRun },
        entityGenerator: { generateAndArrange },
      } as any
      const route = createCreationFlowRoutes(services).find(item => item.path === testCase.path)!
      const reply = createSseReply()

      await expect(route.handler({
        params: { projectId: 'project-1', chapterNumber: '7' },
        body: testCase.body,
        headers: {},
        raw: { socket: { setNoDelay: vi.fn() } },
      } as any, reply as any)).rejects.toMatchObject({ statusCode: 404 })

      expect(reply.raw.writeHead).not.toHaveBeenCalled()
      const forbidden = {
        createChapterWithFlow,
        reviseOnly,
        discussionRun,
        generateAndArrange,
      }[testCase.forbiddenCall]
      expect(forbidden).not.toHaveBeenCalled()
    })
  }
})

describe('re-revise model and audit contract', () => {
  const routePath = '/projects/:projectId/chapters/:chapterNumber/re-revise'

  it('passes the selected model to the reviser and persists structured quality-gate failures', async () => {
    const selectedModel = { provider: 'selected-provider', modelId: 'selected-model', thinkingLevel: 'high' as const }
    const insertAgentLog = vi.fn()
    const reviseOnly = vi.fn(async () => ({
      status: 'error' as const,
      errorCode: 'quality_gate_revision_incomplete',
      error: '仍有表达问题未通过',
      failedItems: [{ type: 'cliche', message: '套话', excerpt: '旧句' }],
      revisionRounds: [{ round: 1, appliedPatches: 0, failedPatches: 1, remainingFailures: [], contentLength: 4 }],
    }))
    const services = {
      store: {
        getProject: vi.fn(() => ({ id: 'project-1' })),
        getChapter: vi.fn(() => ({ id: 'chapter-1', status: 'drafting' })),
        insertAgentLog,
      },
      orchestrator: { reviseOnly },
    } as any
    const route = createCreationFlowRoutes(services).find(item => item.path === routePath)!

    await route.handler({
      params: { projectId: 'project-1', chapterNumber: '1' },
      body: { content: '待修订正文', modelId: selectedModel },
      headers: {},
      raw: { socket: { setNoDelay: vi.fn() } },
      traceId: 'trace-revise-1',
    } as any, createSseReply() as any)

    expect(reviseOnly).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      chapterNumber: 1,
      content: '待修订正文',
      options: expect.objectContaining({ modelId: selectedModel }),
    }))
    expect(insertAgentLog).toHaveBeenCalledWith(expect.objectContaining({
      agentType: 'reviser',
      operation: 're-revise',
      status: 'error',
      errorCode: 'quality_gate_revision_incomplete',
    }))

    const audit = insertAgentLog.mock.calls[0]?.[0]
    expect(JSON.parse(audit.taskInput)).toMatchObject({
      source: expect.objectContaining({
        file: 'apps/agent-server/src/plugins/novel-plugin/routes/creation-flow-routes.ts',
        operation: 're-revise',
      }),
      request: {
        traceId: 'trace-revise-1',
        params: { projectId: 'project-1', chapterNumber: 1 },
        body: { content: '待修订正文', modelId: selectedModel },
      },
    })
    expect(JSON.parse(audit.error)).toMatchObject({
      errorCode: 'quality_gate_revision_incomplete',
      message: '仍有表达问题未通过',
    })
    expect(JSON.parse(audit.result)).toMatchObject({
      errorCode: 'quality_gate_revision_incomplete',
      revisionRounds: expect.any(Array),
    })
  })

  it('persists the error stack and source location when the re-revise request throws', async () => {
    const failure = new Error('Provider 请求被拒绝')
    failure.stack = 'Error: Provider 请求被拒绝\n    at reviseOnly (test.ts:42:1)'
    const insertAgentLog = vi.fn()
    const services = {
      store: {
        getProject: vi.fn(() => ({ id: 'project-1' })),
        getChapter: vi.fn(() => ({ id: 'chapter-1', status: 'drafting' })),
        insertAgentLog,
      },
      orchestrator: { reviseOnly: vi.fn(async () => { throw failure }) },
    } as any
    const route = createCreationFlowRoutes(services).find(item => item.path === routePath)!

    await route.handler({
      params: { projectId: 'project-1', chapterNumber: '1' },
      body: { content: '需要复现的正文' },
      headers: {},
      raw: { socket: { setNoDelay: vi.fn() } },
      traceId: 'trace-revise-2',
    } as any, createSseReply() as any)

    const audit = insertAgentLog.mock.calls[0]?.[0]
    expect(audit).toMatchObject({
      operation: 're-revise',
      errorCode: 're_revise_request_failed',
      status: 'error',
    })
    expect(JSON.parse(audit.error)).toMatchObject({
      message: 'Provider 请求被拒绝',
      stack: failure.stack,
      source: expect.objectContaining({
        symbol: 'createCreationFlowRoutes > POST /projects/:projectId/chapters/:chapterNumber/re-revise',
      }),
    })
    expect(JSON.parse(audit.taskInput)).toMatchObject({
      request: expect.objectContaining({
        traceId: 'trace-revise-2',
        body: { content: '需要复现的正文' },
      }),
    })
  })
})

describe('other creation-flow model and audit contracts', () => {
  it('starts a durable lifecycle run for workflow resume and records its phase and terminal state', async () => {
    const start = vi.fn(() => ({ runId: 'resume-run-1' }))
    const observePhase = vi.fn()
    const awaitCheckpoint = vi.fn()
    const finish = vi.fn()
    const createChapterWithFlow = vi.fn(async (_projectId: string, _chapterNumber: number, options: any) => {
      options.onProgress({ phase: 'writing', type: 'phase_change' })
      options.onProgress({ phase: 'memory', type: 'phase_change' })
      return { status: 'completed', content: '续写正文' }
    })
    const services = {
      store: {
        getProject: vi.fn(() => ({ id: 'project-1' })),
        getChapter: vi.fn(() => ({ id: 'chapter-1', status: 'drafting' })),
      },
      orchestrator: { createChapterWithFlow, clearStaleInterjectMessages: vi.fn() },
      workflowRunStore: {
        get: vi.fn(() => ({
          id: 'interrupted-run', projectId: 'project-1', chapterNumber: 1,
          status: 'error', phase: 'writing', writerDraft: '中断前草稿',
        })),
        save: vi.fn(),
      },
      workflowEventStore: createWorkflowEventStore(),
      chapterChatStore: { add: vi.fn() },
      confirmationManager: { requestDecision: vi.fn(), listPending: vi.fn(() => []) },
      creationRunLifecycle: { start, observePhase, awaitCheckpoint, finish },
    } as any
    const route = createCreationFlowRoutes(services).find(item => (
      item.path === '/projects/:projectId/chapters/:chapterNumber/create-flow/:runId/resume'
    ))!
    const reply = createReply()

    await route.handler({
      params: { projectId: 'project-1', chapterNumber: '1', runId: 'interrupted-run' },
      body: {},
      headers: {},
      raw: { socket: { setNoDelay: vi.fn() } },
      log: { error: vi.fn(), warn: vi.fn() },
    } as any, reply as any)

    await vi.waitFor(() => expect(finish).toHaveBeenCalledWith(
      expect.any(String),
      { status: 'completed', error: undefined },
    ))
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1', chapterNumber: 1, mode: 'workflow', initialStage: 'writing',
    }))
    expect(observePhase.mock.calls.map(call => call[1])).toEqual(['writing', 'memory'])
    expect(reply.statusCode).toBe(202)
  })

  it('projects AI arrange through the durable lifecycle and resolves the arrange checkpoint', async () => {
    const start = vi.fn(() => ({ runId: 'arrange-run-1' }))
    const observePhase = vi.fn()
    const awaitCheckpoint = vi.fn()
    const resolveCheckpoint = vi.fn()
    const finish = vi.fn()
    let resolveDecision!: (decision: 'approve' | 'revise' | 'reject') => void
    const decision = new Promise<'approve' | 'revise' | 'reject'>(resolve => { resolveDecision = resolve })
    const services = {
      store: {
        getProject: vi.fn(() => ({ id: 'project-1' })),
        getChapter: vi.fn(() => ({ id: 'chapter-1', status: 'drafting', outline: '章纲' })),
        getCharacter: vi.fn(), getConflict: vi.fn(), getForeshadow: vi.fn(), getFaction: vi.fn(),
        getLocation: vi.fn(), getItem: vi.fn(), getNarrative: vi.fn(),
      },
      entityGenerator: {
        getArrangeModel: vi.fn(() => undefined),
        generateArrangeDraft: vi.fn(async (_projectId: string, _chapterNumber: number, _outline: string, onProgress: (event: any) => void) => {
          onProgress({ phase: 'arranging', message: '生成完成' })
          return {
            result: { characterIds: [], conflictIds: [], foreshadowIds: [], clueIds: [], factionIds: [], locationIds: [], itemIds: [], narrativeIds: [] },
            commit: vi.fn(), rollback: vi.fn(),
          }
        }),
      },
      creationRunLifecycle: { start, observePhase, awaitCheckpoint, resolveCheckpoint, finish },
      confirmationManager: {
        requestDecision: vi.fn(() => decision),
        listPending: vi.fn(() => ({
          find: vi.fn(() => ({
            id: 'arrange-checkpoint-1', toolCallId: 'draft-1', threadId: 'novel-arrange-project-1-1',
            args: { checkpoint: { type: 'arrange_review', options: ['approve', 'revise', 'reject'] }, workflowRunId: 'arrange-run-1' },
          })),
        })),
        respondDecision: vi.fn(() => {
          resolveDecision('approve')
          return true
        }),
      },
      chapterChatStore: { add: vi.fn() },
    } as any
    const route = createCreationFlowRoutes(services).find(item => (
      item.path === '/projects/:projectId/chapters/:chapterNumber/ai-arrange'
    ))!
    const reply = createSseReply()

    const flowPromise = route.handler({
      params: { projectId: 'project-1', chapterNumber: '1' },
      body: {}, headers: {}, raw: { socket: { setNoDelay: vi.fn() } },
      log: { error: vi.fn(), warn: vi.fn() },
    } as any, reply as any)

    await vi.waitFor(() => expect(awaitCheckpoint).toHaveBeenCalledWith(expect.any(String), 'arrange-checkpoint-1', expect.any(Number)))
    const decisionRoute = createCreationFlowRoutes(services).find(item => (
      item.path === '/projects/:projectId/checkpoint/:checkpointId/decision'
    ))!
    await decisionRoute.handler({
      params: { projectId: 'project-1', checkpointId: 'arrange-checkpoint-1' },
      body: { decision: 'approve' },
      log: { warn: vi.fn() },
    } as any, createReply() as any)
    await flowPromise
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1', chapterNumber: 1, mode: 'arrange', initialStage: 'arranging',
    }))
    expect(observePhase).toHaveBeenCalledWith(expect.any(String), 'arranging')
    expect(awaitCheckpoint).toHaveBeenCalledWith(expect.any(String), 'arrange-checkpoint-1', expect.any(Number))
    expect(resolveCheckpoint).toHaveBeenCalledWith(
      expect.any(String), 'arrange-checkpoint-1', 'approve',
      expect.objectContaining({ resumeStage: 'arranging' }),
    )
    expect(finish).toHaveBeenCalledWith(expect.any(String), { status: 'completed', error: undefined })
  })

  it('projects create-flow start, phases, and terminal state into the shared run lifecycle', async () => {
    const start = vi.fn(() => ({ runId: 'run-1' }))
    const observePhase = vi.fn()
    const finish = vi.fn()
    const createChapterWithFlow = vi.fn(async (_projectId: string, _chapterNumber: number, options: any) => {
      options.onProgress({ phase: 'writing', type: 'phase_change' })
      options.onProgress({ phase: 'memory', type: 'phase_change' })
      return { status: 'completed', content: '正文' }
    })
    const services = {
      store: {
        getProject: vi.fn(() => ({ id: 'project-1' })),
        getChapter: vi.fn(() => ({ id: 'chapter-1', status: 'drafting' })),
      },
      orchestrator: { createChapterWithFlow, clearStaleInterjectMessages: vi.fn() },
      workflowRunStore: { save: vi.fn() },
      workflowEventStore: createWorkflowEventStore(),
      chapterChatStore: { add: vi.fn() },
      confirmationManager: { requestDecision: vi.fn(), listPending: vi.fn(() => []) },
      creationRunLifecycle: { start, observePhase, finish },
    } as any
    const route = createCreationFlowRoutes(services).find(item => (
      item.path === '/projects/:projectId/chapters/:chapterNumber/create-flow'
    ))!
    const reply = createReply()

    await route.handler({
      params: { projectId: 'project-1', chapterNumber: '1' },
      body: {},
      headers: {},
      raw: { socket: { setNoDelay: vi.fn() } },
      log: { error: vi.fn(), warn: vi.fn() },
    } as any, reply as any)

    await vi.waitFor(() => expect(finish).toHaveBeenCalledWith(
      expect.any(String),
      { status: 'completed', error: undefined },
    ))
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1', chapterNumber: 1, mode: 'workflow',
    }))
    expect(observePhase.mock.calls.map(call => call[1])).toEqual(['writing', 'memory'])
  })

  it('passes the selected model through reverse-arrange to entity extraction', async () => {
    const selectedModel = { provider: 'selected-provider', modelId: 'selected-model', thinkingLevel: 'high' as const }
    const generateAndArrange = vi.fn(async () => ({
      characterIds: [], conflictIds: [], foreshadowIds: [], clueIds: [], factionIds: [], locationIds: [], itemIds: [],
    }))
    const services = {
      store: {
        getProject: vi.fn(() => ({ id: 'project-1' })),
        getChapter: vi.fn(() => ({ id: 'chapter-1', status: 'drafting', content: '已完成的章节正文。' })),
      },
      entityGenerator: { generateAndArrange },
    } as any
    const route = createCreationFlowRoutes(services).find(item => (
      item.path === '/projects/:projectId/chapters/:chapterNumber/reverse-arrange'
    ))!

    await route.handler({
      params: { projectId: 'project-1', chapterNumber: '1' },
      body: { modelId: selectedModel },
      headers: {},
      raw: { socket: { setNoDelay: vi.fn() } },
      log: { error: vi.fn() },
    } as any, createSseReply() as any)

    expect(generateAndArrange).toHaveBeenCalledWith(
      'project-1',
      1,
      '已完成的章节正文。',
      expect.any(Function),
      'content',
      expect.any(AbortSignal),
      selectedModel,
    )
  })

  it('persists an audit record when the main workflow returns an error result', async () => {
    const insertAgentLog = vi.fn()
    const createChapterWithFlow = vi.fn(async () => ({
      status: 'error', error: 'Provider 请求失败', failedPhase: 'writing',
    }))
    const services = {
      store: {
        getProject: vi.fn(() => ({ id: 'project-1' })),
        getChapter: vi.fn(() => ({ id: 'chapter-1', status: 'drafting' })),
        insertAgentLog,
      },
      orchestrator: { createChapterWithFlow, clearStaleInterjectMessages: vi.fn() },
      workflowRunStore: { save: vi.fn() },
      workflowEventStore: createWorkflowEventStore(),
      chapterChatStore: { add: vi.fn() },
      confirmationManager: { requestDecision: vi.fn(), listPending: vi.fn(() => []) },
    } as any
    const route = createCreationFlowRoutes(services).find(item => (
      item.path === '/projects/:projectId/chapters/:chapterNumber/create-flow'
    ))!

    await route.handler({
      params: { projectId: 'project-1', chapterNumber: '1' },
      body: { modelId: { provider: 'selected-provider', modelId: 'selected-model' } },
      headers: {},
      raw: { socket: { setNoDelay: vi.fn() } },
      traceId: 'trace-workflow-1',
      log: { error: vi.fn(), warn: vi.fn() },
    } as any, createSseReply() as any)

    // 后台执行：受理返回后编排仍在跑，审计要等终态
    await vi.waitFor(() => expect(insertAgentLog).toHaveBeenCalled())
    const audit = insertAgentLog.mock.calls[0]?.[0]
    expect(audit).toMatchObject({
      agentType: 'audit',
      operation: 'create-flow',
      errorCode: 'create_flow_failed',
      status: 'error',
    })
    expect(JSON.parse(audit.taskInput)).toMatchObject({
      source: expect.objectContaining({ operation: 'create-flow' }),
      request: {
        traceId: 'trace-workflow-1',
        body: { modelId: { provider: 'selected-provider', modelId: 'selected-model' } },
      },
    })
    expect(JSON.parse(audit.error)).toMatchObject({ message: 'Provider 请求失败' })
  })
})

describe('discussion model contract', () => {
  it('keeps role models under their configured settings when a request includes a selected model', async () => {
    const memberModel = { provider: 'selected', modelId: 'run-model' }
    const projectModel = { provider: 'project', modelId: 'main-model' }
    const run = vi.fn(async () => ({
      status: 'completed', content: '正文', transcript: [], scenes: [],
    }))
    const save = vi.fn()
    const discussionEventStore = {
      append: vi.fn(), list: vi.fn(() => []), lastSeq: vi.fn(() => 0),
    }
    const services = {
      store: {
        getProject: vi.fn(() => ({ id: 'project-1' })),
        getChapter: vi.fn(() => ({ id: 'chapter-1', status: 'drafting' })),
        getNovelModelId: vi.fn(() => 'project:main-model'),
      },
      discussionRunner: { run },
      discussionSettingsStore: { get: vi.fn(() => ({ maxRounds: 20 })) },
      discussionRunStore: { save },
      discussionEventStore,
      chapterChatStore: { addMany: vi.fn() },
      confirmationManager: { requestDecision: vi.fn(), listPending: vi.fn(() => []) },
    } as any
    const route = createCreationFlowRoutes(services).find(item => (
      item.path === '/projects/:projectId/chapters/:chapterNumber/create-discussion'
    ))!
    const reply = createReply()

    await route.handler({
      params: { projectId: 'project-1', chapterNumber: '1' },
      body: { modelId: memberModel },
      headers: {},
      raw: { socket: { setNoDelay: vi.fn() } },
      log: { error: vi.fn() },
    } as any, reply as any)

    // T6：受理即返回 202 + runId，执行转入后台，不再绑定 SSE 生命周期
    expect(reply.statusCode).toBe(202)
    expect(reply.payload).toMatchObject({
      ok: true,
      runId: expect.any(String),
      eventsPath: expect.stringContaining('/discussion-runs/'),
    })
    expect(run).toHaveBeenCalledWith(
      'project-1',
      1,
      expect.objectContaining({
        projectModel,
      }),
      undefined,
    )
    const firstRunOptions = (run.mock.calls as unknown as unknown[][])[0]?.[2]
    expect(firstRunOptions).not.toHaveProperty('memberModel')
    // 后台执行完成：补 run_finished 终态事件并落快照
    const append = services.discussionEventStore.append as ReturnType<typeof vi.fn>
    await vi.waitFor(() => expect(append).toHaveBeenCalledWith(
      expect.any(String), 'run_finished', expect.objectContaining({ status: 'completed', content: '正文' }),
    ))
    await vi.waitFor(() => expect(save).toHaveBeenCalled())
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ projectModel }))
    expect(save.mock.calls[0]?.[0]).not.toHaveProperty('memberModel')
  })

  it('does not restore a legacy per-call member model when resuming a failed run', async () => {
    const memberModel = { provider: 'selected', modelId: 'run-model' }
    const projectModel = { provider: 'project', modelId: 'frozen-model' }
    const snapshot = {
      id: 'failed-run', projectId: 'project-1', chapterNumber: 1,
      status: 'error', failedPhase: 'chapter_weaving', transcript: [], scenes: [],
      memberModel,
      projectModel,
    }
    const run = vi.fn(async () => ({
      status: 'completed', content: '正文', transcript: [], scenes: [],
    }))
    const save = vi.fn()
    const discussionEventStore = {
      append: vi.fn(), list: vi.fn(() => []), lastSeq: vi.fn(() => 0),
    }
    const services = {
      store: {
        getProject: vi.fn(() => ({ id: 'project-1' })),
        getChapter: vi.fn(() => ({ id: 'chapter-1', status: 'drafting' })),
        getNovelModelId: vi.fn(() => 'project:changed-model'),
      },
      discussionRunner: { run },
      discussionSettingsStore: { get: vi.fn(() => ({ maxRounds: 20 })) },
      discussionRunStore: { get: vi.fn(() => snapshot), save },
      discussionEventStore,
      chapterChatStore: { addMany: vi.fn() },
      confirmationManager: { requestDecision: vi.fn(), listPending: vi.fn(() => []) },
    } as any
    const route = createCreationFlowRoutes(services).find(item => (
      item.path === '/projects/:projectId/chapters/:chapterNumber/create-discussion/:runId/resume'
    ))!
    const reply = createReply()

    await route.handler({
      params: { projectId: 'project-1', chapterNumber: '1', runId: 'failed-run' },
      body: {},
      headers: {},
      raw: { socket: { setNoDelay: vi.fn() } },
      log: { error: vi.fn() },
    } as any, reply as any)

    expect(reply.statusCode).toBe(202)
    expect(reply.payload).toMatchObject({
      runId: expect.any(String),
      eventsPath: expect.stringContaining('/discussion-runs/'),
    })
    expect(run).toHaveBeenCalledWith(
      'project-1',
      1,
      expect.objectContaining({ projectModel }),
      undefined,
      expect.objectContaining({ phase: 'chapter_weaving' }),
    )
    const resumedRunOptions = (run.mock.calls as unknown as unknown[][])[0]?.[2]
    expect(resumedRunOptions).not.toHaveProperty('memberModel')
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      projectModel,
      resumedFromRunId: 'failed-run',
    })))
    expect(save.mock.calls[0]?.[0]).not.toHaveProperty('memberModel')
    expect(discussionEventStore.append).toHaveBeenCalledWith(
      expect.any(String),
      'run_finished',
      expect.objectContaining({ status: 'completed', content: '正文' }),
    )
  })

  it('keeps an explicitly empty project model empty when resuming', async () => {
    const snapshot = {
      id: 'failed-without-project-model', projectId: 'project-1', chapterNumber: 1,
      status: 'error', failedPhase: 'chapter_weaving', transcript: [], scenes: [],
      projectModel: null,
    }
    const run = vi.fn(async () => ({
      status: 'completed', content: '正文', transcript: [], scenes: [],
    }))
    const save = vi.fn()
    const services = {
      store: {
        getProject: vi.fn(() => ({ id: 'project-1' })),
        getChapter: vi.fn(() => ({ id: 'chapter-1', status: 'drafting' })),
        // 项目设置在首次运行失败后新增；恢复仍必须保持首次运行的“未配置”。
        getNovelModelId: vi.fn(() => 'project:new-model'),
      },
      discussionRunner: { run },
      discussionSettingsStore: { get: vi.fn(() => ({})) },
      discussionRunStore: { get: vi.fn(() => snapshot), save },
      discussionEventStore: { append: vi.fn(), list: vi.fn(() => []), lastSeq: vi.fn(() => 0) },
      chapterChatStore: { addMany: vi.fn() },
      confirmationManager: { requestDecision: vi.fn(), listPending: vi.fn(() => []) },
    } as any
    const route = createCreationFlowRoutes(services).find(item => (
      item.path === '/projects/:projectId/chapters/:chapterNumber/create-discussion/:runId/resume'
    ))!
    const reply = createReply()

    await route.handler({
      params: { projectId: 'project-1', chapterNumber: '1', runId: snapshot.id },
      body: {}, headers: {}, raw: { socket: { setNoDelay: vi.fn() } },
      log: { error: vi.fn() },
    } as any, reply as any)

    expect(reply.statusCode).toBe(202)
    expect(run).toHaveBeenCalledWith(
      'project-1', 1, expect.objectContaining({ projectModel: null }), undefined,
      expect.objectContaining({ phase: 'chapter_weaving' }),
    )
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ projectModel: null })))
  })
})

describe('workflow resume contract', () => {
  it('persists a resumable snapshot with canResume when create-flow fails after a boundary', async () => {
    const save = vi.fn()
    const createChapterWithFlow = vi.fn(async (_p, _c, options: any) => {
      // 触发阶段边界 2（reviewing），随后失败——模拟 Writer 成稿后审校失败
      options.onRunStateUpdate?.({
        entry: 'reviewing',
        directorTask: { type: 'advance_mainline', description: '推进主线' },
        directorOutput: 'director raw',
        writerDraft: '已生成的草稿正文',
      })
      return { status: 'error', error: '审校失败', failedPhase: 'reviewing' }
    })
    const services = {
      store: {
        getProject: vi.fn(() => ({ id: 'project-1' })),
        getChapter: vi.fn(() => ({ id: 'chapter-1', status: 'drafting' })),
      },
      orchestrator: { createChapterWithFlow, clearStaleInterjectMessages: vi.fn() },
      workflowRunStore: { save },
      workflowEventStore: createWorkflowEventStore(),
      chapterChatStore: { add: vi.fn() },
      confirmationManager: { requestDecision: vi.fn(), listPending: vi.fn(() => []) },
    } as any
    const route = createCreationFlowRoutes(services).find(item => (
      item.path === '/projects/:projectId/chapters/:chapterNumber/create-flow'
    ))!
    const reply = createSseReply()

    await route.handler({
      params: { projectId: 'project-1', chapterNumber: '1' },
      body: {},
      headers: {},
      raw: { socket: { setNoDelay: vi.fn() } },
      log: { warn: vi.fn(), error: vi.fn() },
    } as any, reply as any)

    // 受理即返回 202 + runId，执行转后台
    expect(reply.statusCode).toBe(202)
    expect(reply.payload).toMatchObject({
      ok: true,
      runId: expect.any(String),
      eventsPath: expect.stringContaining('/workflow-runs/'),
    })

    // 边界即时落库（running）+ 终态落库（error 且可续跑）
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      phase: 'reviewing',
      writerDraft: '已生成的草稿正文',
    })))
    // 终态事件携带 canResume + workflowRunId（前端 tail 据此合成 novel:result）
    const append = services.workflowEventStore.append as ReturnType<typeof vi.fn>
    await vi.waitFor(() => expect(append).toHaveBeenCalledWith(
      expect.any(String),
      'run_finished',
      expect.objectContaining({ status: 'error', canResume: true, workflowRunId: expect.any(String) }),
    ))
  })

  it('resume route loads the snapshot and resumes from the recorded phase', async () => {
    const snapshot = {
      id: 'failed-run', projectId: 'project-1', chapterNumber: 1,
      status: 'error', phase: 'writing',
      directorTask: { type: 'advance_mainline', description: '推进主线' },
      directorOutput: 'director raw',
      rhythmSuggestion: { rhythm: 'rising' },
      modelId: { provider: 'selected', modelId: 'run-model' },
    }
    const get = vi.fn(() => snapshot)
    const getLatestResumable = vi.fn()
    const save = vi.fn()
    const createChapterWithFlow = vi.fn(async () => ({ status: 'completed', content: '正文' }))
    const services = {
      store: {
        getProject: vi.fn(() => ({ id: 'project-1' })),
        getChapter: vi.fn(() => ({ id: 'chapter-1', status: 'drafting' })),
      },
      orchestrator: { createChapterWithFlow, clearStaleInterjectMessages: vi.fn() },
      workflowRunStore: { get, getLatestResumable, save },
      workflowEventStore: createWorkflowEventStore(),
      chapterChatStore: { add: vi.fn() },
      confirmationManager: { requestDecision: vi.fn(), listPending: vi.fn(() => []) },
    } as any
    const route = createCreationFlowRoutes(services).find(item => (
      item.path === '/projects/:projectId/chapters/:chapterNumber/create-flow/:runId/resume'
    ))!
    const reply = createSseReply()

    await route.handler({
      params: { projectId: 'project-1', chapterNumber: '1', runId: 'failed-run' },
      body: {},
      headers: {},
      raw: { socket: { setNoDelay: vi.fn() } },
      log: { warn: vi.fn(), error: vi.fn() },
    } as any, reply as any)

    expect(reply.statusCode).toBe(202)
    await vi.waitFor(() => expect(createChapterWithFlow).toHaveBeenCalledWith(
      'project-1',
      1,
      expect.objectContaining({
        modelId: { provider: 'selected', modelId: 'run-model' },
        resume: expect.objectContaining({
          entry: 'writing',
          directorTask: snapshot.directorTask,
          directorOutput: snapshot.directorOutput,
          rhythmSuggestion: snapshot.rhythmSuggestion,
        }),
      }),
    ))
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
      resumedFromRunId: 'failed-run',
    })))
  })

  it('resume failure before a new boundary preserves the original resumable state', async () => {
    const snapshot = {
      id: 'failed-run-again', projectId: 'project-1', chapterNumber: 1,
      status: 'error', phase: 'reviewing',
      directorTask: { type: 'advance_mainline', description: '推进主线' },
      directorOutput: 'director raw',
      writerDraft: '可继续审校的草稿',
      styleExpertIds: ['style-1'],
    }
    const save = vi.fn()
    const createChapterWithFlow = vi.fn(async () => ({
      status: 'error', error: '审校再次失败', failedPhase: 'reviewing',
    }))
    const services = {
      store: {
        getProject: vi.fn(() => ({ id: 'project-1' })),
        getChapter: vi.fn(() => ({ id: 'chapter-1', status: 'drafting' })),
      },
      orchestrator: { createChapterWithFlow, clearStaleInterjectMessages: vi.fn() },
      workflowRunStore: { get: vi.fn(() => snapshot), getLatestResumable: vi.fn(), save },
      workflowEventStore: createWorkflowEventStore(),
      chapterChatStore: { add: vi.fn() },
      confirmationManager: { requestDecision: vi.fn(), listPending: vi.fn(() => []) },
    } as any
    const route = createCreationFlowRoutes(services).find(item => (
      item.path === '/projects/:projectId/chapters/:chapterNumber/create-flow/:runId/resume'
    ))!
    const reply = createSseReply()

    await route.handler({
      params: { projectId: 'project-1', chapterNumber: '1', runId: snapshot.id },
      body: {}, headers: {}, raw: { socket: { setNoDelay: vi.fn() } },
      log: { warn: vi.fn(), error: vi.fn() },
    } as any, reply as any)

    await vi.waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      phase: 'reviewing',
      writerDraft: '可继续审校的草稿',
      styleExpertIds: ['style-1'],
      resumedFromRunId: snapshot.id,
    })))
    const append = services.workflowEventStore.append as ReturnType<typeof vi.fn>
    await vi.waitFor(() => expect(append).toHaveBeenCalledWith(
      expect.any(String),
      'run_finished',
      expect.objectContaining({ canResume: true }),
    ))
  })

  it('resume route with runId=latest falls back to the most recent resumable snapshot', async () => {
    const snapshot = {
      id: 'latest-failed', projectId: 'project-1', chapterNumber: 1,
      status: 'error', phase: 'reviewing', writerDraft: '草稿',
    }
    const createChapterWithFlow = vi.fn(async () => ({ status: 'completed', content: '正文' }))
    const services = {
      store: {
        getProject: vi.fn(() => ({ id: 'project-1' })),
        getChapter: vi.fn(() => ({ id: 'chapter-1', status: 'drafting' })),
      },
      orchestrator: { createChapterWithFlow, clearStaleInterjectMessages: vi.fn() },
      workflowRunStore: {
        get: vi.fn(),
        getLatestResumable: vi.fn(() => snapshot),
        save: vi.fn(),
      },
      workflowEventStore: createWorkflowEventStore(),
      chapterChatStore: { add: vi.fn() },
      confirmationManager: { requestDecision: vi.fn(), listPending: vi.fn(() => []) },
    } as any
    const route = createCreationFlowRoutes(services).find(item => (
      item.path === '/projects/:projectId/chapters/:chapterNumber/create-flow/:runId/resume'
    ))!

    await route.handler({
      params: { projectId: 'project-1', chapterNumber: '1', runId: 'latest' },
      body: {}, headers: {}, raw: { socket: { setNoDelay: vi.fn() } },
      log: { warn: vi.fn(), error: vi.fn() },
    } as any, createSseReply() as any)

    expect(services.workflowRunStore.getLatestResumable).toHaveBeenCalledWith('project-1', 1)
    await vi.waitFor(() => expect(createChapterWithFlow).toHaveBeenCalledWith(
      'project-1', 1,
      expect.objectContaining({
        resume: expect.objectContaining({ entry: 'reviewing', writerDraft: '草稿' }),
      }),
    ))
  })
})

describe('create-team compatibility route', () => {
  it('uses the canonical orchestrator flow instead of the legacy TeamManager pipeline', async () => {
    const createChapterWithFlow = vi.fn(async () => ({ status: 'completed', content: '正文' }))
    const execute = vi.fn()
    const services = {
      store: {
        getProject: vi.fn(() => ({ id: 'project-1', title: '测试项目' })),
        getChapter: vi.fn(() => ({ id: 'chapter-1', chapterNumber: 1 })),
        updateChapter: vi.fn(),
      },
      orchestrator: { createChapterWithFlow, setUserMessages: vi.fn() },
      teamManager: { execute, getTeam: vi.fn(() => ({ id: 'novel-team' })) },
    } as any
    const route = createCreationFlowRoutes(services).find(item => (
      item.path === '/projects/:projectId/chapters/:chapterNumber/create-team'
    ))!
    const reply = createReply()

    const result = await route.handler({
      params: { projectId: 'project-1', chapterNumber: '1' },
      body: { narrativeTask: '推进主线', rhythm: '紧凑' },
      traceId: 'trace-1',
    } as any, reply as any)

    expect(createChapterWithFlow).toHaveBeenCalledWith(
      'project-1',
      1,
      expect.objectContaining({ onCheckpoint: expect.any(Function), onProgress: expect.any(Function) }),
    )
    expect(services.orchestrator.setUserMessages).toHaveBeenCalledWith(
      'project-1', 1, ['推进主线', '节奏建议：紧凑'],
    )
    expect(services.store.updateChapter).toHaveBeenCalledWith(
      'chapter-1', { narrativeTask: '推进主线' },
    )
    expect(execute).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: true, data: { status: 'completed', content: '正文' } })
  })
})

describe('create-flow 不再把请求连接当作取消信号（T8 回归）', () => {
  const pendingLockKey = 'project-detach:1'
  afterEach(() => {
    // 挂起的后台 run 不会自己收尾：用例结束后手工释放，避免污染后续用例
    const leftover = activeNovelChapterTasks.get(pendingLockKey)
    if (leftover) finishNovelChapterTask(pendingLockKey, leftover)
  })

  function makeServices(createChapterWithFlow: ReturnType<typeof vi.fn>) {
    return {
      store: {
        getProject: vi.fn(() => ({ id: 'project-1' })),
        getChapter: vi.fn(() => ({ id: 'chapter-1', status: 'drafting' })),
      },
      orchestrator: { createChapterWithFlow, clearStaleInterjectMessages: vi.fn() },
      workflowRunStore: { save: vi.fn() },
      workflowEventStore: createWorkflowEventStore(),
      chapterChatStore: { add: vi.fn() },
      confirmationManager: { requestDecision: vi.fn(), listPending: vi.fn(() => []) },
    } as any
  }

  it('create-flow 不监听 reply.raw 的 close：客户端断开不再中止整章创作', async () => {
    const createChapterWithFlow = vi.fn(() => new Promise(() => { /* 一直挂起模拟后台运行 */ }))
    const route = createCreationFlowRoutes(makeServices(createChapterWithFlow)).find(item => (
      item.path === '/projects/:projectId/chapters/:chapterNumber/create-flow'
    ))!
    const reply = createSseReply()

    await route.handler({
      params: { projectId: 'project-detach', chapterNumber: '1' },
      body: {},
      headers: {},
      raw: { socket: { setNoDelay: vi.fn() } },
      log: { warn: vi.fn(), error: vi.fn() },
    } as any, reply as any)

    // 旧实现把 reply.raw 的 close 当取消信号（刷新页面/切路由即整章作废）；
    // 现在 run 跑在后台，路由不得再注册任何 close 监听。
    const registeredCloseListeners = reply.raw.once.mock.calls.filter(
      (call: unknown[]) => call[0] === 'close',
    )
    expect(registeredCloseListeners).toHaveLength(0)
    expect(createChapterWithFlow).toHaveBeenCalledTimes(1)
  })

  it('create-flow 收尾后释放章节锁：后台 run 不再依赖连接结束来解锁', async () => {
    const createChapterWithFlow = vi.fn(async () => ({ status: 'completed', content: '正文' }))
    const route = createCreationFlowRoutes(makeServices(createChapterWithFlow)).find(item => (
      item.path === '/projects/:projectId/chapters/:chapterNumber/create-flow'
    ))!

    await route.handler({
      params: { projectId: 'project-lock', chapterNumber: '1' },
      body: {},
      headers: {},
      raw: { socket: { setNoDelay: vi.fn() } },
      log: { warn: vi.fn(), error: vi.fn() },
    } as any, createSseReply() as any)

    await vi.waitFor(() => expect(activeNovelChapterTasks.has('project-lock:1')).toBe(false))
  })
})

describe('workflow events tail（T8：run 脱离 HTTP 生命周期）', () => {  const makeServices = (store: { lastSeq: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn>; findActiveRun?: ReturnType<typeof vi.fn> }) => ({
    workflowEventStore: store,
  }) as any

  it('events 端点：from=0 全量重放，run_finished 后自动收流', async () => {
    const store = {
      lastSeq: vi.fn(() => 3),
      list: vi.fn(() => [
        { runId: 'w1', seq: 1, type: 'run_started', payload: {}, createdAt: 1 },
        { runId: 'w1', seq: 2, type: 'agui', payload: { type: 'TEXT_MESSAGE_CONTENT' }, createdAt: 2 },
        { runId: 'w1', seq: 3, type: 'run_finished', payload: { status: 'completed' }, createdAt: 3 },
      ]),
    }
    const route = createCreationFlowRoutes(makeServices(store)).find(item => (
      item.path === '/projects/:projectId/workflow-runs/:runId/events'
    ))!
    const reply = createSseReply()

    await route.handler({
      params: { runId: 'w1' },
      query: { from: '0' },
      headers: {},
      raw: { socket: { setNoDelay: vi.fn() } },
    } as any, reply as any)

    expect(reply.raw.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'text/event-stream',
    }))
    const written = reply.raw.write.mock.calls.map(([data]) => String(data))
    expect(written.some(data => data.includes('run_started'))).toBe(true)
    expect(written.some(data => data.includes('run_finished'))).toBe(true)
    // 终态已写出：流自动结束，无残留轮询
    expect(reply.raw.end).toHaveBeenCalled()
  })

  it('events 端点：带游标时只补增量', async () => {
    const list = vi.fn(() => [])
    const store = { lastSeq: vi.fn(() => 9), list }
    const route = createCreationFlowRoutes(makeServices(store)).find(item => (
      item.path === '/projects/:projectId/workflow-runs/:runId/events'
    ))!

    await route.handler({
      params: { runId: 'w1' },
      query: { from: '7' },
      headers: {},
      raw: { socket: { setNoDelay: vi.fn() } },
    } as any, createSseReply() as any)

    expect(list).toHaveBeenCalledWith('w1', 8)
  })

  it('events 端点：空事件流返回 404', async () => {
    const route = createCreationFlowRoutes(makeServices({
      lastSeq: vi.fn(() => 0),
      list: vi.fn(() => []),
    })).find(item => item.path === '/projects/:projectId/workflow-runs/:runId/events')!
    const reply = createReply()

    await route.handler({ params: { runId: 'missing' }, query: {}, headers: {} } as any, reply as any)

    expect(reply.statusCode).toBe(404)
  })

  it('active-workflow-run：面板重开后取回在跑的 runId 与续传游标', async () => {
    const route = createCreationFlowRoutes(makeServices({
      lastSeq: vi.fn(() => 0),
      list: vi.fn(() => []),
      findActiveRun: vi.fn(() => ({ runId: 'w-running', cursorSeq: 12 })),
    })).find(item => item.path === '/projects/:projectId/chapters/:chapterNumber/active-workflow-run')!
    const reply = createReply()

    await route.handler({ params: { projectId: 'p-1', chapterNumber: '3' }, headers: {} } as any, reply as any)

    expect(reply.payload).toMatchObject({
      ok: true,
      runId: 'w-running',
      cursorSeq: 12,
      eventsPath: '/projects/p-1/workflow-runs/w-running/events',
    })
  })
})

describe('discussion events tail and cancel (T6)', () => {
  const makeServices = (store: { lastSeq: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> }) => ({
    discussionEventStore: store,
  }) as any

  it('events 端点：from=0 全量重放，run_finished 后自动收流', async () => {
    const store = {
      lastSeq: vi.fn(() => 2),
      list: vi.fn(() => [
        { runId: 'r1', seq: 1, type: 'run_started', payload: {}, createdAt: 1 },
        { runId: 'r1', seq: 2, type: 'run_finished', payload: { status: 'completed' }, createdAt: 2 },
      ]),
    }
    const route = createCreationFlowRoutes(makeServices(store)).find(item => (
      item.path === '/projects/:projectId/discussion-runs/:runId/events'
    ))!
    const reply = createSseReply()

    await route.handler({
      params: { runId: 'r1' },
      query: { from: '0' },
      headers: {},
      raw: { socket: { setNoDelay: vi.fn() } },
    } as any, reply as any)

    expect(reply.raw.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'text/event-stream',
    }))
    const written = reply.raw.write.mock.calls.map(([data]) => String(data))
    expect(written.some(data => data.includes('run_started'))).toBe(true)
    expect(written.some(data => data.includes('run_finished'))).toBe(true)
    // 终态已写出：流自动结束，无残留轮询
    expect(reply.raw.end).toHaveBeenCalled()
  })

  it('events 端点：空事件流返回 404', async () => {
    const route = createCreationFlowRoutes(makeServices({
      lastSeq: vi.fn(() => 0),
      list: vi.fn(() => []),
    })).find(item => item.path === '/projects/:projectId/discussion-runs/:runId/events')!
    const reply = createReply()

    await route.handler({ params: { runId: 'missing' }, query: {}, headers: {} } as any, reply as any)

    expect(reply.statusCode).toBe(404)
  })

  it('cancel 端点：按 runId 中止运行中的群聊任务并等待收尾', async () => {
    const route = createCreationFlowRoutes({} as any).find(item => (
      item.path === '/projects/:projectId/discussion-runs/:runId/cancel'
    ))!
    const task = registerNovelChapterTask('p-cancel:1', 'discussion', 'run-cancel-1')
    const reply = createReply()

    const handlerDone = route.handler({
      params: { runId: 'run-cancel-1' },
      headers: {},
    } as any, reply as any) as Promise<unknown>
    // 模拟后台 run 的 finally 收尾：resolve donePromise
    setTimeout(() => finishNovelChapterTask('p-cancel:1', task), 0)
    await handlerDone

    expect(task.controller.signal.aborted).toBe(true)
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({
      ok: true, runId: 'run-cancel-1', cancelled: true,
    }))
  })

  it('cancel 端点：已结束与不存在的 run 分别返回 409/404', async () => {
    const store = {
      lastSeq: vi.fn(() => 0),
      list: vi.fn((runId: string) => runId === 'done-1'
        ? [{ runId: 'done-1', seq: 1, type: 'run_finished', payload: {}, createdAt: 1 }]
        : []),
    }
    const route = createCreationFlowRoutes(makeServices(store)).find(item => (
      item.path === '/projects/:projectId/discussion-runs/:runId/cancel'
    ))!

    const finishedReply = createReply()
    await route.handler({ params: { runId: 'done-1' }, headers: {} } as any, finishedReply as any)
    expect(finishedReply.statusCode).toBe(409)

    const missingReply = createReply()
    await route.handler({ params: { runId: 'missing' }, headers: {} } as any, missingReply as any)
    expect(missingReply.statusCode).toBe(404)
  })
})

describe('novel agent model config', () => {
  function createAgentConfigServices() {
    const agents = new Map<string, any>(Object.values(NOVEL_AGENT_CONFIGS).map((config) => [
      config.id,
      { id: config.id, temperature: config.temperature },
    ]))
    const agentManager = {
      getAgent: vi.fn((id: string) => agents.get(id)),
      updateAgent: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        const updated = { ...agents.get(id), ...patch }
        agents.set(id, updated)
        return updated
      }),
    }
    return { store: {}, agentManager }
  }

  it('按 Agent 配置 API 保存并返回思考强度', async () => {
    const services = createAgentConfigServices()
    const route = createCreationFlowRoutes(services as any).find(item => item.path === '/agent-config' && item.method === 'PUT')!

    const result = await route.handler({
      body: {
        items: [{
          agentType: 'writer',
          temperature: 0.9,
          model: { provider: 'openai', modelId: 'gpt-test', thinkingLevel: 'high' },
        }],
        traceId: 'trace-1',
      },
      traceId: 'trace-1',
    } as any, createReply() as any) as any

    expect(result.data.find((item: { agentType: string }) => item.agentType === 'writer')?.model).toEqual({
      provider: 'openai',
      modelId: 'gpt-test',
      thinkingLevel: 'high',
    })
  })

  it('拒绝 Agent 模型不支持的思考强度值', async () => {
    const services = createAgentConfigServices()
    const route = createCreationFlowRoutes(services as any).find(item => item.path === '/agent-config' && item.method === 'PUT')!
    const reply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    }

    await route.handler({
      body: {
        items: [{
          agentType: 'writer',
          temperature: 0.9,
          model: { provider: 'openai', modelId: 'gpt-test', thinkingLevel: 'ultra' },
        }],
        traceId: 'trace-1',
      },
      traceId: 'trace-1',
      url: '/agent-config',
      method: 'PUT',
      log: { warn: vi.fn() },
    } as any, reply as any)

    expect(reply.status).toHaveBeenCalledWith(400)
    expect(services.agentManager.updateAgent).not.toHaveBeenCalled()
  })
})
