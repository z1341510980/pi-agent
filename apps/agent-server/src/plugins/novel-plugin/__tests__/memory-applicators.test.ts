import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyCharacterArcChanges,
  applyCharacterMemoryChanges
} from '../core/character-memory-applicator.js'
import type { MemoryOperationCollector } from '../core/memory-change-support.js'
import type { MemoryOperationRecord } from '../core/memory-operation-ledger.js'
import { NovelStore } from '../core/novel-store.js'
import type { NovelCharacter } from '../core/types.js'
import { applyWorldRelationMemoryChanges } from '../core/world-relation-memory-applicator.js'
import { novelMigrations } from '../novel-migrations.js'

const PROJECT_ID = 'memory-applicators-project'

function baseCharacter(
  name: string,
  projectId = PROJECT_ID
): Omit<NovelCharacter, 'createdAt' | 'updatedAt'> {
  return {
    id: randomUUID(),
    projectId,
    name,
    description: '',
    identity: '',
    personality: '',
    appearance: '',
    currentState: '',
    currentGoal: '',
    currentPressure: '',
    secret: '',
    arcStage: 'introduction',
    arcHistory: '[]',
    speechStyle: '',
    isProtagonist: false,
    longTermDesire: '',
    plotRole: 'supporting',
    removalImpact: ''
  }
}

