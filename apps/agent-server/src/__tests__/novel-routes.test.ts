import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import Database from 'better-sqlite3'
import { NovelStore } from '../plugins/novel-plugin/core/novel-store.js'
import { NovelMemoryStore } from '../plugins/novel-plugin/core/novel-memory-store.js'
import { PromptManager } from '../plugins/novel-plugin/core/prompting/prompt-manager.js'
import { NovelPromptBuilder } from '../plugins/novel-plugin/core/prompt-builder.js'
import { ConsistencyAuditor } from '../plugins/novel-plugin/core/analysis/consistency-auditor.js'
import { RelationshipGraph } from '../plugins/novel-plugin/core/analysis/novel-relationship-graph.js'
import { createNovelRoutes } from '../plugins/novel-plugin/novel-routes.js'
import { novelMigrations } from '../plugins/novel-plugin/novel-migrations.js'
import { CostReportService } from '../plugins/novel-plugin/core/analysis/cost-report-service.js'
import { ObservabilityService } from '../plugins/novel-plugin/core/analysis/observability-service.js'
import { SharedOverlapAnalyzer } from '../plugins/novel-plugin/core/analysis/shared-overlap-analyzer.js'
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
let services: NovelServices

/** mock characterGenerator.generate 返回固定角色 */
function makeMockServices(): NovelServices {
  return {
    context: {} as any,
    store,
    memoryStore,
    promptManager,
    promptBuilder,
    relationshipGraph: new RelationshipGraph(store, memoryStore),
    consistencyAuditor: new ConsistencyAuditor(store),
    engine: {
      createChapter: vi.fn(),
      completeChapter: vi.fn(),
      publishChapter: vi.fn(),
    } as any,
    orchestrator: {
      createChapterWithFlow: vi.fn(),
      once: vi.fn(),
      emit: vi.fn(),
      clearStaleInterjectMessages: vi.fn(() => []),
    } as any,
    characterGenerator: {
      generate: vi.fn(async (_projectId: string, _coreStyle: string, _onProgress?: (event: unknown) => void) => ({
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
    entityGenerator: {
      generate: vi.fn(),
      generateAndArrange: vi.fn(),
    } as any,
    similarityScanner: {
      scan: vi.fn(),
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
    discussionRunStore: {
      save: vi.fn(),
      get: vi.fn(),
    } as any,
    workflowRunStore: {
      save: vi.fn(),
      get: vi.fn(),
      getLatestResumable: vi.fn(),
    } as any,
    chapterChatStore: {
      add: vi.fn(),
      list: vi.fn(() => []),
      clear: vi.fn(),
    } as any,
    chapterChatRunner: {
      run: vi.fn(),
    } as any,
    outlineGenerator: {
      generate: vi.fn(),
    } as any,
    tools: [],
    costReportService: new CostReportService(db),
    observabilityService: new ObservabilityService(db),
    sharedOverlapAnalyzer: new SharedOverlapAnalyzer(db),
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

  services = makeMockServices()
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
    DELETE FROM novel_agent_logs;
    DELETE FROM novel_discussion_runs;
    DELETE FROM novel_chapter_chat_messages;
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

describe('Novel API 路由 - Agent 日志审计字段', () => {
  it('列表和详情 API 都返回 askStoryPolicy 与 askStoryEnabled', async () => {
    const projectRes = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects`,
      payload: { title: '日志审计测试', genre: '玄幻', synopsis: '', targetWords: 0 },
    })
    const projectId = projectRes.json().data.id as string
    const log = store.insertAgentLog({
      projectId, chapterNumber: 1, agentType: 'director', agentName: '导演',
      displayAgentType: 'director', displayAgentName: '导演', phase: 'directing',
      systemPrompt: 'sys', chapterContext: 'ctx', userMessage: 'msg', taskInput: 'task',
      userInstructions: [], tools: [], toolNames: [], result: 'result', resultLength: 6,
      durationMs: 10, status: 'success', error: '', sessionId: 's',
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      llmProvider: '', llmModel: '', payloadMessagesChars: 0, payloadToolsChars: 0,
      payloadToolCount: 0, payloadTotalChars: 0, llmRoundTrips: 1,
      askStoryPolicy: 'directorReviewerOff', askStoryEnabled: false,
    })

    const listResponse = await app.inject({
      method: 'GET', url: `${PLUGIN_PREFIX}/projects/${projectId}/agent-logs`,
    })
    expect(listResponse.statusCode).toBe(200)
    expect(listResponse.json().data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: log.id, askStoryPolicy: 'directorReviewerOff', askStoryEnabled: false }),
    ]))

    const detailResponse = await app.inject({
      method: 'GET', url: `${PLUGIN_PREFIX}/agent-logs/${log.id}`,
    })
    expect(detailResponse.statusCode).toBe(200)
    expect(detailResponse.json().data).toMatchObject({
      id: log.id, askStoryPolicy: 'directorReviewerOff', askStoryEnabled: false,
    })
  })
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

describe('Novel API 路由 - 伏笔事件链', () => {
  it('PATCH 只更新 beats 时保留埋设点，不注入 null 覆盖兼容字段', async () => {
    const projectRes = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects`,
      payload: { title: '伏笔测试', genre: '悬疑', synopsis: '', targetWords: 0 },
    })
    const projectId = projectRes.json().data.id

    const createRes = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects/${projectId}/foreshadowing`,
      payload: {
        description: '旧钥匙',
        beats: [{ chapter: 2, type: 'plant' }],
      },
    })
    const foreshadowId = createRes.json().data.id

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `${PLUGIN_PREFIX}/foreshadowing/${foreshadowId}`,
      payload: {
        beats: [
          { chapter: 2, type: 'plant', note: '钥匙齿纹与旧锁吻合' },
          { chapter: 5, type: 'reinforce', note: '钥匙再次出现在密室门边' },
        ],
      },
    })

    expect(patchRes.statusCode).toBe(200)
    expect(patchRes.json().data).toMatchObject({
      firstChapter: 2,
      lastChapter: 5,
      recoverByChapter: null,
      status: 'reinforced',
      beats: [
        { chapter: 2, type: 'plant', note: '钥匙齿纹与旧锁吻合' },
        { chapter: 5, type: 'reinforce', note: '钥匙再次出现在密室门边' },
      ],
    })
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

describe('Novel API 路由 - 章节删除', () => {
  it('DELETE /chapters/:id 拒绝删除已发布章节', async () => {
    const project = store.createProject({
      id: 'published-delete-project', title: '已发布删除保护', genre: 'x', synopsis: '',
      targetWords: 0, currentVolume: 1, currentChapter: 1, currentStage: 'setup', status: 'active',
    })
    const chapter = store.createChapter({
      id: 'published-delete-chapter', projectId: project.id, volume: 1, chapterNumber: 1,
      title: '第一章', content: '已发布正文', wordCount: 5, status: 'published',
      narrativeTask: '{}', acceptanceResult: null,
    })

    const response = await app.inject({
      method: 'DELETE',
      url: `${PLUGIN_PREFIX}/chapters/${chapter.id}`,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error.message).toMatch(/已发布章节不能删除/)
    expect(store.getChapterById(chapter.id)).toBeDefined()
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
    expect(response.statusCode, response.body).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')
    // SSE 流：从 novel:result 事件中提取角色数据
    const lines = response.body.split('\n').filter((l: string) => l.startsWith('data: '))
    const resultLine = lines.find((l: string) => l.includes('"name":"novel:result"'))
    expect(resultLine).toBeTruthy()
    const payload = JSON.parse(resultLine!.replace(/^data: /, ''))
    const character = payload.value
    expect(character.name).toBe('AI 角色')
    expect(character.id).toBeTruthy()
    expect(character.projectId).toBe(projectId)
    expect(character.arcHistory).toBe('[]')
  })

  it('POST /projects/:projectId/characters/ai-generate 透传本次指定模型', async () => {
    const createProject = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects`,
      payload: { title: '指定模型', genre: '玄幻', synopsis: '', targetWords: 0 },
    })
    const projectId = createProject.json().data.id
    const modelId = { provider: 'provider-a', modelId: 'model-a' }

    const response = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects/${projectId}/characters/ai-generate`,
      payload: { coreStyle: '冷静的谋士', modelId },
    })

    expect(response.statusCode, response.body).toBe(200)
    expect(services.characterGenerator.generate).toHaveBeenLastCalledWith(
      projectId,
      '冷静的谋士',
      expect.any(Function),
      undefined,
      modelId,
    )
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

describe('Novel API 路由 - 文风工厂', () => {
  it('保存文风档案并预览 Writer 编译结果', async () => {
    const createProject = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects`,
      payload: { title: '文风测试', genre: '悬疑', synopsis: '', targetWords: 100000 },
    })
    const projectId = createProject.json().data.id
    const saveResponse = await app.inject({
      method: 'PUT',
      url: `${PLUGIN_PREFIX}/projects/${projectId}/writing-style-profile`,
      payload: {
        name: '冷峻克制',
        preset: 'restrained',
        narrativePerson: 'third',
        narrativeDistance: 'limited',
        sentenceRhythm: 'short',
        dialogueRatio: 40,
        emotionalTemperature: 3,
        imageryDensity: 2,
        vocabularyRegister: 'plain',
        hardRules: ['不替读者总结'],
        softRules: ['动作优先'],
        positiveExamples: ['雨落下来，院子里没有人动。檐下的水一滴一滴砸在石阶上。'],
        notes: '',
      },
    })

    expect(saveResponse.statusCode, saveResponse.body).toBe(200)
    expect(saveResponse.json().data).toMatchObject({ name: '冷峻克制', version: 1 })

    const getResponse = await app.inject({
      method: 'GET',
      url: `${PLUGIN_PREFIX}/projects/${projectId}/writing-style-profile`,
    })
    expect(getResponse.statusCode).toBe(200)
    expect(getResponse.json().data.hardRules).toEqual(['不替读者总结'])

    const previewResponse = await app.inject({
      method: 'GET',
      url: `${PLUGIN_PREFIX}/projects/${projectId}/writing-style-profile/preview?target=writer`,
    })
    expect(previewResponse.statusCode, previewResponse.body).toBe(200)
    expect(previewResponse.json().data.content).toContain('项目文风档案：冷峻克制')
    expect(previewResponse.json().data.profileHash).toHaveLength(16)
  })

  it('拒绝超出范围的文风参数', async () => {
    const createProject = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects`,
      payload: { title: '文风校验', genre: '悬疑', synopsis: '', targetWords: 100000 },
    })
    const projectId = createProject.json().data.id
    const response = await app.inject({
      method: 'PUT',
      url: `${PLUGIN_PREFIX}/projects/${projectId}/writing-style-profile`,
      payload: {
        name: '非法参数',
        preset: 'custom',
        narrativePerson: 'third',
        narrativeDistance: 'limited',
        sentenceRhythm: 'balanced',
        dialogueRatio: 100,
        emotionalTemperature: 5,
        imageryDensity: 3,
        vocabularyRegister: 'plain',
        hardRules: [],
        softRules: [],
        positiveExamples: [],
        notes: '',
      },
    })
    expect(response.statusCode).toBe(400)
  })

  it('可以对已有章节执行确定性正文形态扫描', async () => {
    const project = store.createProject({
      id: 'prose-quality-project', title: '正文扫描', genre: '悬疑', synopsis: '', targetWords: 100000,
      currentVolume: 1, currentChapter: 1, currentStage: 'setup', status: 'active',
    })
    store.createChapter({
      id: 'prose-quality-chapter', projectId: project.id, volume: 1, chapterNumber: 1,
      title: '测试章', content: Array.from({ length: 30 }, (_, index) => `他停下了${index}。`).join('\n\n'),
      wordCount: 180, status: 'drafting', narrativeTask: '测试', acceptanceResult: null,
    })

    const response = await app.inject({
      method: 'GET',
      url: `${PLUGIN_PREFIX}/projects/${project.id}/chapters/1/prose-quality`,
    })

    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().data.metrics.singleSentenceParagraphs).toBe(30)
    expect(response.json().data.issues.map((issue: { code: string }) => issue.code)).toContain('fragmented_paragraphs')
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

describe('Novel API 路由 - 大流程统一取消', () => {
  it.each([
    ['workflow', 'create-flow'],
    ['discussion', 'create-discussion'],
    ['ai-arrange', 'ai-arrange'],
    ['reverse-arrange', 'reverse-arrange'],
  ] as const)('%s 会把取消信号传到后端任务并释放锁', async (kind, endpoint) => {
    const project = store.createProject({
      id: `cancel-${kind}`,
      title: `${kind} 取消测试`,
      genre: '都市',
      synopsis: '',
      outline: '',
      targetWords: 3000,
      currentVolume: 1,
      currentChapter: 0,
      currentStage: 'setup',
      status: 'active',
    } as any)
    store.createChapter({
      id: `chapter-${kind}`,
      projectId: project.id,
      volume: 1,
      chapterNumber: 9,
      title: '第九章',
      outline: '有效章纲',
      content: '已写好的章节正文，用于反推编排测试。',
      wordCount: 20,
      status: 'planned',
      narrativeTask: '',
      acceptanceResult: null,
    } as any)

    let started!: (signal: AbortSignal) => void
    const taskStarted = new Promise<AbortSignal>((resolve) => { started = resolve })
    const completeWhenAborted = <T>(signal: AbortSignal, value: T): Promise<T> => {
      started(signal)
      return new Promise<T>((resolve) => {
        if (signal.aborted) return resolve(value)
        signal.addEventListener('abort', () => resolve(value), { once: true })
      })
    }

    if (kind === 'workflow') {
      services.orchestrator.createChapterWithFlow = vi.fn((_projectId, _chapterNumber, options) =>
        completeWhenAborted(options.signal!, { status: 'cancelled' })) as any
    } else if (kind === 'discussion') {
      services.discussionRunner.run = vi.fn((_projectId, _chapterNumber, options) =>
        completeWhenAborted(options.signal!, { status: 'cancelled', transcript: [], scenes: [] })) as any
    } else {
      services.entityGenerator.generateAndArrange = vi.fn(
        (_projectId, _chapterNumber, _source, _onProgress, _sourceType, signal) => {
          started(signal)
          return new Promise((_resolve, reject) => {
            const rejectAbort = () => reject(signal.reason ?? new Error('已取消'))
            if (signal.aborted) return rejectAbort()
            signal.addEventListener('abort', rejectAbort, { once: true })
          })
        },
      ) as any
    }

    const flowResponsePromise = app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects/${project.id}/chapters/9/${endpoint}`,
      payload: {},
    })
    const signal = await taskStarted
    expect(signal.aborted).toBe(false)

    const cancelResponse = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects/${project.id}/chapters/9/cancel-active-flow`,
      payload: {},
    })
    expect(cancelResponse.statusCode, cancelResponse.body).toBe(200)
    expect(cancelResponse.json().data).toMatchObject({ cancelled: true, kind })

    await flowResponsePromise
    expect(signal.aborted).toBe(true)

    const afterFinished = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects/${project.id}/chapters/9/cancel-active-flow`,
      payload: {},
    })
    expect(afterFinished.json().data.cancelled).toBe(false)
  })
})

