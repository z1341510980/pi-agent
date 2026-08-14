import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelEntityGenerator, type GeneratedEntity } from '../plugins/novel-plugin/core/generation/novel-entity-generator.js'
import { NovelMemoryStore } from '../plugins/novel-plugin/core/novel-memory-store.js'
import { NovelStore } from '../plugins/novel-plugin/core/novel-store.js'
import { novelMigrations } from '../plugins/novel-plugin/novel-migrations.js'

describe('NovelEntityGenerator reverse-arrangement projections', () => {
  it('writes newly inferred non-character entities as ledger changes for the matrix', async () => {
    const db = new Database(':memory:')
    try {
      db.pragma('foreign_keys = ON')
      for (const migration of novelMigrations) db.exec(migration.sql)

      const store = new NovelStore(db)
      const memoryStore = new NovelMemoryStore(db)
      const projectId = randomUUID()
      store.createProject({
        id: projectId,
        title: 'Projection test',
        genre: 'test',
        synopsis: '',
        outline: '',
        targetWords: 0,
        currentVolume: 1,
        currentChapter: 0,
        currentStage: 'setup',
        status: 'active',
      })

      const plan = {
        characters: [],
        conflicts: [{ coreStyle: 'a city conflict' }],
        foreshadows: [{ coreStyle: 'an old token' }],
        factions: [{ coreStyle: 'city guard' }],
        locations: [{ coreStyle: 'north gate' }],
        items: [{ coreStyle: 'bronze token' }],
      }
      const generated = new Map<object, GeneratedEntity>([
        [plan.conflicts[0], {
          type: 'conflict',
          data: {
            description: 'The city guard blocks the north gate',
            type: 'relationship',
            intensity: 7,
            stage: 'escalating',
            participants: '[]',
            tier: 'main',
            climaxChapter: null,
            climaxType: null,
            stakes: 'The protagonist cannot leave the city',
            twistPotential: 7,
            plotFunction: 'amplify_conflict',
            progressionMode: 'linear',
          } as any,
        }],
        [plan.foreshadows[0], {
          type: 'foreshadow',
          data: {
            description: 'An old token bears the royal seal',
            category: 'item',
            status: 'planned',
            plantMethod: 'Shown at the gate',
            recoverMethod: 'Used to expose the forged order',
          } as any,
        }],
        [plan.factions[0], {
          type: 'faction',
          data: {
            name: 'City Guard',
            description: 'Guards loyal to the commander',
            type: 'military',
            ideology: 'Order above all',
            strength: 80,
            resources: 'Gate troops',
            allies: 'Commander',
            enemies: 'Smugglers',
            status: 'active',
          } as any,
        }],
        [plan.locations[0], {
          type: 'location',
          data: {
            name: 'North Gate',
            description: 'The northern exit of the city',
            type: 'city_gate',
            significance: 8,
            status: 'active',
          } as any,
        }],
        [plan.items[0], {
          type: 'item',
          data: {
            name: 'Bronze Token',
            description: 'A token with a royal seal',
            type: 'token',
            ownerId: null,
            status: 'active',
            abilities: 'Proves royal authority',
            origin: 'The old palace',
          } as any,
        }],
      ])

      const generator = new NovelEntityGenerator(
        {} as never,
        {} as never,
        {
          logger: {
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
          },
        } as never,
        {} as never,
        store,
        memoryStore,
      )
      ;(generator as any).planEntitiesFromOutline = async () => ({
        plan,
        logContext: {
          systemPrompt: '',
          userMessage: '',
          rawResult: '',
          status: 'success',
          error: '',
        },
      })
      ;(generator as any).generatePlanInBatches = async () => ({
        generated,
        itemCount: generated.size,
        batchCount: 1,
        retryCount: 0,
        fallbackCount: 0,
        unbatchedGenerationCount: 0,
      })

      const arranged = await generator.generateAndArrange(projectId, 7, 'chapter content', undefined, 'content')

      expect(arranged.conflictIds).toHaveLength(1)
      expect(arranged.foreshadowIds).toHaveLength(1)
      expect(arranged.factionIds).toHaveLength(1)
      expect(arranged.locationIds).toHaveLength(1)
      expect(arranged.itemIds).toHaveLength(1)
      const itemId = arranged.itemIds?.[0] ?? ''

      const changes = memoryStore.listChangeRecords(projectId, { chapterNumber: 7 })
      expect(changes).toHaveLength(5)
      expect(changes.map((change) => change.dimension).sort()).toEqual([
        'conflict.created',
        'faction.created',
        'foreshadow.created',
        'item.created',
        'location.created',
      ])
      expect(changes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          subjectType: 'conflict', subjectId: arranged.conflictIds[0],
          dimension: 'conflict.created', valueType: 'reference', source: 'ai-extracted',
          afterValue: { description: 'The city guard blocks the north gate', stage: 'escalating', intensity: 7 },
        }),
        expect.objectContaining({
          subjectType: 'foreshadow', subjectId: arranged.foreshadowIds[0],
          dimension: 'foreshadow.created', valueType: 'reference', source: 'ai-extracted',
          // beats 是矩阵与 arrangedEntities 判定"本章是否涉及该伏笔"的依据，
          // 账本记录一并带上，便于回放时还原伏笔事件链。
          afterValue: { description: 'An old token bears the royal seal', status: 'planted', beats: [{ chapter: 7, type: 'plant' }] },
        }),
        expect.objectContaining({
          subjectType: 'faction', subjectId: arranged.factionIds[0],
          dimension: 'faction.created', valueType: 'reference', source: 'ai-extracted',
          afterValue: { name: 'City Guard', status: 'active', strength: '80.0' },
        }),
        expect.objectContaining({
          subjectType: 'location', subjectId: arranged.locationIds[0],
          dimension: 'location.created', valueType: 'reference', source: 'ai-extracted',
          afterValue: { name: 'North Gate', status: 'active' },
        }),
        expect.objectContaining({
          subjectType: 'item', subjectId: itemId,
          dimension: 'item.created', valueType: 'reference', source: 'ai-extracted',
          afterValue: { name: 'Bronze Token', holder: null, status: 'active' },
        }),
      ]))
    } finally {
      db.close()
    }
  })
})
