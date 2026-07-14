import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import Database from 'better-sqlite3'
import { NovelStore } from '../plugins/novel-plugin/core/novel-store.js'
import { NovelMemoryStore } from '../plugins/novel-plugin/core/novel-memory-store.js'
import { PromptManager } from '../plugins/novel-plugin/core/prompt-manager.js'
import { NovelPromptBuilder } from '../plugins/novel-plugin/core/prompt-builder.js'
import { createNovelRoutes } from '../plugins/novel-plugin/novel-routes.js'
import { novelMigrations } from '../plugins/novel-plugin/novel-migrations.js'
import type { NovelServices } from '../plugins/novel-plugin/novel-services.js'
import { errorHandlerPlugin } from '../plugins/error-handler.plugin.js'
import { requestContextPlugin } from '../plugins/request-context.plugin.js'

const PLUGIN_PREFIX = '/api/plugins/novel'

let db: Database.Database
let store: NovelStore
let memoryStore: NovelMemoryStore
let promptManager: PromptManager
let promptBuilder: NovelPromptBuilder
let app: FastifyInstance

function makeMockServices(): NovelServices {
  return {
    store,
    memoryStore,
    promptManager,
    promptBuilder,
    sessionFactory: {
      buildSystemPrompt: () => 'mock-system-prompt',
      buildChapterContext: () => 'mock-chapter-context',
      getNovelTools: () => [],
      logSystemPromptHash: () => 'mock-hash',
      logChapterContextHash: () => 'mock-hash',
      store,
      promptManager,
      promptBuilder,
    } as any,
    engine: {
      createChapter: vi.fn(),
      completeChapter: vi.fn(),
      publishChapter: vi.fn(),
    } as any,
    orchestrator: {
      createChapterWithFlow: vi.fn(),
      once: vi.fn(),
      emit: vi.fn(),
    } as any,
    characterGenerator: {
      generate: vi.fn(),
    } as any,
    entityGenerator: {
      generate: vi.fn(),
    } as any,
    similarityScanner: {
      scan: vi.fn(),
    } as any,
    agentConfigStore: {
      getAll: vi.fn(() => []),
      getByType: vi.fn(() => ({ agentType: 'writer', temperature: 0.7 })),
      upsert: vi.fn(),
      upsertMany: vi.fn(),
    } as any,
    confirmationManager: {
      requestDecision: vi.fn(),
      respondDecision: vi.fn(() => true),
      listPending: vi.fn(() => []),
    } as any,
    discussionRunner: {
      run: vi.fn(),
    } as any,
    discussionSettingsStore: {
      get: vi.fn(() => ({})),
      update: vi.fn(),
    } as any,
    chapterChatStore: {
      add: vi.fn(),
      list: vi.fn(() => []),
      clear: vi.fn(),
    } as any,
    chapterChatRunner: {
      run: vi.fn(),
    } as any,
    tools: [],
  }
}

beforeAll(async () => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const m of novelMigrations) {
    db.exec(m.sql)
  }
  store = new NovelStore(db)
  memoryStore = new NovelMemoryStore(db)
  promptManager = new PromptManager(db, process.cwd())
  promptBuilder = new NovelPromptBuilder(promptManager, store)

  app = Fastify({ logger: false })
  await app.register(requestContextPlugin)
  await app.register(errorHandlerPlugin)

  const services = makeMockServices()
  const routes = createNovelRoutes(services)
  for (const route of routes) {
    const fullPath = `${PLUGIN_PREFIX}${route.path}`
    const opts = { handler: route.handler }
    switch (route.method) {
      case 'GET':
        app.get(fullPath, opts)
        break
      case 'POST':
        app.post(fullPath, opts)
        break
      case 'PUT':
        app.put(fullPath, opts)
        break
      case 'DELETE':
        app.delete(fullPath, opts)
        break
      case 'PATCH':
        app.patch(fullPath, opts)
        break
    }
  }
  await app.ready()
})

afterAll(async () => {
  await app.close()
  db.close()
})

beforeEach(() => {
  db.exec(`
    DELETE FROM novel_markers;
    DELETE FROM novel_projects;
  `)
})

async function createProject(): Promise<string> {
  const project = store.createProject({
    id: 'p1',
    title: 'T',
    genre: 'g',
    synopsis: '',
    targetWords: 0,
    currentVolume: 1,
    currentChapter: 0,
    currentStage: 'setup',
    status: 'active',
  } as any)
  return project.id
}

