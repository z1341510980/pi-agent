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