describe('Memory applicator modules', () => {
  let database: Database.Database
  let store: NovelStore
  let operations: Array<Omit<MemoryOperationRecord, 'seq'>>
  let audit: MemoryOperationCollector
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }

  beforeEach(() => {
    database = new Database(':memory:')
    database.pragma('foreign_keys = ON')
    for (const migration of novelMigrations) database.exec(migration.sql)
    store = new NovelStore(database)
    store.createProject({
      id: PROJECT_ID,
      title: 'Memory applicator test',
      genre: 'test',
      synopsis: '',
      outline: '',
      targetWords: 0,
      currentVolume: 1,
      currentChapter: 1,
      currentStage: 'setup',
      status: 'active'
    })
    operations = []
    audit = { push: (operation) => operations.push(operation) }
    vi.clearAllMocks()
  })

  afterEach(() => database.close())

  it('角色 Module 保持同名合并规则，并按角色弧、角色镜像顺序审计', () => {
    const character = store.createCharacter(baseCharacter('林晚'))
    store.createCharacterArc({
      id: 'arc-lin-wan',
      projectId: PROJECT_ID,
      characterId: character.id,
      arcType: 'growth',
      currentStage: 'denial',
      stageHistory: [],
      description: null
    })

    const characterStats = applyCharacterMemoryChanges(
      { projectId: PROJECT_ID, chapterNumber: 2, store, logger: logger as never, audit },
      { characterCreates: [{ name: '林晚', currentState: '承认判断失误', plotRole: 'background' }] }
    )
    const arcStats = applyCharacterArcChanges(
      { projectId: PROJECT_ID, chapterNumber: 2, store, logger: logger as never, audit },
      { arcStageChanges: [{ characterId: character.id, newStage: 'acceptance' }] }
    )

    expect(characterStats).toEqual({
      characterUpdatesApplied: 0,
      characterCreatesApplied: 0,
      characterCreatesDeduped: 1
    })
    expect(arcStats.arcStageChangesApplied).toBe(1)
    expect(store.getCharacter(character.id)).toMatchObject({
      currentState: '承认判断失误',
      plotRole: 'supporting',
      arcStage: 'acceptance'
    })
    expect(operations.map((operation) => [operation.targetType, operation.operation])).toEqual([
      ['character', 'update'],
      ['character_arc', 'update'],
      ['character', 'update']
    ])
  })

  it('新建角色弧时同步角色阶段，并按角色弧、角色镜像顺序审计', () => {
    const character = store.createCharacter(baseCharacter('林晚'))

    const stats = applyCharacterArcChanges(
      { projectId: PROJECT_ID, chapterNumber: 2, store, logger: logger as never, audit },
      {
        arcStageChanges: [
          {
            characterId: character.id,
            arcType: 'growth',
            newStage: 'acceptance',
            triggerEvent: '承认判断失误'
          }
        ]
      }
    )

    expect(stats.arcStageChangesApplied).toBe(1)
    expect(store.getCharacter(character.id)?.arcStage).toBe('acceptance')
    expect(store.getCharacterArcByCharacter(PROJECT_ID, character.id)?.currentStage).toBe(
      'acceptance'
    )
    expect(operations.map((operation) => [operation.targetType, operation.operation])).toEqual([
      ['character_arc', 'create'],
      ['character', 'update']
    ])
    expect(operations[1]?.reason).toBe('memory-generator.applyChanges.characterArcMirror')
  })

  it('跳过不属于当前项目的角色弧变更', () => {
    const otherProjectId = 'memory-applicators-other-project'
    store.createProject({
      id: otherProjectId,
      title: 'Other project',
      genre: 'test',
      synopsis: '',
      outline: '',
      targetWords: 0,
      currentVolume: 1,
      currentChapter: 1,
      currentStage: 'setup',
      status: 'active'
    })
    const otherCharacter = store.createCharacter(baseCharacter('陆川', otherProjectId))

    const stats = applyCharacterArcChanges(
      { projectId: PROJECT_ID, chapterNumber: 2, store, logger: logger as never, audit },
      {
        arcStageChanges: [
          {
            characterId: otherCharacter.id,
            arcType: 'growth',
            newStage: 'acceptance'
          }
        ]
      }
    )

    expect(stats.arcStageChangesApplied).toBe(0)
    expect(store.listCharacterArcs(PROJECT_ID)).toHaveLength(0)
    expect(store.getCharacter(otherCharacter.id)?.arcStage).toBe('introduction')
    expect(operations).toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(
      { projectId: PROJECT_ID, characterId: otherCharacter.id },
      'Memory 角色弧变更引用了当前项目之外的角色，已跳过'
    )
  })

  it('世界关系 Module 解析新物品归属，并将反向人物关系视为同一无向对', () => {
    const characterA = store.createCharacter(baseCharacter('林晚'))
    const characterB = store.createCharacter(baseCharacter('陆川'))
    store.createRelationship({
      id: 'relationship-existing',
      projectId: PROJECT_ID,
      characterA: characterA.id,
      characterB: characterB.id,
      relationType: '同盟',
      currentStage: '试探',
      stageHistory: 'not-json',
      dynamicRole: '',
      alignment: 'temporary_ally',
      trend: 'stable',
      chapterHint: '',
      lastUpdatedChapter: 1
    })

    const stats = applyWorldRelationMemoryChanges(
      { projectId: PROJECT_ID, chapterNumber: 2, store, logger: logger as never, audit },
      {
        itemCreates: [{ name: '钟楼残页', type: 'info', ownerName: '陆川' }],
        relationshipUpdates: [
          {
            characterA: '陆川',
            characterB: '林晚',
            currentStage: '互信',
            changeReason: '共同脱险'
          }
        ],
        relationshipCreates: [{ characterA: '陆川', characterB: '林晚', relationType: '重复关系' }]
      }
    )

    expect(stats).toMatchObject({
      itemCreatesApplied: 1,
      relationshipUpdatesApplied: 1,
      relationshipCreatesApplied: 0
    })
    expect(store.listItems(PROJECT_ID)[0].ownerId).toBe(characterB.id)
    expect(store.listRelationships(PROJECT_ID)).toHaveLength(1)
    expect(JSON.parse(store.listRelationships(PROJECT_ID)[0].stageHistory)).toMatchObject([
      { chapter: 2, fromStage: '试探', toStage: '互信', reason: '共同脱险' }
    ])
    expect(operations.map((operation) => [operation.targetType, operation.operation])).toEqual([
      ['item', 'create'],
      ['relationship', 'update']
    ])
  })
})
