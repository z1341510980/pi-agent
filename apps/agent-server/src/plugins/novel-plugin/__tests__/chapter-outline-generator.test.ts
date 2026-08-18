import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { PluginContext, PluginSessionOptions } from '../../../core/plugin/plugin-types.js'
import { NovelStore } from '../core/novel-store.js'
import { NovelMemoryStore } from '../core/novel-memory-store.js'
import { PromptManager } from '../core/prompting/prompt-manager.js'
import { ChapterOutlineGenerator } from '../core/chapters/chapter-outline-generator.js'
import { novelMigrations } from '../novel-migrations.js'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of novelMigrations) db.exec(migration.sql)
  return db
}

function validModelResult(characterId: string, storylineId: string): string {
  return JSON.stringify({
    version: 1,
    outlineText: '林默进入旧城区核查证词，在多处矛盾中确认案件背后有人操纵，结尾发现自己正被跟踪。',
    chapterGoal: '确认失踪案并非偶发事件',
    openingState: '林默只有一条来源不明的线索',
    progression: ['进入旧城区', '核对证词', '确认证词被人为篡改'],
    obstacles: ['证人拒绝配合'],
    turningPoint: '证人无意中说出幕后人的特征',
    endingState: '林默锁定下一步调查方向',
    hook: '幕后人开始跟踪林默',
    sceneCountEstimate: 3,
    povSuggestions: [{ characterId, mode: 'single' }],
    storylines: [{ storylineId, intendedProgress: '确认失踪案背后存在组织' }],
    continuityRisks: []
  })
}

