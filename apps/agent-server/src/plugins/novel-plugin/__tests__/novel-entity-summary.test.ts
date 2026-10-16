/**
 * T03-4 实体详情降级测试。
 *
 * 守护：
 * 1. chooseEntityChunkMode 边界（§5.4）：≤8 实体且全量 ≤ 预算 35% → full；否则 summary；
 * 2. buildStoryStateSummary 确定性摘要：角色单行（名称+状态）、占位过滤、冲突阶段/强度、
 *    关系单行、空状态安全、摘要体积上限；
 * 3. buildChapterContextChunks 的 entitySummaryMode 生效（summary 输出远小于 full），
 *    默认 full 保持等价（等价性测试已钉死）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { novelMigrations } from '../novel-migrations.js'
import { NovelMemoryStore } from '../core/novel-memory-store.js'
import { NovelPromptBuilder } from '../core/prompting/prompt-builder.js'
import { NovelStore } from '../core/novel-store.js'
import { buildStoryStateSummary, chooseEntityChunkMode, ON_DEMAND_LIMITS } from '../core/prompting/entity-summary.js'

describe('chooseEntityChunkMode（§5.4）', () => {
  it('≤8 实体且全量 ≤ 预算 35% → full', () => {
    expect(chooseEntityChunkMode({ entityCount: 8, fullTokens: 3500, remainingBudget: 10000 })).toBe('full')
    expect(chooseEntityChunkMode({ entityCount: 1, fullTokens: 100, remainingBudget: 10000 })).toBe('full')
  })

  it('实体数 > 8 → summary', () => {
    expect(chooseEntityChunkMode({ entityCount: 9, fullTokens: 100, remainingBudget: 10000 })).toBe('summary')
    expect(chooseEntityChunkMode({ entityCount: 50, fullTokens: 5000, remainingBudget: 10000 })).toBe('summary')
  })

  it('全量 token 超预算 35% → summary', () => {
    expect(chooseEntityChunkMode({ entityCount: 5, fullTokens: 4000, remainingBudget: 10000 })).toBe('summary')
    expect(chooseEntityChunkMode({ entityCount: 8, fullTokens: 3600, remainingBudget: 10000 })).toBe('summary')
  })
})

describe('buildStoryStateSummary', () => {
  const baseState = {
    project: null as never,
    characters: [],
    relationships: [],
    activeConflicts: [],
    pendingForeshadowing: [],
    activeClues: [],
    activeFactions: [],
    activeLocations: [],
    items: [],
    currentStage: 'rising' as const,
    currentChapter: 3,
  }

  it('空状态安全返回标题', () => {
    const summary = buildStoryStateSummary(baseState)
    expect(summary).toBe('## 当前故事状态（摘要）')
  })

  it('角色单行：名称+状态+目标，占位实体过滤', () => {
    const state = {
      ...baseState,
      characters: [
        { name: '叶明远', currentState: '重伤昏迷', currentGoal: '查明真凶' },
        { name: '（待定）路人', currentState: '无关', currentGoal: '' },
      ] as never,
    }
    const summary = buildStoryStateSummary(state)
    expect(summary).toContain('叶明远')
    expect(summary).toContain('重伤昏迷')
    expect(summary).toContain('目标：查明真凶')
    expect(summary).not.toContain('（待定）')
  })

  it('冲突/关系/伏笔单行摘要', () => {
    const state = {
      ...baseState,
      relationships: [{ characterA: 'A', characterB: 'B', currentStage: 'allied' }] as never,
      activeConflicts: [{ description: '顾问团与主角的数据控制权争夺', stage: 'escalating', intensity: 7 }] as never,
      pendingForeshadowing: [{ description: '染血收据指向陈年旧案' }] as never,
    }
    const summary = buildStoryStateSummary(state)
    expect(summary).toContain('A ↔ B')
    expect(summary).toContain('escalating')
    expect(summary).toContain('/7')
    expect(summary).toContain('染血收据')
  })

  it('长描述被截断（防摘要膨胀）', () => {
    const state = {
      ...baseState,
      activeConflicts: [{ description: '这是一段非常非常非常非常非常非常非常非常非常非常非常长的冲突描述超过二十四个字会被截断', stage: 'x', intensity: 1 }] as never,
    }
    const summary = buildStoryStateSummary(state)
    // 描述被 clip 到 24 字（含省略号标记）
    expect(summary).toContain('…')
    // 总长受控（标题 + 单行摘要 + 按需提示 ≈ 110 字符内）
    expect(summary.length).toBeLessThan(130)
  })

  it('非空摘要携带 novel_ask_story 按需查询提示；空摘要不加', () => {
    const state = {
      ...baseState,
      characters: [{ name: 'A', currentState: 'x', currentGoal: '' }] as never,
    }
    const summary = buildStoryStateSummary(state)
    expect(summary).toContain('novel_ask_story')
    // 空状态无提示
    expect(buildStoryStateSummary(baseState)).not.toContain('novel_ask_story')
  })
})

describe('ON_DEMAND_LIMITS（§5.4 按需查询上限）', () => {
  it('覆盖全部 5 个 Agent 且数值符合方案', () => {
    expect(ON_DEMAND_LIMITS).toEqual({
      director: 4,
      writer: 6,
      reviewer: 4,
      reviser: 2,
      memory: 2,
    })
  })
})

describe('summary 生效路径', () => {
  let db: Database.Database
  let store: NovelStore
  let memoryStore: NovelMemoryStore
  let builder: NovelPromptBuilder

  beforeEach(() => {
    db = new Database(':memory:')
    for (const migration of novelMigrations) db.exec(migration.sql)
    store = new NovelStore(db)
    memoryStore = new NovelMemoryStore(db)
    store.createProject({
      id: 'p1', title: 'summary 测试', genre: 't', synopsis: '', outline: '', targetWords: 0,
      currentVolume: 1, currentChapter: 3, currentStage: 'rising', status: 'active',
    })
    for (const n of [1, 2, 3]) {
      store.createChapter({
        id: `ch${n}`, projectId: 'p1', volume: 1, chapterNumber: n, title: '',
        content: n === 3 ? '' : `第${n}章正文内容`, wordCount: 0,
        status: n === 3 ? 'planned' : 'published',
        narrativeTask: '', outline: '', volumeId: null, acceptanceResult: null,
      })
    }
    store.createCharacter({
      id: 'c1', projectId: 'p1', name: '叶明远', description: '', identity: '', personality: '',
      appearance: '', currentState: '重伤昏迷', currentGoal: '查明真凶', currentPressure: '',
      secret: '', arcStage: '', arcHistory: '', speechStyle: '',
      isProtagonist: true, longTermDesire: '', plotRole: 'protagonist', removalImpact: '',
    })
    const promptManager = { render: () => '', getTemplate: () => '' } as never
    builder = new NovelPromptBuilder(promptManager, {
      getProject: (id: string) => store.getProject(id),
      listWorldRules: (id: string) => store.listWorldRules(id),
      listStyleGuide: (id: string) => store.listStyleGuide(id),
      listCharacters: (id: string) => store.listCharacters(id),
      listRelationships: (id: string) => store.listRelationships(id),
      listConflicts: (id: string) => store.listConflicts(id),
      listForeshadowing: (id: string) => store.listForeshadowing(id),
      listClues: (id: string) => store.listClues(id),
      getClue: (id: string) => store.getClue(id),
      listInformationLayers: (id: string) => store.listInformationLayers(id),
      getInformationLayer: (id: string) => store.getInformationLayer(id),
      listConstraints: (id: string) => store.listConstraints(id),
      listRecentChapters: (id: string, limit: number) => store.listRecentChapters(id, limit),
      listUnfulfilledHooksBefore: (id: string, before: number) => store.listUnfulfilledHooksBefore(id, before),
      getChapter: (id: string, chapter: number) => store.getChapter(id, chapter),
      listEdges: (id: string) => store.listEdges(id),
      listEdgesByEntity: (entityId: string, opts?: unknown) => store.listEdgesByEntity(entityId, opts as never),
      listFactions: (id: string) => store.listFactions(id),
      listLocations: (id: string) => store.listLocations(id),
      listItems: (id: string) => store.listItems(id),
      listWorldElements: (id: string) => store.listWorldElements(id),
      getCharacter: (id: string) => store.getCharacter(id),
      getConflict: (id: string) => store.getConflict(id),
      getForeshadow: (id: string) => store.getForeshadow(id),
      getFaction: (id: string) => store.getFaction(id),
      getLocation: (id: string) => store.getLocation(id),
      getItem: (id: string) => store.getItem(id),
      listVolumes: (id: string) => store.listVolumes(id),
    }, memoryStore)
  })

  it('entitySummaryMode=summary 时 story-state 输出摘要且远小于 full；默认 full 等价', () => {
    const task = { description: '继续调查', type: 'advance_mainline', targetEntity: null, priority: 'medium' } as never
    const constraints = { facts: [], cognitive: [], stage: [], narrativeDebts: [], characterArcs: [], conflictTargets: [], suspenseHooks: [] } as never
    const fullChunks = builder.buildChapterContextChunks('p1', 3, task, constraints)
    const summaryChunks = builder.buildChapterContextChunks('p1', 3, task, constraints, undefined, { entitySummaryMode: 'summary' })
    const fullState = fullChunks.find((c) => c.chunkId === 'story-state')
    const summaryState = summaryChunks.find((c) => c.chunkId === 'story-state')
    expect(fullState).toBeDefined()
    expect(summaryState).toBeDefined()
    // summary 明显更小（只有一行角色）
    expect(summaryState!.content.length).toBeLessThan(fullState!.content.length)
    expect(summaryState!.content).toContain('叶明远')
    // summary 不影响其他 chunk（chapter-info 保持一致）
    expect(fullChunks[0].content).toBe(summaryChunks[0].content)
  })

  it('chooseChapterEntitySummaryMode：单实体保持 full（阈值保护小项目不丢信息）', () => {
    expect(builder.chooseChapterEntitySummaryMode('p1', 3, undefined)).toBe('full')
  })

  it('chooseChapterEntitySummaryMode：无编排且实体超阈值 → summary', () => {
    // 给项目补足 9+ 实体触发阈值
    for (let i = 0; i < 9; i++) {
      store.createCharacter({
        id: `c-bulk-${i}`, projectId: 'p1', name: `角色${i}`, description: '', identity: '',
        personality: '', appearance: '', currentState: '在', currentGoal: '', currentPressure: '',
        secret: '', arcStage: '', arcHistory: '', speechStyle: '',
        isProtagonist: false, longTermDesire: '', plotRole: 'supporting', removalImpact: '',
      })
    }
    expect(builder.chooseChapterEntitySummaryMode('p1', 3, undefined)).toBe('summary')
    // 有编排时强制 full（编排已替代 story-state，summary 无意义）
    expect(builder.chooseChapterEntitySummaryMode('p1', 3, {
      characterIds: ['c1'], conflictIds: [], foreshadowIds: [], factionIds: [], locationIds: [],
    } as never)).toBe('full')
  })
})
