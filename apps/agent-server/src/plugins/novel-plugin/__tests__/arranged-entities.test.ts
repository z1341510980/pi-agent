import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelPromptBuilder } from '../core/prompting/prompt-builder.js'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'
import { baseTargetOf, resolveWordBudget } from '../core/chapters/word-budget-resolver.js'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  for (const m of novelMigrations) db.exec(m.sql)
  return db
}

function createLegacyTargetWordsDb(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of novelMigrations) {
    if (migration.id !== '076_project_target_words_to_chapter_words') db.exec(migration.sql)
  }
  return db
}

/**
 * 构造一个仅暴露 NovelPromptBuilder 所需方法的 stores mock，
 * 直接代理到真实的 NovelStore（避免触达 prompt 模板 / engine 等重依赖）。
 */
function createStoresMock(store: NovelStore) {
  return {
    getProject: (id: string) => store.getProject(id),
    listWorldRules: (id: string) => store.listWorldRules(id),
    listStyleGuide: (id: string) => store.listStyleGuide(id),
    listCharacters: (id: string) => store.listCharacters(id),
    listRelationships: (id: string) => store.listRelationships(id),
    listConflicts: (id: string) => store.listConflicts(id),
    listForeshadowing: (id: string) => store.listForeshadowing(id),
    listClues: (id: string) => store.listClues(id),
    listInformationLayers: (id: string) => store.listInformationLayers(id),
    listConstraints: (id: string) => store.listConstraints(id),
    listRecentChapters: (id: string, n: number) => store.listRecentChapters(id, n),
    getChapter: (pid: string, n: number) => store.getChapter(pid, n),
    listEdges: (id: string) => store.listEdges(id),
    listEdgesByEntity: (
      id: string,
      opts?: { direction?: 'source' | 'target' | 'both'; edgeType?: string }
    ) => store.listEdgesByEntity(id, opts),
    listFactions: (id: string) => store.listFactions(id),
    listLocations: (id: string) => store.listLocations(id),
    listItems: (id: string) => store.listItems(id),
    listWorldElements: (id: string) => store.listWorldElements(id),
    listUnfulfilledHooksBefore: (id: string, before: number) =>
      store.listUnfulfilledHooksBefore(id, before),
    listHooksByChapter: (id: string, chapter: number) => store.listHooksByChapter(id, chapter),
    // 以下为 D-3 新增的实体按 ID 查询方法
    getCharacter: (id: string) => store.getCharacter(id),
    getConflict: (id: string) => store.getConflict(id),
    getForeshadow: (id: string) => store.getForeshadow(id),
    getClue: (id: string) => store.getClue(id),
    getFaction: (id: string) => store.getFaction(id),
    getLocation: (id: string) => store.getLocation(id),
    getInformationLayer: (id: string) => store.getInformationLayer(id)
  }
}

