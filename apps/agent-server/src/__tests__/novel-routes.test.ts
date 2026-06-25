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

/** mock characterGenerator.generate 返回固定角色 */
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
      generate: vi.fn(async (_projectId: string, _coreStyle: string) => ({
        name: 'AI 角色',
        description: 'AI 生成',
        identity: '身份',
        personality: '性格',
        appearance: '外貌',
        currentState: '状态',
        currentGoal: '目标',
        currentPressure: '压力',
        secret: '秘密',
        arcStage: 'setup',
        speechStyle: '口语',
      })),
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
  // 清空所有表数据，确保测试独立
  db.exec(`
    DELETE FROM novel_node_positions;
    DELETE FROM novel_character_history;
    DELETE FROM novel_memory_events;
    DELETE FROM novel_memory_snapshots;
    DELETE FROM novel_chapter_reviews;
    DELETE FROM novel_author_intents;
    DELETE FROM novel_information_layers;
    DELETE FROM novel_constraints;
    DELETE FROM novel_style_guides;
    DELETE FROM novel_world_rules;
    DELETE FROM novel_clues;
    DELETE FROM novel_foreshadowing;
    DELETE FROM novel_conflicts;
    DELETE FROM novel_relationships;
    DELETE FROM novel_characters;
    DELETE FROM novel_chapters;
    DELETE FROM novel_projects;
  `)
})

describe('Novel API 路由 - 项目', () => {
  it('POST /projects 创建项目返回 200 + 项目数据', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects`,
      payload: {
        title: '测试小说',
        genre: '玄幻',
        synopsis: '一段简介',
        targetWords: 100000,
      },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.ok).toBe(true)
    expect(body.data.title).toBe('测试小说')
    expect(body.data.genre).toBe('玄幻')
    expect(body.data.id).toBeTruthy()
    expect(body.data.currentStage).toBe('setup')
    expect(body.data.status).toBe('active')
  })

  it('POST /projects 缺少必填字段返回 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects`,
      payload: { genre: '玄幻' }, // 缺少 title
    })
    expect(response.statusCode).toBe(400)
    const body = response.json()
    expect(body.ok).toBe(false)
  })

  it('GET /projects/:id 读取已存在的项目', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects`,
      payload: { title: '查询测试', genre: '科幻', synopsis: '', targetWords: 0 },
    })
    const projectId = createRes.json().data.id

    const response = await app.inject({
      method: 'GET',
      url: `${PLUGIN_PREFIX}/projects/${projectId}`,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().data.title).toBe('查询测试')
  })

  it('GET /projects/:id 不存在返回 404', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${PLUGIN_PREFIX}/projects/nonexistent`,
    })
    expect(response.statusCode).toBe(404)
    const body = response.json()
    expect(body.ok).toBe(false)
  })
})

describe('Novel API 路由 - 节奏模型与建议', () => {
  it('GET /rhythm-models 返回所有节奏模型', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${PLUGIN_PREFIX}/rhythm-models`,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.ok).toBe(true)
    expect(body.data).toBeInstanceOf(Array)
    expect(body.data.length).toBeGreaterThanOrEqual(2)
    const ids = body.data.map((m: { id: string }) => m.id)
    expect(ids).toContain('standard-three-act')
    expect(ids).toContain('webnovel-fast')
  })

  it('GET /projects/:projectId/rhythm-suggestion 返回节奏建议', async () => {
    // 创建项目
    const createRes = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects`,
      payload: { title: '节奏测试', genre: '玄幻', synopsis: '', targetWords: 0 },
    })
    const projectId = createRes.json().data.id

    const response = await app.inject({
      method: 'GET',
      url: `${PLUGIN_PREFIX}/projects/${projectId}/rhythm-suggestion`,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.ok).toBe(true)
    expect(body.data.rhythm).toBeTruthy()
    expect(typeof body.data.arcPosition).toBe('number')
    expect(typeof body.data.reason).toBe('string')
    expect(typeof body.data.description).toBe('string')
  })

  it('GET /projects/:projectId/rhythm-suggestion 支持 chapterNumber 查询参数', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects`,
      payload: { title: '节奏参数', genre: '玄幻', synopsis: '', targetWords: 0 },
    })
    const projectId = createRes.json().data.id

    const response = await app.inject({
      method: 'GET',
      url: `${PLUGIN_PREFIX}/projects/${projectId}/rhythm-suggestion?chapterNumber=6`,
    })
    expect(response.statusCode).toBe(200)
    // 第 6 章默认模型为 climax
    expect(response.json().data.rhythm).toBe('climax')
  })

  it('GET /projects/:projectId/rhythm-suggestion 项目不存在返回 404', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${PLUGIN_PREFIX}/projects/nonexistent/rhythm-suggestion`,
    })
    expect(response.statusCode).toBe(404)
  })
})

