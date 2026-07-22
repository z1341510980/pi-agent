import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import Database from 'better-sqlite3'
import { novelMigrations } from '../plugins/novel-plugin/novel-migrations.js'
import { NovelMemoryStore } from '../plugins/novel-plugin/core/novel-memory-store.js'
import { createStoryLedgerRoutes } from '../plugins/novel-plugin/routes/story-ledger-routes.js'
import type { NovelServices } from '../plugins/novel-plugin/novel-services.js'
import { requestContextPlugin } from '../plugins/request-context.plugin.js'
import { errorHandlerPlugin } from '../plugins/error-handler.plugin.js'

const PREFIX = '/api/plugins/novel'

describe('Story ledger routes', () => {
  let db: Database.Database
  let app: FastifyInstance

  beforeAll(async () => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    for (const migration of novelMigrations) db.exec(migration.sql)
    db.prepare(`
      INSERT INTO novel_projects
        (id, title, genre, synopsis, target_words, current_volume, current_chapter, current_stage, status)
      VALUES ('p1', '测试小说', '悬疑', '', 0, 1, 0, 'setup', 'active')
    `).run()

    const memoryStore = new NovelMemoryStore(db)
    app = Fastify({ logger: false })
    await app.register(requestContextPlugin)
    await app.register(errorHandlerPlugin)
    for (const route of createStoryLedgerRoutes({ memoryStore } as NovelServices)) {
      app.route({
        method: route.method,
        url: `${PREFIX}${route.path}`,
        handler: route.handler,
      } as any)
    }
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    db.close()
  })

  it('creates an event with changes and exposes it in chapter context', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `${PREFIX}/projects/p1/story-events`,
      payload: {
        event: {
          chapterNumber: 9,
          sceneOrder: 1,
          type: 'discovery',
          title: '发现收据',
          status: 'confirmed',
        },
        entityRefs: [
          { entityType: 'character', entityId: 'A', role: 'actor' },
          { entityType: 'clue', entityId: 'receipt', role: 'evidence' },
        ],
        changes: [{
          subjectType: 'character', subjectId: 'A',
          dimension: 'relationship.suspicion', targetType: 'character', targetId: 'B',
          valueType: 'level', beforeValue: 20, afterValue: 70,
          reason: '发现染血收据', significance: 8,
        }],
      },
    })

    expect(create.statusCode).toBe(200)
    expect(create.json().data.changes).toHaveLength(1)

    const context = await app.inject({
      method: 'GET',
      url: `${PREFIX}/projects/p1/chapters/10/story-context`,
    })
    expect(context.statusCode).toBe(200)
    expect(context.json().data.stateBeforeChapter).toContainEqual(expect.objectContaining({
      subjectId: 'A', dimension: 'relationship.suspicion', value: 70,
    }))
    expect(context.json().data.promptDimensions).toContainEqual(expect.objectContaining({
      levelLabel: '强烈', behaviorGuide: expect.stringContaining('主动验证'),
    }))
  })

  it('creates and filters a cross-chapter prompt annotation', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `${PREFIX}/projects/p1/annotations`,
      payload: {
        scopeType: 'span', entityType: 'conflict', entityId: 'c1',
        chapterStart: 8, chapterEnd: 12, kind: 'intent',
        content: '第10章不得解决', includeInPrompt: true,
      },
    })
    expect(create.statusCode).toBe(200)

    const list = await app.inject({
      method: 'GET',
      url: `${PREFIX}/projects/p1/annotations?chapterNumber=10&includeInPrompt=true`,
    })
    expect(list.statusCode).toBe(200)
    expect(list.json().data).toHaveLength(1)
    expect(list.json().data[0].content).toBe('第10章不得解决')
  })

  it('returns every atomic change from an event linked to the focused entity', async () => {
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/projects/p1/story-events`,
      payload: {
        event: { chapterNumber: 12, sceneOrder: 2, type: 'conflict', title: '书房对质', status: 'planned' },
        entityRefs: [{ entityType: 'conflict', entityId: 'c1', role: 'participant' }],
        changes: [
          {
            subjectType: 'character', subjectId: 'A', dimension: 'relationship.suspicion',
            targetType: 'character', targetId: 'B', valueType: 'level', beforeValue: 70, afterValue: 90,
          },
          {
            subjectType: 'item', subjectId: 'key', dimension: 'owner',
            targetType: 'character', targetId: 'A', valueType: 'reference', beforeValue: 'B', afterValue: 'A',
          },
        ],
      },
    })

    const timeline = await app.inject({
      method: 'GET',
      url: `${PREFIX}/projects/p1/entities/conflict/c1/timeline`,
    })

    expect(timeline.statusCode).toBe(200)
    expect(timeline.json().data.events).toHaveLength(1)
    expect(timeline.json().data.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectId: 'A', dimension: 'relationship.suspicion' }),
      expect.objectContaining({ subjectId: 'key', dimension: 'owner' }),
    ]))
  })
})
