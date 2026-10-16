import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { novelMigrations } from '../novel-migrations.js'
import { NovelMemoryStore } from '../core/novel-memory-store.js'
import { NovelPromptBuilder } from '../core/prompting/prompt-builder.js'
import { NovelStore } from '../core/novel-store.js'

function promptStores(store: NovelStore) {
  return {
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
    listEdgesByEntity: (entityId: string, opts?: { direction?: 'source' | 'target' | 'both'; edgeType?: string }) => store.listEdgesByEntity(entityId, opts),
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
  }
}

describe('Story ledger prompt context', () => {
  let db: Database.Database
  let store: NovelStore
  let memoryStore: NovelMemoryStore

  beforeEach(() => {
    db = new Database(':memory:')
    for (const migration of novelMigrations) db.exec(migration.sql)
    store = new NovelStore(db)
    memoryStore = new NovelMemoryStore(db)
    store.createProject({
      id: 'p1', title: '测试小说', genre: '悬疑', synopsis: '', outline: '', targetWords: 0,
      currentVolume: 1, currentChapter: 9, currentStage: 'rising', status: 'active',
    })
    store.createChapter({
      id: 'ch10', projectId: 'p1', volume: 1, chapterNumber: 10, title: '', content: '',
      wordCount: 0, status: 'planned', narrativeTask: '', outline: '', volumeId: null,
      acceptanceResult: null,
    })
  })

  it('injects prior state semantics and future commitments for a middle chapter', () => {
    memoryStore.createStoryEventWithChanges({
      event: {
        projectId: 'p1', chapterNumber: 9, sceneId: null, sceneOrder: 1,
        type: 'discovery', title: '发现收据', summary: '', outcome: '',
        status: 'confirmed', parentEventId: null, source: 'manual',
      },
      entityRefs: [],
      changes: [{
        subjectType: 'character', subjectId: 'A', dimension: 'relationship.suspicion',
        targetType: 'character', targetId: 'B', valueType: 'level',
        beforeValue: 20, afterValue: 70, reason: '发现染血收据', significance: 8, source: 'manual',
      }],
    })
    memoryStore.createStoryEventWithChanges({
      event: {
        projectId: 'p1', chapterNumber: 12, sceneId: null, sceneOrder: 1,
        type: 'conflict', title: '身份冲突爆发', summary: '', outcome: '',
        status: 'planned', parentEventId: null, source: 'manual',
      },
      entityRefs: [],
      changes: [{
        subjectType: 'conflict', subjectId: 'c1', dimension: 'conflict.stage',
        targetType: null, targetId: null, valueType: 'enum', beforeValue: 'escalating',
        afterValue: 'erupting', reason: '身份公开', significance: 10, source: 'manual',
      }],
    })
    memoryStore.createAnnotation({
      projectId: 'p1', scopeType: 'span', scopeId: null, entityType: 'conflict', entityId: 'c1',
      chapterStart: 8, chapterEnd: 12, kind: 'intent', content: '本章不得解决身份冲突',
      color: 'amber', includeInPrompt: true, resolved: false,
    })

    const promptManager = { render: () => '', getTemplate: () => '' } as any
    const builder = new NovelPromptBuilder(promptManager, promptStores(store), memoryStore)
    const context = builder.buildChapterContextShared(
      'p1', 10,
      { description: '继续调查', type: 'advance_mainline', targetEntity: null, priority: 'medium' },
      { facts: [], cognitive: [], stage: [], narrativeDebts: [], characterArcs: [], conflictTargets: [], suspenseHooks: [] },
    )

    expect(context).toContain('账本承接')
    // 新格式：变化值语义化输出
    expect(context).toContain('70')
    expect(context).toContain('发现染血收据')
    expect(context).toContain('第12章将继续：身份冲突爆发')
    expect(context).toContain('本章不得解决身份冲突')
  })

  it('does NOT inject very old ledger changes into chapter context', () => {
    // 第 1 章的古老变化不应该出现在第 10 章的上下文中
    memoryStore.createStoryEventWithChanges({
      event: {
        projectId: 'p1', chapterNumber: 1, sceneId: null, sceneOrder: 1,
        type: 'character_change' as any, title: '主角初次登场', summary: '', outcome: '',
        status: 'confirmed', parentEventId: null, source: 'manual',
      },
      entityRefs: [],
      changes: [{
        subjectType: 'character', subjectId: 'A', dimension: 'character.arc_stage',
        targetType: null, targetId: null, valueType: 'enum',
        beforeValue: null, afterValue: 'setup', reason: '角色初登场', significance: 5, source: 'manual',
      }],
    })
    // 第 9 章的近期变化应该出现
    memoryStore.createStoryEventWithChanges({
      event: {
        projectId: 'p1', chapterNumber: 9, sceneId: null, sceneOrder: 1,
        type: 'conflict' as any, title: '矛盾激化', summary: '', outcome: '',
        status: 'confirmed', parentEventId: null, source: 'manual',
      },
      entityRefs: [],
      changes: [{
        subjectType: 'conflict', subjectId: 'c1', dimension: 'conflict.intensity',
        targetType: null, targetId: null, valueType: 'number',
        beforeValue: 5, afterValue: 8, reason: '正面交锋', significance: 7, source: 'manual',
      }],
    })

    const promptManager = { render: () => '', getTemplate: () => '' } as any
    const builder = new NovelPromptBuilder(promptManager, promptStores(store), memoryStore)
    const context = builder.buildChapterContextShared(
      'p1', 10,
      { description: '继续调查', type: 'advance_mainline', targetEntity: null, priority: 'medium' },
      { facts: [], cognitive: [], stage: [], narrativeDebts: [], characterArcs: [], conflictTargets: [], suspenseHooks: [] },
    )

    // 古老变化不应出现
    expect(context).not.toContain('主角初次登场')
    expect(context).not.toContain('角色初登场')
    // 近期变化应出现（新格式输出变化缘由而非事件标题）
    expect(context).toContain('正面交锋')
  })

  it('does NOT leak internal English enum values into prompt output', () => {
    // 创建带有各种英文枚举值的实体
    store.createCharacter({
      id: 'char-enum', projectId: 'p1', name: '张三', identity: '侦探',
      personality: '冷静', currentState: '调查中', currentGoal: '找出真相',
      secret: '', arcStage: 'rising', speechStyle: '', plotRole: 'main' as any,
      appearance: '',
    } as any)
    store.createConflict({
      id: 'conf-enum', projectId: 'p1', description: '身份之争',
      type: 'inner', intensity: 7, stage: 'latent', participants: 'char-enum',
      chapterSpans: [[9, 10]], tier: 'main', climaxChapter: null, climaxType: null,
      stakes: '身份暴露', twistPotential: 'medium' as any, plotFunction: 'escalate_conflict' as any,
      progressionMode: 'slow_burn' as any,
    } as any)
    store.createForeshadow({
      id: 'fore-enum', projectId: 'p1', description: '染血的手套',
      category: 'character' as any, status: 'planted', firstChapter: 8, lastChapter: null,
      recoverByChapter: 12, plantMethod: 'dialogue' as any, recoverMethod: 'revelation' as any,
      chapterSpans: [], beats: [{ chapter: 8, type: 'plant' }],
    } as any)
    store.createFaction({
      id: 'fac-enum', projectId: 'p1', name: '暗影会', description: '神秘组织',
      type: 'cult', leaderId: null, ideology: '混沌', strength: 'strong',
      resources: [], allies: [], enemies: [], status: 'active',
      chapterSpans: [[5, 10]],
    } as any)
    store.createLocation({
      id: 'loc-enum', projectId: 'p1', name: '雾都', description: '终年大雾的城市',
      type: 'city', parentId: null, factionId: null, significance: 'major',
      status: 'normal', firstChapter: 1, appearChapters: [1, 5, 9],
    })
    store.createRelationship({
      id: 'rel-enum', projectId: 'p1', characterA: 'char-enum', characterB: 'char-enum',
      relationType: 'hostile', currentStage: 'rising', alignment: 'opponent',
      trend: 'cooling', dynamicRole: 'antagonist', chapterHint: '',
      stageHistory: '', lastUpdatedChapter: 9,
    } as any)

    const promptManager = { render: () => '', getTemplate: () => '' } as any
    const builder = new NovelPromptBuilder(promptManager, promptStores(store), memoryStore)
    const context = builder.buildChapterContextShared(
      'p1', 10,
      { description: '继续调查', type: 'advance_mainline', targetEntity: null, priority: 'medium' },
      { facts: [], cognitive: [], stage: [], narrativeDebts: [], characterArcs: [], conflictTargets: [], suspenseHooks: [] },
    )

    // 内部英文枚举不应出现在输出中
    const leakedEnums = [
      'inner', 'latent', 'planted', 'cult', 'hostile',
      'rising', 'slow_burn', 'dialogue', 'revelation',
    ]
    for (const enumVal of leakedEnums) {
      // 用词边界检测，避免误匹配中文文本中恰好包含的子串
      const regex = new RegExp(`(?<![a-zA-Z_])${enumVal}(?![a-zA-Z_])`)
      expect(context, `内部枚举 "${enumVal}" 不应出现在提示词中`).not.toMatch(regex)
    }

    // 应该出现对应的中文翻译
    expect(context).toContain('内心')    // inner → 内心
    expect(context).toContain('潜伏')    // latent → 潜伏
    expect(context).toContain('教派')    // cult → 教派
    expect(context).toContain('敌对')    // hostile → 敌对
  })
})