describe('Novel API 路由 - 记忆事件', () => {
  it('GET /projects/:projectId/memory-events 返回项目所有事件', async () => {
    // 创建项目并预置事件
    store.createProject({
      id: 'p-mem', title: '记忆测试', genre: 'x', synopsis: '', targetWords: 0,
      currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
    })
    memoryStore.recordEvent({
      projectId: 'p-mem', chapterId: null, chapterNumber: 1,
      eventType: 'character_change', entityId: 'c-1', entityType: 'character',
      description: '角色变更', oldValue: null, newValue: null,
      cause: null, effectIds: [], significance: 5,
    })

    const response = await app.inject({
      method: 'GET',
      url: `${PLUGIN_PREFIX}/projects/p-mem/memory-events`,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.ok).toBe(true)
    expect(body.data).toHaveLength(1)
    expect(body.data[0].description).toBe('角色变更')
  })

  it('GET /projects/:projectId/memory-events 支持 chapterNumber 过滤', async () => {
    store.createProject({
      id: 'p-mem', title: 'x', genre: 'x', synopsis: '', targetWords: 0,
      currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
    })
    memoryStore.recordEvent({
      projectId: 'p-mem', chapterId: null, chapterNumber: 1,
      eventType: 'plot_event', entityId: 'e-1', entityType: 'chapter',
      description: '第一章', oldValue: null, newValue: null,
      cause: null, effectIds: [], significance: 5,
    })
    memoryStore.recordEvent({
      projectId: 'p-mem', chapterId: null, chapterNumber: 2,
      eventType: 'plot_event', entityId: 'e-2', entityType: 'chapter',
      description: '第二章', oldValue: null, newValue: null,
      cause: null, effectIds: [], significance: 5,
    })

    const response = await app.inject({
      method: 'GET',
      url: `${PLUGIN_PREFIX}/projects/p-mem/memory-events?chapterNumber=2`,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].chapterNumber).toBe(2)
  })

  it('GET /projects/:projectId/memory-events 支持 minSignificance 过滤', async () => {
    store.createProject({
      id: 'p-mem2', title: 'x', genre: 'x', synopsis: '', targetWords: 0,
      currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
    })
    memoryStore.recordEvent({
      projectId: 'p-mem2', chapterId: null, chapterNumber: 1,
      eventType: 'plot_event', entityId: 'e-1', entityType: 'chapter',
      description: '低重要性', oldValue: null, newValue: null,
      cause: null, effectIds: [], significance: 3,
    })
    memoryStore.recordEvent({
      projectId: 'p-mem2', chapterId: null, chapterNumber: 1,
      eventType: 'plot_event', entityId: 'e-2', entityType: 'chapter',
      description: '高重要性', oldValue: null, newValue: null,
      cause: null, effectIds: [], significance: 8,
    })

    const response = await app.inject({
      method: 'GET',
      url: `${PLUGIN_PREFIX}/projects/p-mem2/memory-events?minSignificance=7`,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].description).toBe('高重要性')
  })
})

describe('Novel API 路由 - 角色删除', () => {
  it('DELETE /characters/:id 删除已存在的角色', async () => {
    // 先创建项目 + 角色
    const createProject = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects`,
      payload: { title: 'x', genre: 'x', synopsis: '', targetWords: 0 },
    })
    const projectId = createProject.json().data.id
    const createChar = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects/${projectId}/characters`,
      payload: { name: '待删除' },
    })
    const charId = createChar.json().data.id

    const response = await app.inject({
      method: 'DELETE',
      url: `${PLUGIN_PREFIX}/characters/${charId}`,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.ok).toBe(true)
    expect(body.data.deleted).toBe(true)
    expect(body.data.id).toBe(charId)
  })

  it('DELETE /characters/:id 不存在返回 404', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `${PLUGIN_PREFIX}/characters/nonexistent`,
    })
    expect(response.statusCode).toBe(404)
    expect(response.json().ok).toBe(false)
  })
})

describe('Novel API 路由 - AI 角色生成', () => {
  it('POST /projects/:projectId/characters/ai-generate 调用 mock LLM 生成角色', async () => {
    const createProject = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects`,
      payload: { title: 'AI 生成', genre: '玄幻', synopsis: '', targetWords: 0 },
    })
    const projectId = createProject.json().data.id

    const response = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects/${projectId}/characters/ai-generate`,
      payload: { coreStyle: '沉默寡言的剑客' },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.ok).toBe(true)
    expect(body.data.name).toBe('AI 角色')
    expect(body.data.id).toBeTruthy()
    expect(body.data.projectId).toBe(projectId)
    expect(body.data.arcHistory).toBe('[]')
  })

  it('POST /projects/:projectId/characters/ai-generate 缺少 coreStyle 返回 400', async () => {
    const createProject = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects`,
      payload: { title: 'AI 校验', genre: '玄幻', synopsis: '', targetWords: 0 },
    })
    const projectId = createProject.json().data.id

    const response = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects/${projectId}/characters/ai-generate`,
      payload: {},
    })
    expect(response.statusCode).toBe(400)
  })
})

describe('Novel API 路由 - 响应格式', () => {
  it('所有响应包含 ok/data/meta 字段', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${PLUGIN_PREFIX}/rhythm-models`,
    })
    const body = response.json()
    expect(body).toHaveProperty('ok')
    expect(body).toHaveProperty('data')
    expect(body).toHaveProperty('meta')
    expect(body.meta).toHaveProperty('traceId')
    expect(body.meta).toHaveProperty('timestamp')
  })

  it('响应头包含 x-trace-id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${PLUGIN_PREFIX}/rhythm-models`,
    })
    expect(response.headers['x-trace-id']).toBeTruthy()
  })

  it('支持自定义 x-trace-id 请求头', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${PLUGIN_PREFIX}/rhythm-models`,
      headers: { 'x-trace-id': 'custom-trace-123' },
    })
    expect(response.headers['x-trace-id']).toBe('custom-trace-123')
    expect(response.json().meta.traceId).toBe('custom-trace-123')
  })
})
