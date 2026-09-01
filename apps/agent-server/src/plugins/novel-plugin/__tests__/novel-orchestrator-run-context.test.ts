import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, expect, it, vi } from 'vitest'
import { NovelOrchestrator } from '../core/novel-orchestrator.js'

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
  requiredReferences: [],
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
    getNovelModelId: () => undefined,
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
    buildReviewFactPack: vi.fn(() => ''),
    getChapterBoundaryContext: () => ({
      chapterNumber: 1,
      fromSnapshot: false,
      state: {},
      entities: {
        characters: [], relationships: [], conflicts: [], foreshadowing: [], clues: [],
        factions: [], locations: [], items: [], worldElements: [], informationLayers: [], edges: [],
      },
    }),
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
    orchestrator.store = { getNovelModelId: () => undefined, getProject: () => ({ novelAskStoryPolicy: null }) }
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

  it('directorReviewerOff keeps the primary Reviewer on full shared chapter context', async () => {
    const { orchestrator } = createDecisionPathOrchestrator()
    orchestrator.store.getProject = () => ({
      currentStage: 'setup', rhythmModelId: 'default', currentChapter: 1,
      novelAskStoryPolicy: 'directorReviewerOff',
    })
    orchestrator.runPostWriteGuard = vi.fn(() => ({ shouldRewrite: false, reason: '' }))

    await orchestrator.createChapterWithFlow('project', 1, {
      onCheckpoint: vi.fn(async () => 'approve'),
      onProgress: vi.fn(),
    })

    const primaryReviewerCall = orchestrator.runAgent.mock.calls.find(
      (call: unknown[]) => call[0] === 'reviewer' && (call[5] as any)?.extraTools,
    )
    expect(primaryReviewerCall?.[5]).toMatchObject({ contextMode: 'full' })
  })

  it('Finalizer uses the project model frozen when the workflow starts', async () => {
    const { orchestrator } = createDecisionPathOrchestrator()
    orchestrator.store.getNovelModelId = () => 'project-provider:project-model'
    orchestrator.runPostWriteGuard = vi.fn(() => ({ shouldRewrite: false, reason: '' }))

    await orchestrator.createChapterWithFlow('project', 1, {
      onCheckpoint: vi.fn(async () => 'approve'),
      onProgress: vi.fn(),
    })

    expect(orchestrator.finalizer.finalize).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        modelId: { provider: 'project-provider', modelId: 'project-model' },
      }),
    }))
  })

  it('injects a Reviser fact pack derived from structured review findings', async () => {
    const { orchestrator } = createDecisionPathOrchestrator()
    orchestrator.runPostWriteGuard = vi.fn(() => ({ shouldRewrite: false, reason: '' }))
    orchestrator.promptBuilder.buildReviewFactPack = vi.fn(() => '## 必要事实引用\n\n- 林深：目标是找到真相')
    const baseRunAgent = orchestrator.runAgent
    orchestrator.runAgent = vi.fn(async (...args: unknown[]) => {
      if (args[0] === 'reviewer' && (args[5] as any)?.extraTools) {
        await invokeExtraTool(args[5], {
          ...REVIEWER_TOOL_PARAMS,
          verdict: 'revise',
          issues: [{ severity: 'S2', category: 'continuity', description: '林深目标与设定冲突' }],
        })
        return '需要修订'
      }
      return baseRunAgent(...args)
    })

    await orchestrator.createChapterWithFlow('project', 1, {
      onCheckpoint: vi.fn(async (checkpoint: { type: string }) => checkpoint.type === 'review' ? 'revise' : 'approve'),
      onProgress: vi.fn(),
    })

    const reviserCall = orchestrator.runAgent.mock.calls.find((call: unknown[]) => call[0] === 'reviser')
    expect(reviserCall?.[3]).toContain('必要事实引用')
    expect(orchestrator.promptBuilder.buildReviewFactPack).toHaveBeenCalledWith(
      'project',
      expect.arrayContaining(['林深目标与设定冲突']),
      undefined,
      expect.objectContaining({ chapterNumber: 1 }),
    )
  })

  it('review 整章重写递归沿用分类预算，耗尽后不再提供 rewrite', async () => {
    const { orchestrator, agentCalls } = createDecisionPathOrchestrator()
    orchestrator.runPostWriteGuard = vi.fn(() => ({ shouldRewrite: false, reason: '' }))
    const reviewCheckpoints: Array<{ data: any; options?: string[] }> = []

    const result = await orchestrator.createChapterWithFlow('project', 1, {
      arrangedEntities: { characterIds: [], conflictIds: [], foreshadowIds: [], factionIds: [], locationIds: [] },
      onCheckpoint: vi.fn(async (checkpoint: { type: string; data: any; options?: string[] }) => {
        if (checkpoint.type !== 'review') return 'approve'
        reviewCheckpoints.push(checkpoint)
        return reviewCheckpoints.length === 1 ? 'rewrite' : 'approve'
      }),
      onProgress: vi.fn(),
    })

    expect(result.status).toBe('completed')
    expect(agentCalls.filter(agent => agent === 'director')).toHaveLength(2)
    expect(reviewCheckpoints[0]?.options).toContain('rewrite')
    expect(reviewCheckpoints[0]?.data.budgetCategories).toMatchObject({
      fullChapterRewrites: 0,
      reviewerRuns: 2,
    })
    expect(reviewCheckpoints[1]?.options).not.toContain('rewrite')
    expect(reviewCheckpoints[1]?.data.budgetCategories).toMatchObject({
      fullChapterRewrites: 1,
      fullChapterRewriteAvailable: false,
      reviewerRuns: 4,
    })
  })

  it('guard_degraded 整章重写耗尽后保留 Reviser 局部修订路径', async () => {
    const { orchestrator, agentCalls } = createDecisionPathOrchestrator()
    orchestrator.runPostWriteGuard = vi.fn(() => ({ shouldRewrite: true, reason: '正文过短', details: '需要修复' }))
    const degradedCheckpoints: Array<{ data: any; options?: string[] }> = []

    const result = await orchestrator.createChapterWithFlow('project', 1, {
      arrangedEntities: { characterIds: [], conflictIds: [], foreshadowIds: [], factionIds: [], locationIds: [] },
      onCheckpoint: vi.fn(async (checkpoint: { type: string; data: any; options?: string[] }) => {
        if (checkpoint.type === 'post_write_guard') return 'rewrite'
        if (checkpoint.type !== 'guard_degraded') return 'approve'
        degradedCheckpoints.push(checkpoint)
        return degradedCheckpoints.length === 1 ? 'rewrite' : 'revise'
      }),
      onProgress: vi.fn(),
    })

    expect(result.status).toBe('completed')
    expect(degradedCheckpoints[0]?.options).toContain('rewrite')
    expect(degradedCheckpoints[1]?.options).not.toContain('rewrite')
    expect(degradedCheckpoints[1]?.options).toContain('revise')
    expect(degradedCheckpoints[1]?.data.budgetCategories).toMatchObject({
      fullChapterRewrites: 1,
      fullChapterRewriteAvailable: false,
      guardWriterRewrites: 4,
    })
    expect(agentCalls.filter(agent => agent === 'reviser')).toHaveLength(1)
  })

  it('PostWriteGuard 拦截未在正文出现的矩阵角色', () => {
    const orchestrator = Object.create(NovelOrchestrator.prototype) as any
    orchestrator.runStorage = new AsyncLocalStorage()
    orchestrator.runStorage.enterWith({
      semiLayerSharedCache: null,
      rhythmSuggestion: { rhythm: 'rising', reason: '推进' },
    })
    orchestrator.store = {
      getNovelModelId: () => undefined,
      getProject: () => ({ targetWords: 1_000_000 }),
      getChapter: () => ({ positioning: null }),
      getCharacter: () => ({ name: '李四' }),
      getFaction: () => undefined,
      getLocation: () => undefined,
    }
    orchestrator.engine = {
      buildChapterConstraints: () => ({ wordBudget: { target: 3000 } }),
    }

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
      getNovelModelId: () => undefined,
      getProject: () => ({ targetWords: 3_000_000 }),
      getChapter: () => ({ positioning: null }),
    }
    orchestrator.engine = {
      buildChapterConstraints: () => ({ wordBudget: { target: 3000 } }),
    }
    const prose = Array.from({ length: 2540 }, (_, index) =>
      String.fromCodePoint(0x4e00 + (index % 1800)),
    ).join('')

    const result = orchestrator.runPostWriteGuard(prose, 'project', 1)

    expect(result.shouldRewrite).toBe(false)
    expect(result.advisory).toBe(true)
    expect(result.reason).toBe('字数低于建议范围')
    expect(result.details).toContain('实际 2540 字')
  })

  it('P0-2：字数低于旧 75% 重写线但高于截断兜底线时只提示不重写', () => {
    const orchestrator = Object.create(NovelOrchestrator.prototype) as any
    orchestrator.runStorage = new AsyncLocalStorage()
    orchestrator.runStorage.enterWith({
      semiLayerSharedCache: null,
      rhythmSuggestion: { rhythm: 'rising', reason: '推进' },
    })
    orchestrator.store = {
      getNovelModelId: () => undefined,
      getProject: () => ({ targetWords: 3_000_000 }),
      getChapter: () => ({ positioning: null }),
      listCharacters: () => [],
    }
    orchestrator.engine = {
      buildChapterConstraints: () => ({ wordBudget: { target: 3000 } }),
    }
    // 2000 字 = 目标的 66.7%：旧逻辑会整章重写，新逻辑只交 Reviewer
    const prose = Array.from({ length: 2000 }, (_, index) =>
      String.fromCodePoint(0x4e00 + (index % 1800)),
    ).join('')

    const result = orchestrator.runPostWriteGuard(prose, 'project', 1)

    expect(result.shouldRewrite).toBe(false)
    expect(result.advisory).toBe(true)
    expect(result.details).toContain('实际 2000 字')
  })

  it('P0-2：低于截断兜底线的残稿仍触发重写', () => {
    const orchestrator = Object.create(NovelOrchestrator.prototype) as any
    orchestrator.runStorage = new AsyncLocalStorage()
    orchestrator.runStorage.enterWith({
      semiLayerSharedCache: null,
      rhythmSuggestion: { rhythm: 'rising', reason: '推进' },
    })
    orchestrator.store = {
      getNovelModelId: () => undefined,
      getProject: () => ({ targetWords: 3_000_000 }),
      getChapter: () => ({ positioning: null }),
      listCharacters: () => [],
    }
    orchestrator.engine = {
      buildChapterConstraints: () => ({ wordBudget: { target: 3000 } }),
    }
    // 900 字 < max(3000*0.5, 800)=1500：疑似截断
    const prose = Array.from({ length: 900 }, (_, index) =>
      String.fromCodePoint(0x4e00 + (index % 1800)),
    ).join('')

    const result = orchestrator.runPostWriteGuard(prose, 'project', 1)

    expect(result.shouldRewrite).toBe(true)
    expect(result.reason).toBe('正文疑似截断')
  })

  it('P0-2 修正：超过 130% 天花板触发定向压缩重写（字数严重超标）', () => {
    const orchestrator = Object.create(NovelOrchestrator.prototype) as any
    orchestrator.runStorage = new AsyncLocalStorage()
    orchestrator.runStorage.enterWith({
      semiLayerSharedCache: null,
      rhythmSuggestion: { rhythm: 'rising', reason: '推进' },
    })
    orchestrator.store = {
      getNovelModelId: () => undefined,
      getProject: () => ({ targetWords: 3_000_000 }),
      getChapter: () => ({ positioning: null }),
      listCharacters: () => [],
    }
    orchestrator.engine = {
      buildChapterConstraints: () => ({ wordBudget: { target: 3000 } }),
    }
    // 4500 字 = 目标的 150%：超过 130% 天花板
    const prose = Array.from({ length: 4500 }, (_, index) =>
      String.fromCodePoint(0x4e00 + (index % 1800)),
    ).join('')

    const result = orchestrator.runPostWriteGuard(prose, 'project', 1)

    expect(result.shouldRewrite).toBe(true)
    expect(result.reason).toBe('字数严重超标')
    // details 数字口径自洽：天花板=3900（target×1.3），不再把 target 称为"天花板"
    expect(result.details).toContain('超过硬上限 3900 字')
    expect(result.details).toContain('达目标 3000 字的 150%')
    expect(result.details).not.toContain('超过天花板 3000')
    // 115%-130% 区间仍为 advisory，不触发重写
    const nearCeiling = Array.from({ length: 3500 }, (_, index) =>
      String.fromCodePoint(0x4e00 + (index % 1800)),
    ).join('')
    const advisoryResult = orchestrator.runPostWriteGuard(nearCeiling, 'project', 1)
    expect(advisoryResult.shouldRewrite).toBe(false)
    expect(advisoryResult.advisory).toBe(true)
  })

  it('P0-2：叙事任务提及但正文未出现的角色降为 advisory', () => {
    const orchestrator = Object.create(NovelOrchestrator.prototype) as any
    orchestrator.runStorage = new AsyncLocalStorage()
    orchestrator.runStorage.enterWith({
      semiLayerSharedCache: null,
      rhythmSuggestion: { rhythm: 'rising', reason: '推进' },
      directorTask: {
        description: '王五在城门口拦住主角，逼问玉佩下落。',
        taskType: 'escalate_conflict',
        priority: 'high',
        secondaryTasks: [],
        povCharacters: ['张三'],
        sceneCount: 1,
      },
    })
    orchestrator.store = {
      getNovelModelId: () => undefined,
      getProject: () => ({ targetWords: 3_000_000 }),
      getChapter: () => ({ positioning: null }),
      listCharacters: () => [
        { id: 'c-1', name: '张三' },
        { id: 'c-2', name: '王五' },
        { id: 'c-3', name: '赵六' },
      ],
      getCharacter: () => undefined,
      getFaction: () => undefined,
      getLocation: () => undefined,
    }
    orchestrator.engine = {
      buildChapterConstraints: () => ({ wordBudget: { target: 3000 } }),
    }
    // 正文只出现张三；王五是任务提及但未出现（非矩阵角色），赵六任务未提及
    const prose = Array.from({ length: 2600 }, (_, index) =>
      String.fromCodePoint(0x4e00 + (index % 1800)),
    ).join('') + '张三握紧了拳头。'

    const result = orchestrator.runPostWriteGuard(
      prose,
      'project',
      1,
      { characterIds: [], conflictIds: [], foreshadowIds: [], factionIds: [], locationIds: [] },
    )

    expect(result.shouldRewrite).toBe(false)
    expect(result.advisory).toBe(true)
    expect(result.details).toContain('王五')
    expect(result.details).not.toContain('赵六')
  })

  it('PostWriteGuard 对势力和地点名称缺失只提示 Reviewer 语义验收', () => {
    const orchestrator = Object.create(NovelOrchestrator.prototype) as any
    orchestrator.runStorage = new AsyncLocalStorage()
    orchestrator.runStorage.enterWith({
      semiLayerSharedCache: null,
      rhythmSuggestion: { rhythm: 'rising', reason: '推进' },
    })
    orchestrator.store = {
      getNovelModelId: () => undefined,
      getProject: () => undefined,
      getFaction: () => ({ name: '国安总局' }),
      getLocation: () => ({ name: '潼关杂役坑' }),
      getCharacter: () => undefined,
    }
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
      getNovelModelId: () => undefined,
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
      getNovelModelId: () => undefined,
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
      getNovelModelId: () => undefined,
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
