import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelPromptBuilder } from '../core/prompting/prompt-builder.js'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  for (const m of novelMigrations) db.exec(m.sql)
  return db
}

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
    getCharacter: (id: string) => store.getCharacter(id),
    getConflict: (id: string) => store.getConflict(id),
    getForeshadow: (id: string) => store.getForeshadow(id),
    getClue: (id: string) => store.getClue(id),
    getFaction: (id: string) => store.getFaction(id),
    getLocation: (id: string) => store.getLocation(id),
    getItem: (id: string) => store.getItem(id),
    getInformationLayer: (id: string) => store.getInformationLayer(id)
  }
}

const EMPTY_CONSTRAINTS = {
  facts: [],
  cognitive: [],
  stage: [],
  narrativeDebts: [],
  characterArcs: [],
  conflictTargets: [],
  suspenseHooks: []
}

describe('对手戏欲望碰撞卡（P1-1）', () => {
  let db: Database.Database
  let store: NovelStore
  let projectId: string
  let charAId: string
  let charBId: string

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
    charAId = randomUUID()
    charBId = randomUUID()
    const baseCharacter = {
      projectId,
      description: '测试角色',
      identity: '',
      personality: '',
      appearance: '',
      currentState: '',
      secret: '',
      arcStage: '',
      arcHistory: '[]',
      speechStyle: '',
      isProtagonist: false,
      longTermDesire: '',
      removalImpact: ''
    }
    store.createCharacter({
      ...baseCharacter,
      id: charAId,
      name: '张三',
      currentGoal: '拿回被扣的工钱',
      currentPressure: '弟弟等钱做手术',
      plotRole: 'protagonist' as const
    })
    store.createCharacter({
      ...baseCharacter,
      id: charBId,
      name: '李四',
      currentGoal: '在天亮前把货运出城',
      currentPressure: '关卡盘查越来越严',
      secret: '他就是告密者',
      plotRole: 'main_opponent' as const
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

  function buildContext(characterIds: string[]): string {
    const builder = new NovelPromptBuilder(
      { render: () => 'instruction', getTemplate: () => '' } as any,
      createStoresMock(store) as any
    )
    return builder.buildChapterContextShared(
      projectId,
      1,
      { description: '任务', type: 'advance_mainline', targetEntity: null, priority: 'medium' },
      EMPTY_CONSTRAINTS as any,
      {
        characterIds,
        conflictIds: [],
        foreshadowIds: [],
        factionIds: [],
        locationIds: []
      }
    )
  }

  it('有关系的两个角色生成欲望碰撞卡，含目标、压力与信息差', () => {
    store.createRelationship({
      id: randomUUID(),
      projectId,
      characterA: charAId,
      characterB: charBId,
      relationType: 'rival',
      currentStage: '对立加深',
      stageHistory: '[]',
      alignment: 'opponent',
      trend: 'cooling',
      dynamicRole: '',
      chapterHint: '',
      lastUpdatedChapter: null
    })
    store.createInformationLayer({
      id: randomUUID(),
      projectId,
      infoDescription: '李四就是向巡防营告密的人',
      authorKnows: true,
      readerKnows: false,
      characterKnowledge: JSON.stringify({ [charBId]: '完全知情' }),
      revealStage: 'climax',
      revealChapter: null,
      isRevealed: false
    })

    const ctx = buildContext([charAId, charBId])

    expect(ctx).toContain('对手戏欲望碰撞')
    expect(ctx).toContain('张三 ↔ 李四')
    expect(ctx).toContain('想要：拿回被扣的工钱')
    expect(ctx).toContain('压力：弟弟等钱做手术')
    expect(ctx).toContain('想要：在天亮前把货运出城')
    expect(ctx).toContain('信息差：李四 知道而 张三 不知道')
    expect(ctx).toContain('潜台词引擎')
    // 写作要求只出现一次（共享页脚）
    expect(ctx.split('不得由旁白宣布共识').length - 1).toBe(1)
  })

  it('双方均无目标/压力/信息差时不注入碰撞卡', () => {
    // 覆盖为目标为空的占位状态
    store.updateCharacter(charAId, { currentGoal: '', currentPressure: '' })
    store.updateCharacter(charBId, { currentGoal: '', currentPressure: '' })

    const ctx = buildContext([charAId, charBId])

    expect(ctx).not.toContain('对手戏欲望碰撞')
  })

  it('无关系记录时对非功能位角色两两配对，功能位角色不参与', () => {
    const ctx = buildContext([charAId, charBId])

    // 无关系记录但有欲望 → 仍按对输出
    expect(ctx).toContain('对手戏欲望碰撞')
    expect(ctx).toContain('张三 ↔ 李四')
    expect(ctx).not.toContain('信息差：')
  })
})
