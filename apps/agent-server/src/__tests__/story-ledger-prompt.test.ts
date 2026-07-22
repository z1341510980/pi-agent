import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { novelMigrations } from '../plugins/novel-plugin/novel-migrations.js'
import { NovelMemoryStore } from '../plugins/novel-plugin/core/novel-memory-store.js'
import { NovelPromptBuilder } from '../plugins/novel-plugin/core/prompt-builder.js'
import { NovelStore } from '../plugins/novel-plugin/core/novel-store.js'

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

    expect(context).toContain('第10章事件账本')
    expect(context).toContain('relationship.suspicion = 70')
    expect(context).toContain('主动验证并防备对方')
    expect(context).toContain('第12章计划：身份冲突爆发')
    expect(context).toContain('本章不得解决身份冲突')
  })
})
