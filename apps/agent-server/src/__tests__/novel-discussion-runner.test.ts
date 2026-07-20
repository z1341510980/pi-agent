import { describe, expect, it, vi, beforeAll, afterAll, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { NovelStore } from '../plugins/novel-plugin/core/novel-store.js'
import { NovelMemoryStore } from '../plugins/novel-plugin/core/novel-memory-store.js'
import { PromptManager } from '../plugins/novel-plugin/core/prompt-manager.js'
import { NovelPromptBuilder } from '../plugins/novel-plugin/core/prompt-builder.js'
import { NovelEngine } from '../plugins/novel-plugin/core/novel-engine.js'
import { novelMigrations } from '../plugins/novel-plugin/novel-migrations.js'
import { NovelDiscussionRunner } from '../plugins/novel-plugin/core/novel-discussion-runner.js'
import { TeamDiscussionEngine } from '../core/agent/team-discussion-engine.js'
import { ChapterFinalizer } from '../core/agent/chapter-finalizer.js'
import type { DiscussionOptions } from '../core/agent/discussion-types.js'

function setupTestDb(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of novelMigrations) {
    db.exec(migration.sql)
  }
  return db
}

describe('NovelDiscussionRunner', () => {
  let db: Database.Database
  let store: NovelStore
  let memoryStore: NovelMemoryStore

  beforeAll(() => {
    db = setupTestDb()
    store = new NovelStore(db)
    memoryStore = new NovelMemoryStore(db)
  })

  afterAll(() => {
    db.close()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('buildMembers 包含 4 个工种 Agent + 项目角色', () => {
    const project = store.createProject({
      id: 'p-test-1',
      title: '测试小说',
      genre: '都市',
      synopsis: '测试简介',
      outline: '测试大纲',
      targetWords: 100000,
      currentVolume: 1,
      currentChapter: 0,
      currentStage: 'setup',
      status: 'active',
    } as any)
    store.createCharacter({
      id: 'c-zhaoyan',
      projectId: project.id,
      name: '赵岩',
      personality: '刚烈正直',
      currentState: '愤怒',
      currentGoal: '查清真相',
      secret: '是卧底',
      arcStage: '觉醒',
    } as any)

    const promptManager = new PromptManager(db, process.cwd())
    const promptBuilder = new NovelPromptBuilder(promptManager, store, memoryStore)
    const engine = new NovelEngine(store)
    const mockContext = {
      createAgUiSession: vi.fn(),
      createSession: vi.fn(),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    } as any

    const runner = new NovelDiscussionRunner(
      store, memoryStore, promptBuilder, engine, mockContext, {} as any,
    )

    const members = (runner as any).buildMembers(project.id, 1)
    expect(members.length).toBe(5) // 4 工种 + 1 角色
    expect(members.filter((m: any) => m.type === 'role').length).toBe(4)
    expect(members.filter((m: any) => m.type === 'character').length).toBe(1)
    expect(members.find((m: any) => m.type === 'character').name).toBe('赵岩')
  })

  it('buildCharacterPrompt 注入角色人设字段', () => {
    const project = store.createProject({
      id: 'p-test-2',
      title: '测试',
      genre: '都市',
      synopsis: '',
      outline: '',
      targetWords: 0,
      currentVolume: 1,
      currentChapter: 0,
      currentStage: 'setup',
      status: 'active',
    } as any)
    const char = store.createCharacter({
      id: 'c-liming',
      projectId: project.id,
      name: '李明',
      personality: '沉稳冷静',
      currentState: '焦虑',
      currentGoal: '保护家人',
      secret: '欠债',
      arcStage: '挣扎',
    } as any)

    const promptManager = new PromptManager(db, process.cwd())
    const promptBuilder = new NovelPromptBuilder(promptManager, store, memoryStore)
    const engine = new NovelEngine(store)
    const mockContext = {
      createAgUiSession: vi.fn(),
      createSession: vi.fn(),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    } as any

    const runner = new NovelDiscussionRunner(
      store, memoryStore, promptBuilder, engine, mockContext, {} as any,
    )
    const prompt = (runner as any).buildCharacterPrompt(project.id, char)
    expect(prompt).toContain('李明')
    expect(prompt).toContain('沉稳冷静')
    expect(prompt).toContain('焦虑')
    expect(prompt).toContain('保护家人')
    expect(prompt).toContain('欠债')
    expect(prompt).toContain('挣扎')
    expect(prompt).toContain('绝不使用长横线破折号')
  })

  it('buildMembers 工种 Agent 注入群聊 role 身份段（含场景拆分/剧本编织约束）', () => {
    const project = store.createProject({
      id: 'p-test-3',
      title: '测试',
      genre: '都市',
      synopsis: '',
      outline: '',
      targetWords: 0,
      currentVolume: 1,
      currentChapter: 0,
      currentStage: 'setup',
      status: 'active',
    } as any)

    const promptManager = new PromptManager(db, process.cwd())
    const promptBuilder = new NovelPromptBuilder(promptManager, store, memoryStore)
    const engine = new NovelEngine(store)
    const mockContext = {
      createAgUiSession: vi.fn(),
      createSession: vi.fn(),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    } as any

    const runner = new NovelDiscussionRunner(
      store, memoryStore, promptBuilder, engine, mockContext, {} as any,
    )

    const members = (runner as any).buildMembers(project.id, 1)
    const director = members.find((m: any) => m.id === 'novel-director')
    expect(director).toBeDefined()
    const directorPrompt = director.buildIdentityPrompt()
    // role-director-discussion.md 应含"场景拆分"字段（群聊专属，普通 role-director.md 没有）
    expect(directorPrompt).toContain('场景拆分')
    // role-director-discussion.md 应含"### 场景N：标题"格式说明
    expect(directorPrompt).toContain('### 场景1：标题')

    const writer = members.find((m: any) => m.id === 'novel-writer')
    expect(writer).toBeDefined()
    const writerPrompt = writer.buildIdentityPrompt()
    // role-writer-discussion.md 应含推演编织和代词消歧约束
    expect(writerPrompt).toContain('编织')
    expect(writerPrompt).toContain('意图、心理、应对')
    expect(writerPrompt).toContain('指代消歧')
  })

  it('buildMembers 角色成员注入 role-character-actor.md（简短推演格式）', () => {
    const project = store.createProject({
      id: 'p-test-4',
      title: '测试',
      genre: '都市',
      synopsis: '',
      outline: '',
      targetWords: 0,
      currentVolume: 1,
      currentChapter: 0,
      currentStage: 'setup',
      status: 'active',
    } as any)
    store.createCharacter({
      id: 'c-actortest',
      projectId: project.id,
      name: '王芳',
      personality: '机敏聪慧',
      currentState: '警觉',
      currentGoal: '搜集情报',
      secret: '双面间谍',
      arcStage: '潜伏',
    } as any)

    const promptManager = new PromptManager(db, process.cwd())
    const promptBuilder = new NovelPromptBuilder(promptManager, store, memoryStore)
    const engine = new NovelEngine(store)
    const mockContext = {
      createAgUiSession: vi.fn(),
      createSession: vi.fn(),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    } as any

    const runner = new NovelDiscussionRunner(
      store, memoryStore, promptBuilder, engine, mockContext, {} as any,
    )

    const members = (runner as any).buildMembers(project.id, 1)
    const character = members.find((m: any) => m.type === 'character')
    expect(character).toBeDefined()
    const charPrompt = character.buildIdentityPrompt()
    // 角色只演出一个可继续衔接的动作单元，不展开完整场景
    expect(charPrompt).toContain('[动作/表情/心理外化]')
    expect(charPrompt).toContain('2-6 行剧本')
    expect(charPrompt).toContain('PUSHBACK')
    // 角色人设字段也保留
    expect(charPrompt).toContain('王芳')
    expect(charPrompt).toContain('机敏聪慧')
  })

  it('run 绑定真实章节并把群聊成员调用写入 Agent 日志', async () => {
    const project = store.createProject({
      id: 'p-test-5',
      title: '日志测试',
      genre: '都市',
      synopsis: '',
      outline: '',
      targetWords: 3000,
      currentVolume: 1,
      currentChapter: 0,
      currentStage: 'setup',
      status: 'active',
    } as any)
    const chapter = store.createChapter({
      id: 'ch-test-5',
      projectId: project.id,
      volume: 1,
      chapterNumber: 1,
      title: '第一章',
      content: '',
      wordCount: 0,
      status: 'planned',
      narrativeTask: '',
      acceptanceResult: null,
    } as any)

    let capturedOptions: any
    vi.spyOn(TeamDiscussionEngine.prototype, 'run').mockImplementation(async (_goal, _members, options) => {
      capturedOptions = options
      return { status: 'completed', content: `${'正文'.repeat(2000)}。`, transcript: [], scenes: [] }
    })
    const finalizeSpy = vi.spyOn(ChapterFinalizer.prototype, 'finalize').mockResolvedValue({
      status: 'completed',
      content: '修订后的正文',
      stateChanges: [],
    })

    const promptManager = new PromptManager(db, process.cwd())
    const promptBuilder = new NovelPromptBuilder(promptManager, store, memoryStore)
    const engine = new NovelEngine(store)
    const runner = new NovelDiscussionRunner(
      store,
      memoryStore,
      promptBuilder,
      engine,
      {
        createAgUiSession: vi.fn(),
        createSession: vi.fn(),
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      } as any,
      {} as any,
    )

    const result = await runner.run(project.id, 1, makeOptionsForRun())
    expect(result.content).toBe(`${'正文'.repeat(2000)}。`)
    expect(finalizeSpy).toHaveBeenCalledWith(expect.objectContaining({ chapterId: chapter.id }))

    capturedOptions.onMemberInvocation({
      member: {
        id: 'novel-writer',
        type: 'role',
        name: '写作',
        expertise: '写作',
        canConverge: true,
        buildSystemPrompt: () => 'system',
        modelId: { provider: 'xai', modelId: 'grok-4' },
      },
      phase: 'chapter_weaving',
      systemPrompt: 'system',
      chapterContext: 'context',
      userMessage: 'message',
      result: '正文',
      durationMs: 12,
      status: 'success',
      error: '',
      sessionId: 'session-1',
    })

    const logs = store.listAgentLogsByProject(project.id, 10)
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentType: 'writer',
        phase: 'chapter_weaving',
        result: '正文',
        llmProvider: 'xai',
        llmModel: 'grok-4',
      }),
    ]))
  })

  it('断点续跑在收尾阶段失败时保留 Writer 结果和快照', async () => {
    const project = store.createProject({
      id: 'p-test-resume-finalize',
      title: '断点收尾测试',
      genre: '都市',
      synopsis: '',
      outline: '',
      targetWords: 3000,
      currentVolume: 1,
      currentChapter: 0,
      currentStage: 'setup',
      status: 'active',
    } as any)
    const transcript = [{
      id: 'saved-message',
      fromId: 'char-1',
      fromName: '叶明远',
      content: '已保存的推演',
      timestamp: 1,
      type: 'member' as const,
      sceneId: 1,
    }]
    const scenes = [{
      sceneId: 1,
      title: '突破',
      location: '矿道',
      time: '夜',
      presentCharacters: ['char-1'],
      goal: '完成突破',
    }]
    vi.spyOn(TeamDiscussionEngine.prototype, 'resumeChapterWeaving').mockResolvedValue({
      status: 'completed',
      content: '已恢复的正文',
      transcript,
      scenes,
    })
    vi.spyOn(ChapterFinalizer.prototype, 'finalize').mockRejectedValue(new Error('Memory 写入失败'))

    const promptManager = new PromptManager(db, process.cwd())
    const promptBuilder = new NovelPromptBuilder(promptManager, store, memoryStore)
    const engine = new NovelEngine(store)
    const runner = new NovelDiscussionRunner(
      store,
      memoryStore,
      promptBuilder,
      engine,
      {
        createAgUiSession: vi.fn(),
        createSession: vi.fn(),
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      } as any,
      {} as any,
    )

    const result = await runner.run(
      project.id,
      9,
      makeOptionsForRun(),
      undefined,
      { phase: 'chapter_weaving', transcript, scenes },
    )

    expect(result).toMatchObject({
      status: 'error',
      error: 'Memory 写入失败',
      failedPhase: 'memory',
      content: '已恢复的正文',
      transcript: [{ id: 'saved-message' }],
      scenes: [{ title: '突破' }],
    })
  })
})

function makeOptionsForRun(): DiscussionOptions {
  return {
    emit: vi.fn(),
    onCheckpoint: vi.fn().mockResolvedValue('approve'),
    onProgress: vi.fn(),
  }
}
