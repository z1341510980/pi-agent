import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, expect, it, vi } from 'vitest'
import { NovelOrchestrator } from '../plugins/novel-plugin/core/novel-orchestrator.js'

// 模拟 Director / Reviewer 通过工具提交结构化对象。
// 工具在 orchestrator 内部通过闭包绑定 draft，mock runAgent 时从 overrides.extraTools
// 拿到工具实例并调用 execute，使 draft.task / draft.review 被正确填充，
// 让流程编排测试能验证 director/writer/reviewer 的调用次数而无需真实 LLM。
async function invokeExtraTool(overrides: unknown, params: Record<string, unknown>): Promise<void> {
  const tools = (overrides as { extraTools?: Array<{ execute: (id: string, p: Record<string, unknown>) => Promise<unknown> }> } | undefined)?.extraTools
  if (!tools || tools.length === 0) return
  await tools[0]!.execute('test-call', params)
}

const DIRECTOR_TOOL_PARAMS = {
  taskType: 'advance_mainline',
  priority: 'high',
  narrativeTask: '本章核心目标：推进主线，让主角通过行动解决当前困境。',
  secondaryTasks: [],
  chapterEndingHook: { type: 'suspense', description: '章尾钩子' },
  povCharacters: ['主角'],
  sceneCount: 1,
  positioning: 'high_pressure',
  timelineOffset: { days: 0, description: '同日' },
}

const REVIEWER_TOOL_PARAMS = {
  consistencyScore: 8,
  characterScore: 7,
  taskCompletionScore: 9,
  clueProgressScore: 6,
  foreshadowStatusScore: 8,
  conflictChangeScore: 7,
  pacingScore: 6,
  infoControlScore: 9,
  readerHookScore: 8,
  styleScore: 7,
  overallScore: 7.5,
  verdict: 'accept' as const,
  issues: [],
  suggestions: [],
}

