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
    // 以下为 D-3 新增的实体按 ID 查询方法
    getCharacter: (id: string) => store.getCharacter(id),
    getConflict: (id: string) => store.getConflict(id),
    getForeshadow: (id: string) => store.getForeshadow(id),
    getFaction: (id: string) => store.getFaction(id),
    getLocation: (id: string) => store.getLocation(id),
  }
}

describe('buildChapterContext 注入 arrangedEntities', () => {
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
    const ctx = builder.buildChapterContext(
      projectId,
      1,
      { description: '任务', type: 'advance_mainline', targetEntity: null, priority: 'medium' },
      { facts: [], cognitive: [], stage: [], narrativeDebts: [], characterArcs: [], conflictTargets: [], suspenseHooks: [] },
      { characterIds: [charId], conflictIds: [], foreshadowIds: [], factionIds: [], locationIds: [] },
    )
    expect(ctx).toContain('李四')
    expect(ctx).toContain('受伤')
    expect(ctx).toContain('本章必须出现的实体')
  })

  it('不传 arrangedEntities 时不注入编排段（保持向后兼容）', () => {
    const stores = createStoresMock(store)
    const promptManager = { render: () => 'instruction', getTemplate: () => '' } as any
    const builder = new NovelPromptBuilder(promptManager, stores as any)
    const ctx = builder.buildChapterContext(
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
    const ctx = builder.buildChapterContext(
      projectId,
      1,
      { description: '任务', type: 'advance_mainline', targetEntity: null, priority: 'medium' },
      { facts: [], cognitive: [], stage: [], narrativeDebts: [], characterArcs: [], conflictTargets: [], suspenseHooks: [] },
      { characterIds: [], conflictIds: [], foreshadowIds: [], factionIds: [], locationIds: [] },
    )
    expect(ctx).not.toContain('本章必须出现的实体')
  })
})
