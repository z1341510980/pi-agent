import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NovelStore } from '../core/novel-store.js'
import type { NovelCharacter } from '../core/types.js'
import { novelMigrations } from '../novel-migrations.js'
import type { NovelServices } from '../novel-services.js'
import { createCharacterRoutes } from '../routes/character-routes.js'

function createCharacter(store: NovelStore, projectId: string, name: string): NovelCharacter {
  return store.createCharacter({
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
  })
}

describe('角色弧创建领域约束', () => {
  let database: Database.Database
  let store: NovelStore
  let app: FastifyInstance
  let projectA: string
  let projectB: string

  beforeEach(async () => {
    database = new Database(':memory:')
    database.pragma('foreign_keys = ON')
    for (const migration of novelMigrations) database.exec(migration.sql)
    store = new NovelStore(database)
    projectA = randomUUID()
    projectB = randomUUID()
    for (const [id, title] of [
      [projectA, 'Project A'],
      [projectB, 'Project B']
    ]) {
      store.createProject({
        id,
        title,
        genre: 'test',
        synopsis: '',
        outline: '',
        targetWords: 0,
        currentVolume: 1,
        currentChapter: 1,
        currentStage: 'setup',
        status: 'active'
      })
    }

    app = Fastify()
    const services = { store } as unknown as NovelServices
    for (const route of createCharacterRoutes(services)) {
      app.route({
        method: route.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        url: route.path,
        handler: route.handler as never
      })
    }
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    database.close()
  })

  it('创建角色弧后同步角色阶段投影', async () => {
    const character = createCharacter(store, projectA, '林晚')

    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectA}/character-arcs`,
      payload: {
        characterId: character.id,
        arcType: 'growth',
        currentStage: 'acceptance'
      }
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().data.currentStage).toBe('acceptance')
    expect(store.getCharacter(character.id)?.arcStage).toBe('acceptance')
  })

  it('API 拒绝为同一角色创建第二条弧光', async () => {
    const character = createCharacter(store, projectA, '林晚')
    store.createCharacterArc({
      id: randomUUID(),
      projectId: projectA,
      characterId: character.id,
      arcType: 'growth',
      currentStage: 'denial',
      stageHistory: [],
      description: null,
    })

    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectA}/character-arcs`,
      payload: {
        characterId: character.id,
        arcType: 'growth',
        currentStage: 'acceptance',
      },
    })

    expect(response.statusCode).toBe(409)
    expect(store.listCharacterArcs(projectA)).toHaveLength(1)
  })

  it('API 拒绝引用其他项目的角色', async () => {
    const otherCharacter = createCharacter(store, projectB, '陆川')

    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectA}/character-arcs`,
      payload: {
        characterId: otherCharacter.id,
        arcType: 'growth',
        currentStage: 'acceptance'
      }
    })

    expect(response.statusCode).toBe(404)
    expect(store.listCharacterArcs(projectA)).toHaveLength(0)
    expect(store.getCharacter(otherCharacter.id)?.arcStage).toBe('introduction')
  })

  it('更新角色弧阶段时同步角色阶段投影', async () => {
    const character = createCharacter(store, projectA, '林晚')
    const arc = store.createCharacterArc({
      id: randomUUID(),
      projectId: projectA,
      characterId: character.id,
      arcType: 'growth',
      currentStage: 'denial',
      stageHistory: [],
      description: null
    })

    const response = await app.inject({
      method: 'PUT',
      url: `/character-arcs/${arc.id}`,
      payload: { currentStage: 'acceptance' }
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().data.currentStage).toBe('acceptance')
    expect(store.getCharacter(character.id)?.arcStage).toBe('acceptance')
  })

  it('更新角色弧时拒绝换绑到其他项目的角色', async () => {
    const character = createCharacter(store, projectA, '林晚')
    const otherCharacter = createCharacter(store, projectB, '陆川')
    const arc = store.createCharacterArc({
      id: randomUUID(),
      projectId: projectA,
      characterId: character.id,
      arcType: 'growth',
      currentStage: 'denial',
      stageHistory: [],
      description: null
    })

    const response = await app.inject({
      method: 'PUT',
      url: `/character-arcs/${arc.id}`,
      payload: { characterId: otherCharacter.id }
    })

    expect(response.statusCode).toBe(404)
    expect(store.getCharacterArc(arc.id)?.characterId).toBe(character.id)
  })

  it('Store 拒绝跨项目角色，作为最终不变量保护', () => {
    const otherCharacter = createCharacter(store, projectB, '陆川')

    expect(() =>
      store.createCharacterArc({
        id: randomUUID(),
        projectId: projectA,
        characterId: otherCharacter.id,
        arcType: 'growth',
        currentStage: 'acceptance',
        stageHistory: [],
        description: null
      })
    ).toThrow(`Character ${otherCharacter.id} does not belong to project ${projectA}`)
    expect(store.listCharacterArcs(projectA)).toHaveLength(0)
  })

  it('角色历史 API 拒绝跨项目角色，包括批量入口', async () => {
    const otherCharacter = createCharacter(store, projectB, '陆川')

    const single = await app.inject({
      method: 'POST',
      url: `/projects/${projectA}/characters/${otherCharacter.id}/history`,
      payload: { fieldName: 'currentState' },
    })
    const batch = await app.inject({
      method: 'POST',
      url: `/projects/${projectA}/character-history/batch`,
      payload: { records: [{ characterId: otherCharacter.id, chapterNumber: 1 }] },
    })

    expect(single.statusCode).toBe(404)
    expect(batch.statusCode).toBe(404)
    expect(store.listCharacterHistory(projectA)).toHaveLength(0)
  })
})