function createDecisionPathOrchestrator(): {
  orchestrator: any
  agentCalls: string[]
} {
  const orchestrator = Object.create(NovelOrchestrator.prototype) as any
  orchestrator.runStorage = new AsyncLocalStorage()
  orchestrator.pendingUserMessages = new Map()
  orchestrator.store = {
    getProject: () => ({ currentStage: 'setup', rhythmModelId: 'default', currentChapter: 1 }),
    getWritingStyleProfile: () => undefined,
    listChapters: () => [],
    listConflicts: () => [],
    listForeshadowing: () => [],
    getChapter: () => ({ id: 'chapter-1', positioning: null }),
    listHooksByChapter: () => [],
  }
  orchestrator.promptBuilder = {
    stripEmDash: (value: string) => value,
    buildProseEditorIdentity: () => '文字编辑身份',
  }
  orchestrator.context = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }
  orchestrator.engine = {
    buildChapterConstraints: () => ({ wordBudget: { target: 3000 } }),
    saveReview: vi.fn(async () => ({})),
  }
  const agentCalls: string[] = []
  orchestrator.runAgent = vi.fn(async (
    agentType: string,
    _projectId: string,
    _chapterNumber: number,
    _input: string,
    _options: unknown,
    overrides?: unknown,
  ) => {
    agentCalls.push(agentType)
    if (agentType === 'director') {
      await invokeExtraTool(overrides, DIRECTOR_TOOL_PARAMS)
      return 'Director 已通过工具提交叙事任务'
    }
    if (agentType === 'writer') return '通过的完整正文'
    if (agentType === 'reviewer') {
      await invokeExtraTool(overrides, REVIEWER_TOOL_PARAMS).catch(() => {})
      return '验收通过'
    }
    return 'Reviser 已检查正文'
  })
  orchestrator.finalizer = {
    finalize: vi.fn(async ({ content }: { content: string }) => ({ status: 'completed', content })),
  }
  return { orchestrator, agentCalls }
}

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

  it('PostWriteGuard 将轻微字数不足交给 Reviewer，不触发整章重写', () => {
    const orchestrator = Object.create(NovelOrchestrator.prototype) as any
    orchestrator.runStorage = new AsyncLocalStorage()
    orchestrator.runStorage.enterWith({
      semiLayerSharedCache: null,
      rhythmSuggestion: { rhythm: 'rising', reason: '推进' },
    })
    orchestrator.store = {
      getProject: () => ({ targetWords: 3_000_000 }),
      getChapter: () => ({ positioning: null }),
    }
    orchestrator.engine = {
      buildChapterConstraints: () => ({ wordBudget: { target: 3000 } }),
    }
    orchestrator.promptBuilder = { computeChapterTargetWords: () => 3000 }
    const prose = Array.from({ length: 2540 }, (_, index) =>
      String.fromCodePoint(0x4e00 + (index % 1800)),
    ).join('')

    const result = orchestrator.runPostWriteGuard(prose, 'project', 1)

    expect(result.shouldRewrite).toBe(false)
    expect(result.advisory).toBe(true)
    expect(result.reason).toBe('字数略低于建议范围')
    expect(result.details).toContain('实际 2540 字')
  })

  it('PostWriteGuard 对势力和地点名称缺失只提示 Reviewer 语义验收', () => {
    const orchestrator = Object.create(NovelOrchestrator.prototype) as any
    orchestrator.runStorage = new AsyncLocalStorage()
    orchestrator.runStorage.enterWith({
      semiLayerSharedCache: null,
      rhythmSuggestion: { rhythm: 'rising', reason: '推进' },
    })
    orchestrator.store = {
      getProject: () => undefined,
      getFaction: () => ({ name: '国安总局' }),
      getLocation: () => ({ name: '潼关杂役坑' }),
      getCharacter: () => undefined,
    }
    orchestrator.promptBuilder = { computeChapterTargetWords: () => 3000 }
    const prose = Array.from({ length: 2600 }, (_, index) =>
      String.fromCodePoint(0x4e00 + (index % 1800)),
    ).join('')

    const result = orchestrator.runPostWriteGuard(
      prose,
      'project',
      1,
      { characterIds: [], conflictIds: [], foreshadowIds: [], factionIds: ['faction-1'], locationIds: ['location-1'] },
    )

    expect(result.shouldRewrite).toBe(false)
    expect(result.advisory).toBe(true)
    expect(result.reason).toBe('矩阵实体需要语义验收')
    expect(result.details).toContain('国安总局')
    expect(result.details).toContain('潼关杂役坑')
  })

  it('PostWriteGuard 失败时只重跑 Writer，不重跑 Director', async () => {
    const orchestrator = Object.create(NovelOrchestrator.prototype) as any
    orchestrator.runStorage = new AsyncLocalStorage()
    orchestrator.pendingUserMessages = new Map()
    orchestrator.store = {
      getProject: () => ({ currentStage: 'setup', rhythmModelId: 'default', currentChapter: 1 }),
      getWritingStyleProfile: () => undefined,
      listChapters: () => [],
      listConflicts: () => [],
      listForeshadowing: () => [],
      getChapter: () => ({ id: 'chapter-1', positioning: null }),
      listHooksByChapter: () => [],
    }
    orchestrator.promptBuilder = {
      stripEmDash: (value: string) => value,
      buildProseEditorIdentity: () => '文字编辑身份',
    }
    orchestrator.context = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }
    const saveReview = vi.fn(async () => ({}))
    orchestrator.engine = {
      buildChapterConstraints: () => ({ wordBudget: { target: 3000 } }),
      saveReview,
    }
    const agentCalls: string[] = []
    const writerInputs: string[] = []
    orchestrator.runAgent = vi.fn(async (
      agentType: string,
      _projectId: string,
      _chapterNumber: number,
      input: string,
      _options: unknown,
      overrides?: unknown,
    ) => {
      agentCalls.push(agentType)
      if (agentType === 'director') {
        await invokeExtraTool(overrides, DIRECTOR_TOOL_PARAMS)
        return 'Director 已通过工具提交叙事任务'
      }
      if (agentType === 'writer') {
        writerInputs.push(input)
        return agentCalls.filter((item) => item === 'writer').length === 1 ? '过短初稿' : '通过的完整正文'
      }
      // reviewer（含盲审文字编辑 + 最终验收）
      if (agentType === 'reviewer') {
        // 仅在最终验收调用（含 extraTools）时模拟工具提交，盲审不传 extraTools
        await invokeExtraTool(overrides, REVIEWER_TOOL_PARAMS).catch(() => {})
      }
      return '验收通过'
    })
    orchestrator.runPostWriteGuard = vi.fn()
      .mockReturnValueOnce({ shouldRewrite: true, reason: '正文过短', details: '实际 1200 字，目标 3000 字' })
      .mockReturnValueOnce({ shouldRewrite: false, reason: '', details: '' })
    orchestrator.finalizer = {
      finalize: vi.fn(async () => ({ status: 'completed', content: '通过的完整正文' })),
    }

    const result = await orchestrator.createChapterWithFlow('project', 1, {
      arrangedEntities: { characterIds: [], conflictIds: [], foreshadowIds: [], factionIds: [], locationIds: [] },
      onCheckpoint: vi.fn(async (req: { type: string }) =>
        req.type === 'post_write_guard' ? 'rewrite' : 'approve',
      ),
      onProgress: vi.fn(),
    })

    expect(result.status).toBe('completed')
    expect(agentCalls.filter((item) => item === 'director')).toHaveLength(1)
    expect(agentCalls.filter((item) => item === 'writer')).toHaveLength(2)
    expect(agentCalls.filter((item) => item === 'reviewer')).toHaveLength(2)
    expect(writerInputs[1]).toContain('实际 1200 字，目标 3000 字')
    expect(saveReview).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project', chapterId: 'chapter-1', reviewedBy: 'novel-reviewer',
    }))
  })

  it.each([
    {
      decision: 'approve',
      expectedWriterCalls: 1,
      expectedReviserCalls: 0,
      expectedCheckpointTypes: ['narrative_task', 'post_write_guard', 'review'],
    },
    {
      decision: 'revise',
      expectedWriterCalls: 1,
      expectedReviserCalls: 1,
      expectedCheckpointTypes: ['narrative_task', 'post_write_guard'],
    },
    {
      decision: 'rewrite',
      expectedWriterCalls: 2,
      expectedReviserCalls: 0,
      expectedCheckpointTypes: ['narrative_task', 'post_write_guard', 'review'],
    },
  ] as const)('守护检查点选择 $decision 时走独立路径', async ({
    decision,
    expectedWriterCalls,
    expectedReviserCalls,
    expectedCheckpointTypes,
  }) => {
    const { orchestrator, agentCalls } = createDecisionPathOrchestrator()
    orchestrator.runPostWriteGuard = decision === 'rewrite'
      ? vi.fn()
          .mockReturnValueOnce({ shouldRewrite: true, reason: '正文过短', details: '实际 1200 字' })
          .mockReturnValueOnce({ shouldRewrite: false, reason: '', details: '' })
      : vi.fn(() => ({ shouldRewrite: true, reason: '正文过短', details: '实际 1200 字' }))
    const checkpointTypes: string[] = []

    const result = await orchestrator.createChapterWithFlow('project', 1, {
      arrangedEntities: { characterIds: [], conflictIds: [], foreshadowIds: [], clueIds: [], factionIds: [], locationIds: [] },
      onCheckpoint: vi.fn(async (checkpoint: { type: string }) => {
        checkpointTypes.push(checkpoint.type)
        return checkpoint.type === 'post_write_guard' ? decision : 'approve'
      }),
      onProgress: vi.fn(),
    })

    expect(result.status).toBe('completed')
    expect(agentCalls.filter((agent) => agent === 'writer')).toHaveLength(expectedWriterCalls)
    expect(agentCalls.filter((agent) => agent === 'reviser')).toHaveLength(expectedReviserCalls)
    expect(checkpointTypes).toEqual(expectedCheckpointTypes)
  })

  it('叙事任务检查点选择 revise 时重新调用 Director', async () => {
    const orchestrator = Object.create(NovelOrchestrator.prototype) as any
    orchestrator.runStorage = new AsyncLocalStorage()
    orchestrator.pendingUserMessages = new Map()
    orchestrator.store = {
      getProject: () => ({ currentStage: 'setup', rhythmModelId: 'default', currentChapter: 1 }),
      getWritingStyleProfile: () => undefined,
      listChapters: () => [], listConflicts: () => [], listForeshadowing: () => [],
      getChapter: () => ({ id: 'chapter-1', positioning: null }),
      listHooksByChapter: () => [],
    }
    orchestrator.promptBuilder = {
      stripEmDash: (value: string) => value,
      buildProseEditorIdentity: () => '文字编辑身份',
    }
    orchestrator.context = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }
    const agentCalls: string[] = []
    orchestrator.runAgent = vi.fn(async (agentType: string, _p: string, _c: number, _input: string, _opts: unknown, overrides?: unknown) => {
      agentCalls.push(agentType)
      if (agentType === 'director') {
        await invokeExtraTool(overrides, DIRECTOR_TOOL_PARAMS)
        return 'Director 已通过工具提交叙事任务'
      }
      if (agentType === 'writer') return '通过的完整正文'
      if (agentType === 'reviewer') {
        await invokeExtraTool(overrides, REVIEWER_TOOL_PARAMS).catch(() => {})
      }
      return '验收通过'
    })
    orchestrator.runPostWriteGuard = vi.fn(() => ({ shouldRewrite: false, reason: '', details: '' }))
    orchestrator.finalizer = {
      finalize: vi.fn(async () => ({ status: 'completed', content: '通过的完整正文' })),
    }
    const checkpoint = vi.fn()
      .mockResolvedValueOnce('revise')
      .mockResolvedValueOnce('approve')
      .mockResolvedValueOnce('approve')

    const result = await orchestrator.createChapterWithFlow('project', 1, {
      arrangedEntities: { characterIds: [], conflictIds: [], foreshadowIds: [], clueIds: [], factionIds: [], locationIds: [] },
      onCheckpoint: checkpoint,
      onProgress: vi.fn(),
    })

    expect(result.status).toBe('completed')
    expect(agentCalls.filter((item) => item === 'director')).toHaveLength(2)
  })

  it('Writer 最后一次重试退化时保留此前较好的正文交给 Reviewer', async () => {
    const orchestrator = Object.create(NovelOrchestrator.prototype) as any
    orchestrator.runStorage = new AsyncLocalStorage()
    orchestrator.pendingUserMessages = new Map()
    orchestrator.store = {
      getProject: () => ({ currentStage: 'setup', rhythmModelId: 'default', currentChapter: 1 }),
      getWritingStyleProfile: () => undefined,
      listChapters: () => [],
      listConflicts: () => [],
      listForeshadowing: () => [],
      getChapter: () => ({ id: 'chapter-1', positioning: null }),
      listHooksByChapter: () => [],
    }
    orchestrator.promptBuilder = {
      stripEmDash: (value: string) => value,
      buildProseEditorIdentity: () => '文字编辑身份',
    }
    orchestrator.context = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }
    const betterDraft = '这是此前较完整的章节正文。'.repeat(120)
    const degradedDraft = '先核对章纲，再按已批准方案重写第1章正文。'
    const writerResults = ['过短初稿', betterDraft, degradedDraft]
    let reviewedInput = ''
    orchestrator.runAgent = vi.fn(async (agentType: string, _p: string, _c: number, input: string, _opts: unknown, overrides?: unknown) => {
      if (agentType === 'director') {
        await invokeExtraTool(overrides, DIRECTOR_TOOL_PARAMS)
        return 'Director 已通过工具提交叙事任务'
      }
      if (agentType === 'writer') return writerResults.shift()
      if (agentType === 'reviewer') {
        reviewedInput = input
        await invokeExtraTool(overrides, REVIEWER_TOOL_PARAMS).catch(() => {})
      }
      return '验收通过'
    })
    orchestrator.runPostWriteGuard = vi.fn()
      .mockReturnValueOnce({ shouldRewrite: true, reason: '字数严重不足', details: '初稿过短' })
      .mockReturnValueOnce({ shouldRewrite: true, reason: '未完整执行矩阵编排', details: '缺少角色' })
      .mockReturnValueOnce({ shouldRewrite: true, reason: '模型未输出正文', details: '只输出了写作说明' })
      .mockReturnValueOnce({ shouldRewrite: true, reason: '未完整执行矩阵编排', details: '缺少角色' })
    orchestrator.finalizer = {
      finalize: vi.fn(async ({ content }: { content: string }) => ({ status: 'completed', content })),
    }

    const result = await orchestrator.createChapterWithFlow('project', 1, {
      arrangedEntities: { characterIds: [], conflictIds: [], foreshadowIds: [], factionIds: [], locationIds: [] },
      onCheckpoint: vi.fn(async (req: { type: string }) =>
        req.type === 'post_write_guard' ? 'rewrite' : 'approve',
      ),
      onProgress: vi.fn(),
    })

    expect(result.status).toBe('completed')
    expect(reviewedInput).toContain(betterDraft)
    expect(reviewedInput).not.toContain(degradedDraft)
  })
})