describe('Novel API 路由 - Agent 角色温度配置', () => {
  it('GET /agent-config 返回 5 角色默认温度（mock 未注入 agentManager，回退默认值）', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${PLUGIN_PREFIX}/agent-config`,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.ok).toBe(true)
    expect(body.data).toBeInstanceOf(Array)
    expect(body.data).toHaveLength(5)

    // 验证 5 个角色全部出现
    const types = body.data.map((x: { agentType: string }) => x.agentType)
    expect(types).toEqual(expect.arrayContaining(['director', 'writer', 'reviser', 'reviewer', 'memory']))

    // 验证每条记录有 agentType 和 temperature 两个字段，且为默认值
    for (const item of body.data) {
      expect(typeof item.agentType).toBe('string')
      expect(typeof item.temperature).toBe('number')
    }

    // 抽查 writer 默认温度
    const writer = body.data.find((x: { agentType: string }) => x.agentType === 'writer')
    expect(writer.temperature).toBe(0.9)
  })

  it('PUT /agent-config 更新温度后 GET 立即返回新值（mock 无 agentManager 时为 no-op，仍返回默认值）', async () => {
    // mock 中 services.agentManager = undefined
    //   updateNovelAgentTemperatures(items, undefined) → no-op
    //   getAllNovelAgentTemperatures(undefined) → 返回默认值
    // 因此 PUT 不会改变状态，但仍返回 200 + 默认温度列表
    const putResponse = await app.inject({
      method: 'PUT',
      url: `${PLUGIN_PREFIX}/agent-config`,
      payload: {
        items: [
          { agentType: 'writer', temperature: 1.2 },
          { agentType: 'reviewer', temperature: 0.5 },
        ],
      },
    })
    expect(putResponse.statusCode).toBe(200)
    const putBody = putResponse.json()
    expect(putBody.ok).toBe(true)
    expect(putBody.data).toBeInstanceOf(Array)
    expect(putBody.data).toHaveLength(5)

    // mock 无 agentManager，update 为 no-op，返回值仍为默认
    const writer = putBody.data.find((x: { agentType: string }) => x.agentType === 'writer')
    expect(writer.temperature).toBe(0.9)
    const reviewer = putBody.data.find((x: { agentType: string }) => x.agentType === 'reviewer')
    expect(reviewer.temperature).toBe(0.3)
  })

  it('PUT /agent-config 温度超出 [0, 2] 范围返回 400', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `${PLUGIN_PREFIX}/agent-config`,
      payload: {
        items: [
          { agentType: 'writer', temperature: 3.5 },  // 超过 max(2)
        ],
      },
    })
    expect(response.statusCode).toBe(400)
    const body = response.json()
    expect(body.ok).toBe(false)
  })

  it('PUT /agent-config 温度为负数返回 400', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `${PLUGIN_PREFIX}/agent-config`,
      payload: {
        items: [
          { agentType: 'writer', temperature: -0.1 },  // 低于 min(0)
        ],
      },
    })
    expect(response.statusCode).toBe(400)
  })

  it('PUT /agent-config agentType 非法返回 400', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `${PLUGIN_PREFIX}/agent-config`,
      payload: {
        items: [
          { agentType: 'unknown-agent', temperature: 0.5 },
        ],
      },
    })
    expect(response.statusCode).toBe(400)
  })

  it('PUT /agent-config 空数组返回 200 + 默认温度列表', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `${PLUGIN_PREFIX}/agent-config`,
      payload: { items: [] },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.ok).toBe(true)
    expect(body.data).toHaveLength(5)
  })
})

describe('observability 路由', () => {
  it('项目不存在返回 404', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${PLUGIN_PREFIX}/projects/nonexistent/observability/overview`,
    })
    expect(response.statusCode).toBe(404)
    expect(response.json().ok).toBe(false)
  })

  it('非法 from 参数被忽略而非 500（NaN 守卫）', async () => {
    // mock services 用真实 ObservabilityService（同 cost-report 的既有测法）
    const createRes = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects`,
      payload: { title: '观测参数测试', genre: '玄幻', synopsis: '', targetWords: 0 },
    })
    const projectId = createRes.json().data.id

    const response = await app.inject({
      method: 'GET',
      url: `${PLUGIN_PREFIX}/projects/${projectId}/observability/overview?from=abc`,
    })
    expect(response.statusCode, response.body).toBe(200)
    // from=abc 视为未传 → 不过滤时间 → 空库返回空态
    expect(response.json().data.totalCalls).toBe(0)
  })
})