describe('POST /projects/:projectId/markers with in/out type (B2)', () => {
  let projectId: string
  beforeEach(async () => {
    projectId = await createProject()
  })

  it('creates an "in" marker', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects/${projectId}/markers`,
      payload: { chapter: 5, type: 'in', color: 'blue' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.type).toBe('in')
    expect(body.data.chapter).toBe(5)
  })

  it('creates an "out" marker', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects/${projectId}/markers`,
      payload: { chapter: 15, type: 'out', color: 'red' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.type).toBe('out')
  })
})

describe('clip-note marker (B6)', () => {
  let projectId: string
  beforeEach(async () => { projectId = await createProject() })

  it('creates a clip-note marker with entityType/entityId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects/${projectId}/markers`,
      payload: {
        chapter: 5, type: 'clip-note', color: 'purple',
        title: '角色A批注', note: '此处动机不足',
        entityType: 'character', entityId: 'charA',
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.type).toBe('clip-note')
    expect(body.data.entityType).toBe('character')
    expect(body.data.entityId).toBe('charA')
    expect(body.data.note).toBe('此处动机不足')
  })

  it('lists clip-note markers with entityType/entityId', async () => {
    await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects/${projectId}/markers`,
      payload: { chapter: 5, type: 'clip-note', entityType: 'character', entityId: 'charA', note: 'n1' },
    })
    const res = await app.inject({ method: 'GET', url: `${PLUGIN_PREFIX}/projects/${projectId}/markers` })
    const body = JSON.parse(res.body)
    const note = body.data.find((m: any) => m.type === 'clip-note')
    expect(note.entityType).toBe('character')
    expect(note.entityId).toBe('charA')
  })
})

describe('PATCH /markers/:id preserves fields (Zod v4 fix)', () => {
  let projectId: string
  beforeEach(async () => { projectId = await createProject() })

  it('PATCH 仅更新 note，保留 entityType/entityId 及其他字段', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects/${projectId}/markers`,
      payload: {
        chapter: 5, type: 'clip-note', color: 'purple',
        title: '角色A批注', note: 'n1',
        entityType: 'character', entityId: 'charA',
      },
    })
    expect(createRes.statusCode).toBe(200)
    const created = JSON.parse(createRes.body).data
    const markerId = created.id

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `${PLUGIN_PREFIX}/markers/${markerId}`,
      payload: { note: '更新后的批注' },
    })
    expect(patchRes.statusCode).toBe(200)
    const body = JSON.parse(patchRes.body)
    expect(body.data.note).toBe('更新后的批注')
    expect(body.data.entityType).toBe('character')
    expect(body.data.entityId).toBe('charA')
    expect(body.data.title).toBe('角色A批注')
    expect(body.data.type).toBe('clip-note')
    expect(body.data.color).toBe('purple')
    expect(body.data.chapter).toBe(5)
  })

  it('PATCH 仅更新 chapter，保留其他字段', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects/${projectId}/markers`,
      payload: {
        chapter: 5, type: 'clip-note',
        entityType: 'character', entityId: 'charA', note: 'n1',
      },
    })
    expect(createRes.statusCode).toBe(200)
    const markerId = JSON.parse(createRes.body).data.id

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `${PLUGIN_PREFIX}/markers/${markerId}`,
      payload: { chapter: 10 },
    })
    expect(patchRes.statusCode).toBe(200)
    const body = JSON.parse(patchRes.body)
    expect(body.data.chapter).toBe(10)
    expect(body.data.entityType).toBe('character')
    expect(body.data.entityId).toBe('charA')
    expect(body.data.note).toBe('n1')
  })

  it('PATCH 显式清空 note（传 null）', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects/${projectId}/markers`,
      payload: {
        chapter: 5, type: 'clip-note',
        entityType: 'character', entityId: 'charA', note: '原始批注',
      },
    })
    expect(createRes.statusCode).toBe(200)
    const markerId = JSON.parse(createRes.body).data.id

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `${PLUGIN_PREFIX}/markers/${markerId}`,
      payload: { note: null },
    })
    expect(patchRes.statusCode).toBe(200)
    const body = JSON.parse(patchRes.body)
    expect(body.data.note).toBeNull()
    expect(body.data.entityType).toBe('character')
  })
})
