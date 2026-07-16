import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelPromptBuilder } from '../core/prompt-builder.js'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  for (const m of novelMigrations) db.exec(m.sql)
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
    listFactions: (id: string) => store.listFactions(id),
    listLocations: (id: string) => store.listLocations(id),
    listWorldElements: (id: string) => store.listWorldElements(id),
    listUnfulfilledHooksBefore: (id: string, before: number) => store.listUnfulfilledHooksBefore(id, before),
    listHooksByChapter: (id: string, chapter: number) => store.listHooksByChapter(id, chapter),
    // 以下为 D-3 新增的实体按 ID 查询方法
    getCharacter: (id: string) => store.getCharacter(id),
    getConflict: (id: string) => store.getConflict(id),
    getForeshadow: (id: string) => store.getForeshadow(id),
    getFaction: (id: string) => store.getFaction(id),
    getLocation: (id: string) => store.getLocation(id),
    getInformationLayer: (id: string) => store.getInformationLayer(id),
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
      status: 'active',
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
      longTermDesire: '', plotRole: 'supporting' as const, removalImpact: '',
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
      acceptanceResult: null,
    })
  })

  it('传入 arrangedEntities 后 chapterContext 包含角色名与状态', () => {
    const stores = createStoresMock(store)
    // PromptManager mock：render/getTemplate 返回占位字符串，避免触达真实模板加载
    const promptManager = {
      render: () => 'instruction',
      getTemplate: () => '',
    } as any
    // 构造函数签名：(promptManager, stores)
    const builder = new NovelPromptBuilder(promptManager, stores as any)
    const ctx = builder.buildChapterContextShared(
      projectId,
      1,
      { description: '任务', type: 'advance_mainline', targetEntity: null, priority: 'medium' },
      { facts: [], cognitive: [], stage: [], narrativeDebts: [], characterArcs: [], conflictTargets: [], suspenseHooks: [] },
      {
        characterIds: [charId], conflictIds: [], foreshadowIds: [], factionIds: [], locationIds: [],
        characterFunctions: [
          { characterId: charId, function: 'provide_resource', note: '交出地图' },
          { characterId: charId, function: 'change_judgment', note: '揭示误判' },
        ],
      },
    )
    expect(ctx).toContain('李四')
    expect(ctx).toContain('受伤')
    expect(ctx).toContain('本章必须出现的实体')
    expect(ctx).toContain('矩阵执行验收')
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
      linkedCharacters: '[]',
      linkedClues: '[]',
      linkedInfoLayers: '[]',
      chapterSpans: [],
      beats: [
        { chapter: 1, type: 'plant', note: '擦拭镜面时看见背后的细小划痕' },
        { chapter: 3, type: 'reinforce', note: '划痕与家族徽记吻合' },
      ],
    })
    const builder = new NovelPromptBuilder(
      { render: () => 'instruction', getTemplate: () => '' } as any,
      createStoresMock(store) as any,
    )

    const ctx = builder.buildChapterContextShared(
      projectId,
      1,
      { description: '任务', type: 'advance_mainline', targetEntity: null, priority: 'medium' },
      { facts: [], cognitive: [], stage: [], narrativeDebts: [], characterArcs: [], conflictTargets: [], suspenseHooks: [] },
      { characterIds: [], conflictIds: [], foreshadowIds: [foreshadowId], factionIds: [], locationIds: [] },
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
      { facts: [], cognitive: [], stage: [], narrativeDebts: [], characterArcs: [], conflictTargets: [], suspenseHooks: [] },
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
      { facts: [], cognitive: [], stage: [], narrativeDebts: [], characterArcs: [], conflictTargets: [], suspenseHooks: [] },
      { characterIds: [], conflictIds: [], foreshadowIds: [], factionIds: [], locationIds: [] },
    )
    expect(ctx).not.toContain('本章必须出现的实体')
  })

  it('把 project.targetWords 始终解释为全书目标字数', () => {
    const builder = new NovelPromptBuilder(
      { render: () => '', getTemplate: () => '' } as any,
      createStoresMock(store) as any,
    )
    const project = store.getProject(projectId)!

    expect(builder.computeChapterTargetWords({ ...project, targetWords: 8_000 })).toBe(2500)
    expect(builder.computeChapterTargetWords({ ...project, targetWords: 3_000_000 })).toBe(3000)
    expect(builder.computeChapterTargetWords({ ...project, targetWords: 5_000_000 })).toBe(5000)
  })

  it('中间章节重写时使用上一章快照，而不是全局最新角色状态', () => {
    store.updateProject(projectId, { currentChapter: 3 })
    const snapshotCharacter = { ...store.getCharacter(charId)!, currentState: '第二章开篇前的快照状态' }
    const memoryStore = {
      listEvents: () => [],
      getCausalChain: () => ({ causes: [], effects: [] }),
      getSnapshot: () => ({
        id: randomUUID(), projectId, chapterNumber: 1, snapshotType: 'full' as const,
        entityId: null, createdAt: Date.now(),
        snapshotData: JSON.stringify({
          characters: [snapshotCharacter], conflicts: [], foreshadowing: [],
          factions: [], locations: [], relationships: [],
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
      { facts: [], cognitive: [], stage: [], narrativeDebts: [], characterArcs: [], conflictTargets: [], suspenseHooks: [] },
    )

    expect(ctx).toContain('第二章开篇前的快照状态')
    expect(ctx).not.toContain('状态：受伤')
  })

  it('项目 currentChapter 未更新时，仍按实际已写章节识别中间章重写', () => {
    const chapter1 = store.getChapter(projectId, 1)!
    store.updateChapter(chapter1.id, { content: '第一章正文', wordCount: 5, status: 'review' })
    store.createChapter({
      id: randomUUID(), projectId, volume: 1, chapterNumber: 3, title: '',
      content: '第三章正文', wordCount: 5, status: 'review', narrativeTask: '', outline: '',
      volumeId: null, acceptanceResult: null,
    })
    const snapshotCharacter = { ...store.getCharacter(charId)!, currentState: '第一章结束时的状态' }
    const memoryStore = {
      listEvents: () => [],
      getCausalChain: () => ({ causes: [], effects: [] }),
      getSnapshot: () => ({
        id: randomUUID(), projectId, chapterNumber: 1, snapshotType: 'full' as const,
        entityId: null, createdAt: Date.now(),
        snapshotData: JSON.stringify({
          characters: [snapshotCharacter], conflicts: [], foreshadowing: [], clues: [],
          factions: [], locations: [], relationships: [],
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
      { facts: [], cognitive: [], stage: [], narrativeDebts: [], characterArcs: [], conflictTargets: [], suspenseHooks: [] },
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
      getTemplate: () => '',
    } as any
    const builder = new NovelPromptBuilder(promptManager, createStoresMock(store) as any)
    const approvedPlan = 'Director 检查点已批准的完整叙事方案'

    const suffix = builder.buildChapterContextSuffix(
      projectId,
      1,
      { description: approvedPlan, type: 'create_suspense', targetEntity: null, priority: 'high' },
      {
        facts: [], cognitive: [], stage: [], narrativeDebts: [], characterArcs: [],
        conflictTargets: [], suspenseHooks: [], positioning: 'high_pressure',
      },
      undefined,
      'writer',
    )

    expect(renderedVariables?.narrative_task).toBe(approvedPlan)
    expect(renderedVariables?.positioning_guidance).toContain('高压章')
    expect(suffix).not.toContain('{{positioning_guidance}}')
  })

  it('create-flow 的 Reviewer suffix 包含已批准的 Director 方案', () => {
    const builder = new NovelPromptBuilder(
      { render: () => '', getTemplate: () => '' } as any,
      createStoresMock(store) as any,
    )
    const suffix = builder.buildChapterContextSuffix(
      projectId,
      1,
      { description: '验收必须对照的 Director 方案', type: 'advance_mainline', targetEntity: null, priority: 'medium' },
      { facts: [], cognitive: [], stage: [], narrativeDebts: [], characterArcs: [], conflictTargets: [], suspenseHooks: [] },
      undefined,
      'reviewer',
    )

    expect(suffix).toContain('已批准的本章叙事任务')
    expect(suffix).toContain('验收必须对照的 Director 方案')
  })
})