describe('ChapterOutlineGenerator', () => {
  let db: Database.Database
  let store: NovelStore
  let memoryStore: NovelMemoryStore
  let promptManager: PromptManager
  let projectId: string
  let chapterId: string
  let characterId: string
  let storylineId: string
  let modelResult: string
  let capturedOptions: PluginSessionOptions | undefined
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

  beforeEach(() => {
    db = createTestDb()
    store = new NovelStore(db)
    memoryStore = new NovelMemoryStore(db)
    promptManager = new PromptManager(db, process.cwd())
    projectId = randomUUID()
    chapterId = randomUUID()
    characterId = randomUUID()

    store.createProject({
      id: projectId,
      title: '失踪之城',
      genre: '悬疑',
      synopsis: '记者追查连环失踪案。',
      outline: '主角逐步发现失踪案与旧城改造有关。',
      targetWords: 3000,
      currentVolume: 1,
      currentChapter: 2,
      currentStage: 'rising',
      status: 'active',
      novelModelId: 'provider-a:model-outline'
    })
    const volume = store.createVolume({
      id: randomUUID(),
      projectId,
      volumeNumber: 1,
      title: '旧城迷雾',
      outline: '第一卷聚焦旧城区的三起失踪案。',
      sortOrder: 1
    })
    store.createChapter({
      id: randomUUID(),
      projectId,
      volume: 1,
      chapterNumber: 1,
      title: '匿名来信',
      content: '林默收到匿名信，并在信封里发现旧城区地图。',
      wordCount: 22,
      status: 'drafting',
      narrativeTask: '',
      outline: '收到匿名信。',
      volumeId: volume.id,
      recap: '林默收到指向旧城区的匿名线索。',
      acceptanceResult: null
    })
    store.createChapter({
      id: chapterId,
      projectId,
      volume: 1,
      chapterNumber: 2,
      title: '旧城区',
      content: '',
      wordCount: 0,
      status: 'planned',
      narrativeTask: '',
      outline: '调查旧城区。',
      volumeId: volume.id,
      acceptanceResult: null
    })
    store.createCharacter({
      id: characterId,
      projectId,
      name: '林默',
      description: '调查记者',
      identity: '地方报记者',
      personality: '',
      appearance: '',
      currentState: '警觉',
      currentGoal: '确认匿名信来源',
      currentPressure: '编辑要求尽快交稿',
      secret: '',
      arcStage: 'rising',
      arcHistory: '[]',
      speechStyle: '',
      isProtagonist: true,
      longTermDesire: '查清父亲失踪真相',
      plotRole: 'protagonist',
      removalImpact: '主调查线无法成立'
    })
    storylineId = store.ensureStoryline(
      projectId,
      '失踪案主线',
      'main',
      '追查旧城区失踪案的幕后原因'
    ).id
    modelResult = validModelResult(characterId, storylineId)
    capturedOptions = undefined
    vi.clearAllMocks()
  })

  afterEach(() => db.close())

  function createGenerator(): ChapterOutlineGenerator {
    const context = {
      logger,
      createSession: vi.fn(async (options: PluginSessionOptions) => {
        capturedOptions = options
        let subscriber: ((event: Record<string, unknown>) => void) | undefined
        return {
          sessionId: 'outline-session',
          prompt: async () => {
            subscriber?.({
              type: 'message_end',
              message: {
                role: 'assistant',
                provider: 'provider-a',
                model: 'model-outline',
                usage: { inputTokens: 120, outputTokens: 80 }
              }
            })
            return modelResult
          },
          promptStream: vi.fn(),
          subscribe: (handler: (event: Record<string, unknown>) => void) => {
            subscriber = handler
            return () => {
              subscriber = undefined
            }
          },
          abort: vi.fn(),
          dispose: vi.fn()
        }
      })
    } as unknown as PluginContext
    return new ChapterOutlineGenerator(store, memoryStore, promptManager, context)
  }

  it('注入项目、卷、前章、故事线和角色上下文，并使用项目主模型', async () => {
    const generator = createGenerator()
    const result = await generator.generate({
      projectId,
      chapterNumber: 2,
      mode: 'rewrite',
      currentOutline: '调查旧城区。',
      expectedOutline: '调查旧城区。'
    })

    expect(capturedOptions?.modelId).toEqual({
      provider: 'provider-a',
      modelId: 'model-outline'
    })
    expect(capturedOptions?.tools).toEqual([])
    expect(capturedOptions?.responseFormat).toBe('json')
    expect(capturedOptions?.maxTokens).toBeUndefined()
    expect(capturedOptions?.userMessage).toContain('主角逐步发现失踪案与旧城改造有关')
    expect(capturedOptions?.userMessage).toContain('第一卷聚焦旧城区的三起失踪案')
    expect(capturedOptions?.userMessage).toContain('林默收到指向旧城区的匿名线索')
    expect(capturedOptions?.userMessage).toContain('失踪案主线')
    expect(capturedOptions?.userMessage).toContain(characterId)
    expect(result.draft.povSuggestions[0]?.characterName).toBe('林默')
    expect(result.draft.storylines[0]?.storylineName).toBe('失踪案主线')
    expect(result.model.modelId).toBe('provider-a:model-outline')
    expect(result.usage).toMatchObject({ inputTokens: 120, outputTokens: 80 })
    expect(store.getChapter(projectId, 2)?.outline).toBe('调查旧城区。')
    expect(store.listAgentLogsByProject(projectId, 10)[0]).toMatchObject({
      agentType: 'outline-planner',
      status: 'success'
    })
  })

  it('模型返回非法结构时失败且不修改原章纲', async () => {
    modelResult = JSON.stringify({ version: 1, outlineText: '字段不足' })
    const generator = createGenerator()

    await expect(
      generator.generate({
        projectId,
        chapterNumber: 2,
        mode: 'rewrite',
        currentOutline: '调查旧城区。',
        expectedOutline: '调查旧城区。'
      })
    ).rejects.toThrow('不符合协议')

    expect(store.getChapter(projectId, 2)?.outline).toBe('调查旧城区。')
    expect(store.listAgentLogsByProject(projectId, 10)[0]).toMatchObject({
      agentType: 'outline-planner',
      status: 'error'
    })
  })
})
