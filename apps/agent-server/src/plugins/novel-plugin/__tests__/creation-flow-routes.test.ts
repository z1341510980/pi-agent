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

describe('discussion member model contract', () => {
  it('passes the selected model to the runner and persists it for resume', async () => {
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
        memberModel,
        projectModel,
        moderatorModel: { provider: 'cheap', modelId: 'moderator' },
      }),
      undefined,
    )
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ memberModel, projectModel }))
  })

  it('reuses the original member model when resuming a failed run', async () => {
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
      expect.objectContaining({ memberModel, projectModel }),
      undefined,
      expect.objectContaining({ phase: 'chapter_weaving' }),
    )
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      memberModel,
      projectModel,
      resumedFromRunId: 'failed-run',
    }))
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
