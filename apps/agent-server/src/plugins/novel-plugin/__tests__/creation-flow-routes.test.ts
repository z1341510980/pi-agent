import { describe, expect, it, vi } from 'vitest'
import { ConfirmationManager } from '../../../core/tool/confirmation-manager.js'
import { createCreationFlowRoutes } from '../routes/creation-flow-routes.js'

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
    const services = {
      store: {
        getProject: vi.fn(() => ({ id: 'project-1' })),
        getChapter: vi.fn(() => ({ id: 'chapter-1', status: 'drafting' })),
        getNovelModelId: vi.fn(() => 'project:main-model'),
      },
      discussionRunner: { run },
      discussionSettingsStore: { get: vi.fn(() => ({ moderatorModel: { provider: 'cheap', modelId: 'moderator' } })) },
      discussionRunStore: { save },
      chapterChatStore: { addMany: vi.fn() },
      confirmationManager: { requestDecision: vi.fn(), listPending: vi.fn(() => []) },
    } as any
    const route = createCreationFlowRoutes(services).find(item => (
      item.path === '/projects/:projectId/chapters/:chapterNumber/create-discussion'
    ))!
    const reply = createSseReply()

    await route.handler({
      params: { projectId: 'project-1', chapterNumber: '1' },
      body: { modelId: memberModel },
      headers: {},
      raw: { socket: { setNoDelay: vi.fn() } },
      log: { error: vi.fn() },
    } as any, reply as any)

    expect(run).toHaveBeenCalledWith(
      'project-1',
      1,
      expect.objectContaining({
        projectModel,
        moderatorModel: { provider: 'cheap', modelId: 'moderator' },
      }),
      undefined,
    )
    const firstRunOptions = (run.mock.calls as unknown as unknown[][])[0]?.[2]
    expect(firstRunOptions).not.toHaveProperty('memberModel')
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
    const services = {
      store: {
        getProject: vi.fn(() => ({ id: 'project-1' })),
        getChapter: vi.fn(() => ({ id: 'chapter-1', status: 'drafting' })),
        getNovelModelId: vi.fn(() => 'project:changed-model'),
      },
      discussionRunner: { run },
      discussionSettingsStore: { get: vi.fn(() => ({ moderatorModel: { provider: 'cheap', modelId: 'moderator' } })) },
      discussionRunStore: { get: vi.fn(() => snapshot), save },
      chapterChatStore: { addMany: vi.fn() },
      confirmationManager: { requestDecision: vi.fn(), listPending: vi.fn(() => []) },
    } as any
    const route = createCreationFlowRoutes(services).find(item => (
      item.path === '/projects/:projectId/chapters/:chapterNumber/create-discussion/:runId/resume'
    ))!
    const reply = createSseReply()

    await route.handler({
      params: { projectId: 'project-1', chapterNumber: '1', runId: 'failed-run' },
      body: {},
      headers: {},
      raw: { socket: { setNoDelay: vi.fn() } },
      log: { error: vi.fn() },
    } as any, reply as any)

    expect(run).toHaveBeenCalledWith(
      'project-1',
      1,
      expect.objectContaining({ projectModel }),
      undefined,
      expect.objectContaining({ phase: 'chapter_weaving' }),
    )
    const resumedRunOptions = (run.mock.calls as unknown as unknown[][])[0]?.[2]
    expect(resumedRunOptions).not.toHaveProperty('memberModel')
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      projectModel,
      resumedFromRunId: 'failed-run',
    }))
    expect(save.mock.calls[0]?.[0]).not.toHaveProperty('memberModel')
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
      chapterChatStore: { addMany: vi.fn() },
      confirmationManager: { requestDecision: vi.fn(), listPending: vi.fn(() => []) },
    } as any
    const route = createCreationFlowRoutes(services).find(item => (
      item.path === '/projects/:projectId/chapters/:chapterNumber/create-discussion/:runId/resume'
    ))!

    await route.handler({
      params: { projectId: 'project-1', chapterNumber: '1', runId: snapshot.id },
      body: {}, headers: {}, raw: { socket: { setNoDelay: vi.fn() } },
      log: { error: vi.fn() },
    } as any, createSseReply() as any)

    expect(run).toHaveBeenCalledWith(
      'project-1', 1, expect.objectContaining({ projectModel: null }), undefined,
      expect.objectContaining({ phase: 'chapter_weaving' }),
    )
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ projectModel: null }))
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

    // 边界即时落库（running）+ 终态落库（error 且可续跑）
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      phase: 'reviewing',
      writerDraft: '已生成的草稿正文',
    }))
    // emitter.result 收到 canResume + workflowRunId（写进 SSE）
    const written = (reply.raw.write as any).mock.calls.map((c: any[]) => c[0]).join('')
    expect(written).toContain('novel:result')
    expect(written).toContain('"canResume":true')
    expect(written).toContain('"workflowRunId"')
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

    expect(createChapterWithFlow).toHaveBeenCalledWith(
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
    )
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
      resumedFromRunId: 'failed-run',
    }))
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

    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      phase: 'reviewing',
      writerDraft: '可继续审校的草稿',
      styleExpertIds: ['style-1'],
      resumedFromRunId: snapshot.id,
    }))
    const written = (reply.raw.write as any).mock.calls.map((call: any[]) => call[0]).join('')
    expect(written).toContain('"canResume":true')
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
    expect(createChapterWithFlow).toHaveBeenCalledWith(
      'project-1', 1,
      expect.objectContaining({
        resume: expect.objectContaining({ entry: 'reviewing', writerDraft: '草稿' }),
      }),
    )
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
