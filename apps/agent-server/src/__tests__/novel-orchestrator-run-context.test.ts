import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, expect, it, vi } from 'vitest'
import { NovelOrchestrator } from '../plugins/novel-plugin/core/novel-orchestrator.js'

describe('NovelOrchestrator request context', () => {
  it('并发 create-flow 使用独立的编排实体上下文', async () => {
    const orchestrator = Object.create(NovelOrchestrator.prototype) as any
    orchestrator.runStorage = new AsyncLocalStorage()
    orchestrator.pendingUserMessages = new Map()
    orchestrator.createChapterWithFlowInContext = vi.fn(async (
      _projectId: string,
      _chapterNumber: number,
      _options: unknown,
    ) => {
      await new Promise(resolve => setTimeout(resolve, Math.random() * 5))
      return {
        status: 'completed',
        content: orchestrator.requireRunContext().arrangedEntities.characterIds[0],
      }
    })

    const [first, second] = await Promise.all([
      orchestrator.createChapterWithFlow('project', 1, {
        arrangedEntities: { characterIds: ['char-a'] },
      }),
      orchestrator.createChapterWithFlow('project', 2, {
        arrangedEntities: { characterIds: ['char-b'] },
      }),
    ])

    expect(first.content).toBe('char-a')
    expect(second.content).toBe('char-b')
  })

  it('检查点用户消息按项目和章节隔离', () => {
    const orchestrator = Object.create(NovelOrchestrator.prototype) as any
    orchestrator.pendingUserMessages = new Map()

    orchestrator.setUserMessages('project', 1, ['第一章意见'])
    orchestrator.setUserMessages('project', 2, ['第二章意见'])

    expect(orchestrator.pendingUserMessages.get('project|1')).toEqual(['第一章意见'])
    expect(orchestrator.pendingUserMessages.get('project|2')).toEqual(['第二章意见'])
  })

  it('从 Director 方案解析章节定位并传给下游', () => {
    const orchestrator = Object.create(NovelOrchestrator.prototype) as any
    const task = orchestrator.parseDirectorTask(
      '## 预期节奏和氛围\n- 章节定位：high_pressure\n- 节奏类型：climax',
      { rhythm: 'climax', reason: '冲突爆发' },
    )

    expect(task.positioning).toBe('high_pressure')
  })

  it('PostWriteGuard 拦截未在正文出现的矩阵角色', () => {
    const orchestrator = Object.create(NovelOrchestrator.prototype) as any
    orchestrator.runStorage = new AsyncLocalStorage()
    orchestrator.runStorage.enterWith({
      semiLayerSharedCache: null,
      rhythmSuggestion: { rhythm: 'rising', reason: '推进' },
    })
    orchestrator.store = {
      getProject: () => ({ targetWords: 1_000_000 }),
      getChapter: () => ({ positioning: null }),
      getCharacter: () => ({ name: '李四' }),
      getFaction: () => undefined,
      getLocation: () => undefined,
    }
    orchestrator.engine = {
      buildChapterConstraints: () => ({ wordBudget: { target: 3000 } }),
    }
    orchestrator.promptBuilder = { computeChapterTargetWords: () => 3000 }

    const result = orchestrator.runPostWriteGuard(
      Array.from({ length: 180 }, (_, i) => `第${i + 1}段写的是不同的山路风景与人物行动。`).join('\n'),
      'project',
      1,
      { characterIds: ['char-1'], conflictIds: [], foreshadowIds: [], factionIds: [], locationIds: [] },
    )

    expect(result.shouldRewrite).toBe(true)
    expect(result.reason).toBe('未完整执行矩阵编排')
    expect(result.details).toContain('李四')
  })

  it('PostWriteGuard 失败时只重跑 Writer，不重跑 Director', async () => {
    const orchestrator = Object.create(NovelOrchestrator.prototype) as any
    orchestrator.runStorage = new AsyncLocalStorage()
    orchestrator.pendingUserMessages = new Map()
    orchestrator.store = {
      getProject: () => ({ currentStage: 'setup', rhythmModelId: 'default', currentChapter: 1 }),
      listChapters: () => [],
      listConflicts: () => [],
      listForeshadowing: () => [],
      getChapter: () => ({ id: 'chapter-1', positioning: null }),
      listHooksByChapter: () => [],
    }
    orchestrator.promptBuilder = {
      stripEmDash: (value: string) => value,
    }
    orchestrator.context = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }
    const agentCalls: string[] = []
    orchestrator.runAgent = vi.fn(async (agentType: string) => {
      agentCalls.push(agentType)
      if (agentType === 'director') return '任务类型：advance_plot\n优先级：high'
      if (agentType === 'writer') return agentCalls.filter((item) => item === 'writer').length === 1 ? '过短初稿' : '通过的完整正文'
      return '验收通过'
    })
    orchestrator.runPostWriteGuard = vi.fn()
      .mockReturnValueOnce({ shouldRewrite: true, reason: '正文过短', details: '' })
      .mockReturnValueOnce({ shouldRewrite: false, reason: '', details: '' })
    orchestrator.finalizer = {
      finalize: vi.fn(async () => ({ status: 'completed', content: '通过的完整正文' })),
    }

    const result = await orchestrator.createChapterWithFlow('project', 1, {
      arrangedEntities: { characterIds: [], conflictIds: [], foreshadowIds: [], factionIds: [], locationIds: [] },
      onCheckpoint: vi.fn(async () => 'approve'),
      onProgress: vi.fn(),
    })

    expect(result.status).toBe('completed')
    expect(agentCalls.filter((item) => item === 'director')).toHaveLength(1)
    expect(agentCalls.filter((item) => item === 'writer')).toHaveLength(2)
    expect(agentCalls.filter((item) => item === 'reviewer')).toHaveLength(1)
  })
})
