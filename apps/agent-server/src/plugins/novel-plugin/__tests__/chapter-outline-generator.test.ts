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

  function createGenerator(fakeConfig: { /** 禁用工具执行，模拟 provider 不支持工具调用的兜底路径 */ disableToolExecution?: boolean } = {}): ChapterOutlineGenerator {
    const context = {
      logger,
      createSession: vi.fn(async (options: PluginSessionOptions & { disableToolExecution?: boolean }) => {
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
            // ── 工具路径模拟：模型发起 tool call → SDK 执行工具 → 助手仅回确认语 ──
            if (!fakeConfig.disableToolExecution && Array.isArray(options.tools) && options.tools.length > 0) {
              const submitTool = options.tools[0] as unknown as {
                execute: (id: string, args: unknown) => Promise<unknown>
              }
              await submitTool.execute('fake-tool-call', JSON.parse(modelResult))
              return '章纲已通过结构化提交工具入库。'
            }
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
    // 方案 D：挂载结构化提交工具，且不再声明 json 响应格式（避免 tool_choice 冲突）
    const tools = capturedOptions?.tools as unknown as Array<{ name?: string }> | undefined
    expect(tools).toHaveLength(1)
    expect(tools?.[0]?.name).toBe('submit_chapter_outline')
    expect(capturedOptions?.responseFormat).toBeUndefined()
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

  it('工具入参落库：日志 tools 段保存模型实际提交的结构化参数', async () => {
    const generator = createGenerator()
    await generator.generate({
      projectId,
      chapterNumber: 2,
      mode: 'rewrite',
      currentOutline: '调查旧城区。',
      expectedOutline: '调查旧城区。'
    })

    const log = store.listAgentLogsByProject(projectId, 10)[0]
    const detail = store.getAgentLog(log.id)!
    expect(detail.toolNames).toEqual(['submit_chapter_outline'])
    expect(detail.tools).toHaveLength(1)
    expect(detail.tools[0]).toMatchObject({
      tool: 'submit_chapter_outline',
      attempt: 1,
      accepted: true
    })
    // 原始入参可回溯：模型填的 characterId 直接可见
    expect(JSON.stringify(detail.tools[0])).toContain(characterId)
    // result 段同时带可读文本副本（助手确认语只有一句话，看不出提交了什么）
    expect(detail.result).toContain('<tool_submission name="submit_chapter_outline"')
  })

  it('提交被协议打回时报错带实际值，且被拒绝的入参仍然落库', async () => {
    // 上下文没有角色的新项目最高频的漂移：mode=single + 空 characterId。
    // 空 ID 已降级为风险，这里改用无法归一的越界值验证「报错带实际值 + 入参落库」。
    modelResult = JSON.stringify({
      ...JSON.parse(validModelResult(characterId, storylineId)),
      sceneCountEstimate: 99
    })
    const generator = createGenerator()

    await expect(
      generator.generate({
        projectId,
        chapterNumber: 2,
        mode: 'rewrite',
        currentOutline: '调查旧城区。',
        expectedOutline: '调查旧城区。'
      })
    ).rejects.toThrow(/sceneCountEstimate.*实际值 99/)

    const detail = store.getAgentLog(store.listAgentLogsByProject(projectId, 10)[0].id)!
    expect(detail.status).toBe('error')
    expect(detail.tools[0]).toMatchObject({ accepted: false })
    expect(JSON.stringify(detail.tools[0])).toContain('99')
  })

  it('mode=single 但 characterId 为空时降级为风险，章纲照常产出', async () => {
    modelResult = JSON.stringify({
      ...JSON.parse(validModelResult(characterId, storylineId)),
      povSuggestions: [{ characterId: '', mode: 'single' }]
    })
    const generator = createGenerator()
    const result = await generator.generate({
      projectId,
      chapterNumber: 2,
      mode: 'rewrite',
      currentOutline: '调查旧城区。',
      expectedOutline: '调查旧城区。'
    })

    expect(result.draft.povSuggestions).toEqual([])
    expect(result.draft.continuityRisks).toEqual([
      expect.objectContaining({ type: 'unknown_entity' })
    ])
  })

  it('上下文没有角色时任务指令显式禁止 mode=single', async () => {
    // 删掉唯一角色 → characterNames 为空 → 提示词需封口，否则模型只能填空 ID
    store.deleteCharacter(characterId)
    const generator = createGenerator()
    await generator.generate({
      projectId,
      chapterNumber: 2,
      mode: 'rewrite',
      currentOutline: '调查旧城区。',
      expectedOutline: '调查旧城区。'
    }).catch(() => undefined)

    expect(capturedOptions?.userMessage).toContain('禁止 mode=single')
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

  it('兜底路径：provider 不执行工具时按容错文本解析成功', async () => {
    // 禁用工具执行 → prompt 返回原始 JSON 文本 → 走 parseChapterOutlineDraft 兜底
    const generator = createGenerator({ disableToolExecution: true })
    const result = await generator.generate({
      projectId,
      chapterNumber: 2,
      mode: 'rewrite',
      currentOutline: '调查旧城区。',
      expectedOutline: '调查旧城区。'
    })

    expect(result.draft.povSuggestions[0]?.characterName).toBe('林默')
    expect(result.draft.storylines[0]?.storylineName).toBe('失踪案主线')
  })

  it('协议漂移（元信息包装 + 中文键）在兜底解析中归一成功', async () => {
    modelResult = JSON.stringify({
      元信息: { 备注: '测试' },
      章纲: {
        正文: '林默进入旧城区核查证词，发现记录被人为篡改，结尾锁定幕后调查方向。',
        章节目标: '确认失踪案并非偶发事件',
        开场状态: '林默只有一条来源不明的线索',
        推进: ['进入旧城区', '核对证词'],
        转折点: '证词指向幕后人特征',
        结尾状态: '林默锁定下一步方向',
        钩子: '幕后人开始跟踪',
        场景数: 3,
        povSuggestions: [{ characterId, mode: 'single' }],
        storylines: [{ storylineId, intendedProgress: '确认组织存在' }],
        continuityRisks: []
      }
    })
    const generator = createGenerator({ disableToolExecution: true })
    const result = await generator.generate({
      projectId,
      chapterNumber: 2,
      mode: 'rewrite',
      currentOutline: '调查旧城区。',
      expectedOutline: '调查旧城区。'
    })
    expect(result.draft.chapterGoal).toBe('确认失踪案并非偶发事件')
    expect(result.draft.povSuggestions[0]?.characterName).toBe('林默')
  })
})