describe('buildChapterContextShared 注入 arrangedEntities', () => {
  let db: Database.Database
  let store: NovelStore
  let projectId: string
  let charId: string

  beforeEach(() => {
    db = createTestDb()
    store = new NovelStore(db)
    projectId = randomUUID()
    store.createProject({
      id: projectId,
      title: 't',
      genre: 't',
      synopsis: '',
      outline: '',
      targetWords: 0,
      currentVolume: 1,
      currentChapter: 0,
      currentStage: 'setup',
      status: 'active'
    })
    charId = randomUUID()
    store.createCharacter({
      id: charId,
      projectId,
      name: '李四',
      description: '剑客',
      identity: '',
      personality: '',
      appearance: '',
      currentState: '受伤',
      currentGoal: '',
      currentPressure: '',
      secret: '',
      arcStage: '',
      arcHistory: '[]',
      speechStyle: '',
      isProtagonist: false,
      longTermDesire: '',
      plotRole: 'supporting' as const,
      removalImpact: ''
    })
    store.createChapter({
      id: randomUUID(),
      projectId,
      volume: 1,
      chapterNumber: 1,
      title: '',
      content: '',
      wordCount: 0,
      status: 'planned',
      narrativeTask: '',
      outline: '',
      volumeId: null,
      acceptanceResult: null
    })
  })

  it('传入 arrangedEntities 后 chapterContext 包含角色名与状态', () => {
    const stores = createStoresMock(store)
    // PromptManager mock：render/getTemplate 返回占位字符串，避免触达真实模板加载
    const promptManager = {
      render: () => 'instruction',
      getTemplate: () => ''
    } as any
    // 构造函数签名：(promptManager, stores)
    const builder = new NovelPromptBuilder(promptManager, stores as any)
    const ctx = builder.buildChapterContextShared(
      projectId,
      1,
      { description: '任务', type: 'advance_mainline', targetEntity: null, priority: 'medium' },
      {
        facts: [],
        cognitive: [],
        stage: [],
        narrativeDebts: [],
        characterArcs: [],
        conflictTargets: [],
        suspenseHooks: []
      },
      {
        characterIds: [charId],
        conflictIds: [],
        foreshadowIds: [],
        factionIds: [],
        locationIds: [],
        characterFunctions: [
          { characterId: charId, function: 'provide_resource', note: '交出地图' },
          { characterId: charId, function: 'change_judgment', note: '揭示误判' }
        ]
      }
    )
    expect(ctx).toContain('李四')
    expect(ctx).toContain('受伤')
    expect(ctx).toContain('本章出场要素')
    // 矩阵执行验收已移至 Reviewer 专属 suffix（2026-07-18），不再注入共享 chapterContext
    expect(ctx).toContain('提供资源（交出地图）')
    expect(ctx).toContain('改变主角判断（揭示误判）')
  })

  it('把本章伏笔节点类型和具体内容注入 Writer 上下文', () => {
    const foreshadowId = randomUUID()
    store.createForeshadow({
      id: foreshadowId,
      projectId,
      description: '镜中暗格',
      category: 'secret',
      status: 'planned',
      firstChapter: null,
      lastChapter: null,
      recoverByChapter: null,
      chapterSpans: [],
      beats: [
        { chapter: 1, type: 'plant', note: '擦拭镜面时看见背后的细小划痕' },
        { chapter: 3, type: 'reinforce', note: '划痕与家族徽记吻合' }
      ]
    })
    const builder = new NovelPromptBuilder(
      { render: () => 'instruction', getTemplate: () => '' } as any,
      createStoresMock(store) as any
    )

    const ctx = builder.buildChapterContextShared(
      projectId,
      1,
      { description: '任务', type: 'advance_mainline', targetEntity: null, priority: 'medium' },
      {
        facts: [],
        cognitive: [],
        stage: [],
        narrativeDebts: [],
        characterArcs: [],
        conflictTargets: [],
        suspenseHooks: []
      },
      {
        characterIds: [],
        conflictIds: [],
        foreshadowIds: [foreshadowId],
        factionIds: [],
        locationIds: []
      }
    )

    expect(ctx).toContain('本章节点：埋设')
    expect(ctx).toContain('节点内容：擦拭镜面时看见背后的细小划痕')
    expect(ctx).not.toContain('划痕与家族徽记吻合')
  })

  it('不传 arrangedEntities 时不注入编排段（保持向后兼容）', () => {
    const stores = createStoresMock(store)
    const promptManager = { render: () => 'instruction', getTemplate: () => '' } as any
    const builder = new NovelPromptBuilder(promptManager, stores as any)
    const ctx = builder.buildChapterContextShared(
      projectId,
      1,
      { description: '任务', type: 'advance_mainline', targetEntity: null, priority: 'medium' },
      {
        facts: [],
        cognitive: [],
        stage: [],
        narrativeDebts: [],
        characterArcs: [],
        conflictTargets: [],
        suspenseHooks: []
      }
    )
    expect(ctx).not.toContain('本章必须出现的实体')
  })

  it('传入空的 arrangedEntities（所有数组为空）时不注入编排段', () => {
    const stores = createStoresMock(store)
    const promptManager = { render: () => 'instruction', getTemplate: () => '' } as any
    const builder = new NovelPromptBuilder(promptManager, stores as any)
    const ctx = builder.buildChapterContextShared(
      projectId,
      1,
      { description: '任务', type: 'advance_mainline', targetEntity: null, priority: 'medium' },
      {
        facts: [],
        cognitive: [],
        stage: [],
        narrativeDebts: [],
        characterArcs: [],
        conflictTargets: [],
        suspenseHooks: []
      },
      { characterIds: [], conflictIds: [], foreshadowIds: [], factionIds: [], locationIds: [] }
    )
    expect(ctx).not.toContain('本章必须出现的实体')
    // 故事状态始终注入（跨 Agent 缓存一致性），即使编排数组为空
    expect(ctx).toContain('当前故事状态')
  })

  it('只注入矩阵选中的线索，并给出本章推进要求', () => {
    const selectedClueId = randomUUID()
    const ignoredClueId = randomUUID()
    for (const [id, description] of [
      [selectedClueId, '铜扣来自禁军制式'],
      [ignoredClueId, '窗外有一只乌鸦']
    ] as const) {
      store.createClue({
        id,
        projectId,
        description,
        pointsTo: '父亲死亡真相',
        progress: 20,
        currentStep: '发现物证',
        nextStep: '核查来源',
        isMisleading: false,
        chapterSpans: [[1, 1]]
      })
    }
    const builder = new NovelPromptBuilder(
      { render: () => 'instruction', getTemplate: () => '' } as any,
      createStoresMock(store) as any
    )

    const ctx = builder.buildChapterContextShared(
      projectId,
      1,
      { description: '任务', type: 'advance_mainline', targetEntity: null, priority: 'medium' },
      {
        facts: [],
        cognitive: [],
        stage: [],
        narrativeDebts: [],
        characterArcs: [],
        conflictTargets: [],
        suspenseHooks: []
      },
      {
        characterIds: [],
        conflictIds: [],
        foreshadowIds: [],
        clueIds: [selectedClueId],
        factionIds: [],
        locationIds: []
      }
    )

    expect(ctx).toContain('本章线索')
    expect(ctx).toContain('铜扣来自禁军制式')
    expect(ctx).toContain('核查来源')
    expect(ctx).not.toContain('窗外有一只乌鸦')
  })

  it('信息差只注入矩阵相关项，并展开角色知道、怀疑和误解', () => {
    const selectedForeshadowId = randomUUID()
    store.createForeshadow({
      id: selectedForeshadowId,
      projectId,
      description: '父亲遗物',
      category: 'item',
      status: 'planted',
      firstChapter: 1,
      lastChapter: 1,
      recoverByChapter: 5,
      chapterSpans: [[1, 1]],
      beats: [{ chapter: 1, type: 'plant' }]
    })
    store.createInformationLayer({
      id: randomUUID(),
      projectId,
      infoDescription: '父亲并非死于意外',
      authorKnows: true,
      readerKnows: false,
      characterKnowledge: JSON.stringify({
        [charId]: { knows: false, suspects: true, misunderstands: '以为是山匪所杀' }
      }),
      revealStage: 'development',
      revealChapter: 5,
      isRevealed: false
    })
    store.createInformationLayer({
      id: randomUUID(),
      projectId,
      infoDescription: '无关支线秘密',
      authorKnows: true,
      readerKnows: false,
      characterKnowledge: '{}',
      revealStage: 'development',
      revealChapter: 8,
      isRevealed: false
    })
    const builder = new NovelPromptBuilder(
      { render: () => 'instruction', getTemplate: () => '' } as any,
      createStoresMock(store) as any
    )

    const ctx = builder.buildChapterContextShared(
      projectId,
      1,
      { description: '任务', type: 'advance_mainline', targetEntity: null, priority: 'medium' },
      {
        facts: [],
        cognitive: [],
        stage: [],
        narrativeDebts: [],
        characterArcs: [],
        conflictTargets: [],
        suspenseHooks: []
      },
      {
        characterIds: [charId],
        conflictIds: [],
        foreshadowIds: [selectedForeshadowId],
        clueIds: [],
        factionIds: [],
        locationIds: []
      }
    )

    expect(ctx).toContain('父亲并非死于意外')
    expect(ctx).toContain('李四：怀疑；误解：以为是山匪所杀')
    expect(ctx).not.toContain('无关支线秘密')
  })

  it('把 project.targetWords 直接解释为默认每章目标字数（WordBudgetResolver 语义）', () => {
    // 2026-08-12 逻辑统一：computeChapterTargetWords 已删除，字数统一走 resolveWordBudget
    expect(resolveWordBudget({ baseTarget: 2_500 }).resolvedTarget).toBe(2500)
    expect(resolveWordBudget({ baseTarget: 3_000 }).resolvedTarget).toBe(3000)
    expect(resolveWordBudget({ baseTarget: 5_000 }).resolvedTarget).toBe(5000)
    // 项目 targetWords=0（本 fixture）→ baseTargetOf 回退 3000
    expect(baseTargetOf(0)).toBe(3000)
    expect(baseTargetOf(3_000)).toBe(3000)
    expect(baseTargetOf(undefined)).toBe(3000)
  })

  it('中间章节重写时使用上一章快照，而不是全局最新角色状态', () => {
    store.updateProject(projectId, { currentChapter: 3 })
    const snapshotCharacter = {
      ...store.getCharacter(charId)!,
      currentState: '第二章开篇前的快照状态'
    }
    const memoryStore = {
      listEvents: () => [],
      getCausalChain: () => ({ causes: [], effects: [] }),
      getSnapshot: () => ({
        id: randomUUID(),
        projectId,
        chapterNumber: 1,
        snapshotType: 'full' as const,
        entityId: null,
        createdAt: Date.now(),
        snapshotData: JSON.stringify({
          characters: [snapshotCharacter],
          conflicts: [],
          foreshadowing: [],
          factions: [],
          locations: [],
          relationships: []
        })
      })
    }
    const builder = new NovelPromptBuilder(
      { render: () => '', getTemplate: () => '' } as any,
      createStoresMock(store) as any,
      memoryStore
    )

    const ctx = builder.buildChapterContextShared(
      projectId,
      2,
      {
        description: '重写第二章',
        type: 'advance_mainline',
        targetEntity: null,
        priority: 'medium'
      },
      {
        facts: [],
        cognitive: [],
        stage: [],
        narrativeDebts: [],
        characterArcs: [],
        conflictTargets: [],
        suspenseHooks: []
      }
    )

    expect(ctx).toContain('第二章开篇前的快照状态')
    expect(ctx).not.toContain('状态：受伤')
  })

  it('历史章节的新编排实体只补静态档案，不读取当前表的未来动态状态', () => {
    store.updateProject(projectId, { currentChapter: 2 })
    store.updateCharacter(charId, {
      identity: '码头调查员',
      personality: '谨慎寡言',
      speechStyle: '短句，直答',
      currentState: '未来章已经脱险',
      currentGoal: '未来章追查幕后者',
      currentPressure: '未来章身份即将暴露',
      arcStage: '未来章觉醒',
    })
    const conflict = store.createConflict({
      id: randomUUID(),
      projectId,
      description: '码头追捕',
      type: 'external',
      intensity: 9,
      stage: 'erupting',
      participants: JSON.stringify([charId]),
      chapterSpans: [[2, 2]],
      tier: 'main',
      currentStep: '未来章已经锁定幕后者',
      nextStep: '未来章准备收网',
    } as any)
    store.createChapter({
      id: randomUUID(), projectId, volume: 1, chapterNumber: 2, title: '', content: '',
      wordCount: 0, status: 'planned', narrativeTask: '', outline: '', volumeId: null,
      acceptanceResult: null,
    })
    const memoryStore = {
      listEvents: () => [],
      getCausalChain: () => ({ causes: [], effects: [] }),
      getSnapshot: () => ({
        id: randomUUID(), projectId, chapterNumber: 1, snapshotType: 'full' as const,
        entityId: null, createdAt: Date.now(),
        snapshotData: JSON.stringify({
          characters: [], relationships: [], conflicts: [], foreshadowing: [], clues: [],
          factions: [], locations: [], items: [], worldElements: [], informationLayers: [], edges: [],
        }),
      }),
    }
    const builder = new NovelPromptBuilder(
      { render: () => '', getTemplate: () => '' } as any,
      createStoresMock(store) as any,
      memoryStore,
    )

    const ctx = builder.buildChapterContextShared(
      projectId,
      2,
      { description: '重写第二章', type: 'advance_mainline', targetEntity: null, priority: 'medium' },
      {
        facts: [], cognitive: [], stage: [], narrativeDebts: [], characterArcs: [],
        conflictTargets: [], suspenseHooks: [],
      },
      {
        characterIds: [charId], conflictIds: [conflict.id], foreshadowIds: [], clueIds: [],
        factionIds: [], locationIds: [], itemIds: [],
      },
    )

    expect(ctx).toContain('李四')
    expect(ctx).toContain('码头调查员')
    expect(ctx).toContain('谨慎寡言')
    expect(ctx).toContain('短句，直答')
    expect(ctx).toContain('码头追捕')
    expect(ctx).not.toContain('未来章已经脱险')
    expect(ctx).not.toContain('未来章追查幕后者')
    expect(ctx).not.toContain('未来章身份即将暴露')
    expect(ctx).not.toContain('未来章觉醒')
    expect(ctx).not.toContain('未来章已经锁定幕后者')
    expect(ctx).not.toContain('未来章准备收网')
    expect(ctx).not.toContain('现状：爆发')
    expect(ctx).not.toContain('强度：9/10')
  })

  it('项目 currentChapter 未更新时，仍按实际已写章节识别中间章重写', () => {
    const chapter1 = store.getChapter(projectId, 1)!
    store.completeChapterForReview(chapter1.id, { content: '第一章正文', wordCount: 5 })
    store.createChapter({
      id: randomUUID(),
      projectId,
      volume: 1,
      chapterNumber: 3,
      title: '',
      content: '第三章正文',
      wordCount: 5,
      status: 'review',
      narrativeTask: '',
      outline: '',
      volumeId: null,
      acceptanceResult: null
    })
    const snapshotCharacter = { ...store.getCharacter(charId)!, currentState: '第一章结束时的状态' }
    const memoryStore = {
      listEvents: () => [],
      getCausalChain: () => ({ causes: [], effects: [] }),
      getSnapshot: () => ({
        id: randomUUID(),
        projectId,
        chapterNumber: 1,
        snapshotType: 'full' as const,
        entityId: null,
        createdAt: Date.now(),
        snapshotData: JSON.stringify({
          characters: [snapshotCharacter],
          conflicts: [],
          foreshadowing: [],
          clues: [],
          factions: [],
          locations: [],
          relationships: []
        })
      })
    }
    const builder = new NovelPromptBuilder(
      { render: () => '', getTemplate: () => '' } as any,
      createStoresMock(store) as any,
      memoryStore
    )

    const ctx = builder.buildChapterContextShared(
      projectId,
      2,
      {
        description: '重写第二章',
        type: 'advance_mainline',
        targetEntity: null,
        priority: 'medium'
      },
      {
        facts: [],
        cognitive: [],
        stage: [],
        narrativeDebts: [],
        characterArcs: [],
        conflictTargets: [],
        suspenseHooks: []
      }
    )

    expect(store.getProject(projectId)?.currentChapter).toBe(0)
    expect(ctx).toContain('第一章结束时的状态')
    expect(ctx).not.toContain('状态：受伤')
  })

  it('章节定位可创建、更新并从数据库读回', () => {
    const chapter = store.getChapter(projectId, 1)!
    store.updateChapter(chapter.id, { positioning: 'high_pressure' })
    expect(store.getChapter(projectId, 1)?.positioning).toBe('high_pressure')
    store.updateChapter(chapter.id, { positioning: 'relationship' })
    expect(store.getChapter(projectId, 1)?.positioning).toBe('relationship')
  })

  it('create-flow 的 Writer suffix 使用已批准任务并完整填充定位变量', () => {
    let renderedVariables: Record<string, string> | undefined
    const promptManager = {
      render: (_name: string, variables: Record<string, string>) => {
        renderedVariables = variables
        return `${variables.narrative_task}\n${variables.positioning_guidance}`
      },
      getTemplate: () => ''
    } as any
    const builder = new NovelPromptBuilder(promptManager, createStoresMock(store) as any)
    const approvedPlan = 'Director 检查点已批准的完整叙事方案'

    const suffix = builder.buildChapterContextSuffix(
      projectId,
      1,
      { description: approvedPlan, type: 'create_suspense', targetEntity: null, priority: 'high' },
      {
        facts: [],
        cognitive: [],
        stage: [],
        narrativeDebts: [],
        characterArcs: [],
        conflictTargets: [],
        suspenseHooks: [],
        positioning: 'high_pressure'
      },
      undefined,
      'writer'
    )

    expect(renderedVariables?.narrative_task).toBe(approvedPlan)
    expect(renderedVariables?.positioning_guidance).toContain('高压章')
    expect(suffix).not.toContain('{{positioning_guidance}}')
  })

  it('目标字数只进入 Writer suffix，不污染跨 Agent 共享缓存', () => {
    let renderedVariables: Record<string, string> | undefined
    const builder = new NovelPromptBuilder(
      {
        render: (_name: string, variables: Record<string, string>) => {
          renderedVariables = variables
          return `目标字数：${variables.target_words}`
        },
        getTemplate: () => ''
      } as any,
      createStoresMock(store) as any
    )
    const constraints = {
      facts: [],
      cognitive: [],
      stage: [],
      narrativeDebts: [],
      characterArcs: [],
      conflictTargets: [],
      suspenseHooks: [],
      positioning: 'low_pressure' as const,
      wordBudget: { min: 1913, max: 2588, target: 2250 }
    }

    const shared = builder.buildChapterContextShared(
      projectId,
      1,
      { description: '推进章纲', type: 'advance_mainline', targetEntity: null, priority: 'medium' },
      constraints
    )
    const suffix = builder.buildChapterContextSuffix(
      projectId,
      1,
      {
        description: 'Director 已批准方案',
        type: 'advance_mainline',
        targetEntity: null,
        priority: 'medium'
      },
      constraints,
      undefined,
      'writer'
    )

    expect(shared).not.toContain('目标字数：')
    expect(renderedVariables?.target_words).toBe('2250')
    expect(suffix).toContain('目标字数：2250')
  })

  it('create-flow 的 Reviewer suffix 包含已批准的 Director 方案', () => {
    const builder = new NovelPromptBuilder(
      { render: () => '', getTemplate: () => '' } as any,
      createStoresMock(store) as any
    )
    const suffix = builder.buildChapterContextSuffix(
      projectId,
      1,
      {
        description: '验收必须对照的 Director 方案',
        type: 'advance_mainline',
        targetEntity: null,
        priority: 'medium'
      },
      {
        facts: [],
        cognitive: [],
        stage: [],
        narrativeDebts: [],
        characterArcs: [],
        conflictTargets: [],
        suspenseHooks: []
      },
      undefined,
      'reviewer'
    )

    expect(suffix).toContain('已批准的本章叙事任务')
    expect(suffix).toContain('验收必须对照的 Director 方案')
  })

  it('重写最后一章时，编排实体和信息差仍读取 N-1 快照', () => {
    store.updateProject(projectId, { currentChapter: 2 })
    const chapter2 = store.createChapter({
      id: randomUUID(),
      projectId,
      volume: 1,
      chapterNumber: 2,
      title: '',
      content: '旧的第二章正文',
      wordCount: 7,
      status: 'review',
      narrativeTask: '',
      outline: '',
      volumeId: null,
      acceptanceResult: null
    })
    void chapter2
    const currentLayer = store.createInformationLayer({
      id: randomUUID(),
      projectId,
      infoDescription: '将军其实未死',
      authorKnows: true,
      readerKnows: true,
      characterKnowledge: JSON.stringify({ [charId]: { knows: true } }),
      revealStage: 'reveal',
      revealChapter: 2,
      isRevealed: true
    })
    const snapshotCharacter = {
      ...store.getCharacter(charId)!,
      currentState: '第一章结束时负伤撤离'
    }
    const snapshotLayer = {
      ...currentLayer,
      readerKnows: false,
      characterKnowledge: JSON.stringify({ [charId]: { suspects: true } }),
      isRevealed: false
    }
    const memoryStore = {
      listEvents: () => [],
      getCausalChain: () => ({ causes: [], effects: [] }),
      getSnapshot: () => ({
        id: randomUUID(),
        projectId,
        chapterNumber: 1,
        snapshotType: 'full' as const,
        entityId: null,
        createdAt: Date.now(),
        snapshotData: JSON.stringify({
          characters: [snapshotCharacter],
          conflicts: [],
          foreshadowing: [],
          clues: [],
          factions: [],
          locations: [],
          items: [],
          worldElements: [],
          relationships: [],
          informationLayers: [snapshotLayer],
          edges: []
        })
      })
    }
    const builder = new NovelPromptBuilder(
      { render: () => '', getTemplate: () => '' } as any,
      createStoresMock(store) as any,
      memoryStore
    )

    const context = builder.buildChapterContextShared(
      projectId,
      2,
      {
        description: '重写第二章',
        type: 'advance_mainline',
        targetEntity: null,
        priority: 'medium'
      },
      {
        facts: [],
        cognitive: [],
        stage: [],
        narrativeDebts: [],
        characterArcs: [],
        conflictTargets: [],
        suspenseHooks: []
      },
      {
        characterIds: [charId],
        conflictIds: [],
        foreshadowIds: [],
        clueIds: [],
        factionIds: [],
        locationIds: [],
        itemIds: []
      }
    )

    expect(context).toContain('第一章结束时负伤撤离')
    expect(context).not.toContain('状态：受伤')
    expect(context).toContain('将军其实未死（读者未知')
    expect(context).not.toContain('将军其实未死（读者已知')
  })
})

describe('目标章节字数迁移', () => {
  it('将旧全书目标转换为旧逻辑实际生效的章节目标', () => {
    const db = createLegacyTargetWordsDb()
    const store = new NovelStore(db)
    const projectId = randomUUID()
    store.createProject({
      id: projectId,
      title: '旧项目',
      genre: '玄幻',
      synopsis: '',
      outline: '',
      targetWords: 3_000_000,
      currentVolume: 1,
      currentChapter: 0,
      currentStage: 'setup',
      status: 'active'
    })

    const migration = novelMigrations.find(
      (item) => item.id === '076_project_target_words_to_chapter_words'
    )
    expect(migration).toBeDefined()
    db.exec(migration!.sql)

    expect(store.getProject(projectId)?.targetWords).toBe(3000)
    db.close()
  })
})
