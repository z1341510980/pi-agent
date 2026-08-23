import { describe, expect, it, vi, beforeAll, afterAll, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { NovelStore } from '../core/novel-store.js'
import { NovelMemoryStore } from '../core/novel-memory-store.js'
import { PromptManager } from '../core/prompting/prompt-manager.js'
import { NovelPromptBuilder } from '../core/prompt-builder.js'
import { NovelEngine } from '../core/novel-engine.js'
import { novelMigrations } from '../novel-migrations.js'
import { NovelDiscussionRunner } from '../core/discussion/novel-discussion-runner.js'
import { TeamDiscussionEngine } from '../core/discussion/engine/team-discussion-engine.js'
import { ChapterFinalizer } from '../core/chapter-finalizer.js'
import type { DiscussionOptions } from '../core/discussion/engine/discussion-types.js'
import {
  getInterjectEnqueuer,
  unregisterInterjectEnqueuer,
} from '../utils/chapter-task-registry.js'

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

  it('本次成员模型覆盖工种、已建档角色和 Director 临时角色', () => {
    const project = store.createProject({
      id: 'p-member-model', title: '模型覆盖', genre: '都市', synopsis: '', outline: '',
      targetWords: 3000, currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
    } as any)
    const character = store.createCharacter({
      id: 'c-member-model', projectId: project.id, name: '林晚', personality: '谨慎',
      currentState: '', currentGoal: '', secret: '', arcStage: 'introduction',
    } as any)
    const configuredModel = { provider: 'configured', modelId: 'role-default' }
    const override = { provider: 'selected', modelId: 'run-model' }
    const promptBuilder = new NovelPromptBuilder(new PromptManager(db, process.cwd()), store, memoryStore)
    const runner = new NovelDiscussionRunner(
      store,
      memoryStore,
      promptBuilder,
      new NovelEngine(store),
      {
        createAgUiSession: vi.fn(), createSession: vi.fn(),
        subagentManager: { getAgent: vi.fn(() => ({ model: configuredModel })) },
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      } as any,
      { provider: 'moderator', modelId: 'moderator-only' },
    )
    const boundary = promptBuilder.getChapterBoundaryContext(project.id, 1)

    const members = (runner as any).buildMembers(project.id, 1, undefined, boundary, override)
    expect(members.find((member: any) => member.id === 'novel-director').modelId).toEqual(override)
    expect(members.find((member: any) => member.id === `char-${character.id}`).modelId).toEqual(override)

    const dynamic = (runner as any).resolveCharacterMembers(
      project.id, 1, undefined, boundary, ['临时访客'], override,
    )[0]
    expect(dynamic.modelId).toEqual(override)
  })

  it('未选本次模型时群聊工种和角色统一使用项目创作主模型', () => {
    const project = store.createProject({
      id: 'p-project-model', title: '项目模型', genre: '都市', synopsis: '', outline: '',
      targetWords: 3000, currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
      novelModelId: 'project-provider:project-model',
    } as any)
    const character = store.createCharacter({
      id: 'c-project-model', projectId: project.id, name: '周宁', personality: '敏锐',
      currentState: '', currentGoal: '', secret: '', arcStage: 'introduction',
    } as any)
    const promptBuilder = new NovelPromptBuilder(new PromptManager(db, process.cwd()), store, memoryStore)
    const runner = new NovelDiscussionRunner(
      store,
      memoryStore,
      promptBuilder,
      new NovelEngine(store),
      {
        createAgUiSession: vi.fn(), createSession: vi.fn(),
        subagentManager: { getAgent: vi.fn(() => ({ model: { provider: 'agent', modelId: 'configured' } })) },
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      } as any,
    )

    const members = (runner as any).buildMembers(project.id, 1)
    expect(members.find((member: any) => member.id === 'novel-writer').modelId).toEqual({
      provider: 'project-provider', modelId: 'project-model',
    })
    expect(members.find((member: any) => member.id === `char-${character.id}`).modelId).toEqual({
      provider: 'project-provider', modelId: 'project-model',
    })
  })

  it('未选本次模型时 Finalizer 使用冻结的项目主模型', async () => {
    const project = store.createProject({
      id: 'p-finalizer-project-model', title: '收尾模型', genre: '都市', synopsis: '', outline: '',
      targetWords: 3000, currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
      novelModelId: 'project-provider:project-model',
    } as any)
    const chapter = store.createChapter({
      id: 'ch-finalizer-project-model', projectId: project.id, volume: 1, chapterNumber: 1,
      title: '第一章', content: '', wordCount: 0, status: 'planned', narrativeTask: '',
      acceptanceResult: null,
    } as any)
    vi.spyOn(TeamDiscussionEngine.prototype, 'run').mockResolvedValue({
      status: 'completed', content: '正文内容', transcript: [], scenes: [],
    })
    const finalizeSpy = vi.spyOn(ChapterFinalizer.prototype, 'finalize').mockResolvedValue({
      status: 'completed', content: '正文内容', stateChanges: [],
    })
    const promptBuilder = new NovelPromptBuilder(new PromptManager(db, process.cwd()), store, memoryStore)
    const runner = new NovelDiscussionRunner(
      store, memoryStore, promptBuilder, new NovelEngine(store),
      {
        createAgUiSession: vi.fn(), createSession: vi.fn(),
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      } as any,
    )

    await runner.run(project.id, 1, makeOptionsForRun())

    expect(finalizeSpy).toHaveBeenCalledWith(expect.objectContaining({
      chapterId: chapter.id,
      options: expect.objectContaining({
        modelId: { provider: 'project-provider', modelId: 'project-model' },
      }),
    }))
  })

  it('角色成员身份提示注入角色人设字段', () => {
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
    const member = (runner as any).buildMembers(project.id, 1)
      .find((m: any) => m.id === `char-${char.id}`)
    const prompt = member.buildIdentityPrompt()
    expect(prompt).toContain('李明')
    expect(prompt).toContain('沉稳冷静')
    expect(prompt).toContain('焦虑')
    expect(prompt).toContain('保护家人')
    expect(prompt).toContain('欠债')
    expect(prompt).toContain('挣扎')
    // 演出规则（破折号红线）由 novel-character-actor Skill / 合并身份提供
    expect(member.buildMergedActorIdentityPrompt()).toContain('绝不使用长横线破折号')
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
    // Skill 白名单接入：群聊角色方法由 novel-director-discussion Skill 提供，
    // 身份为薄壳（场景拆分/格式说明在 Skill 正文中，由 /skill: 展开）
    expect(director.skill).toEqual({
      name: 'novel-director-discussion',
      path: expect.stringMatching(/role-director-discussion\.md$/),
    })
    const directorPrompt = director.buildIdentityPrompt()
    expect(directorPrompt).toContain('novel-director-discussion Skill')
    expect(directorPrompt).not.toContain('场景拆分')
    expect(directorPrompt).not.toContain('### 场景1：标题')

    const writer = members.find((m: any) => m.id === 'novel-writer')
    expect(writer).toBeDefined()
    expect(writer.skill).toEqual({
      name: 'novel-writer-discussion',
      path: expect.stringMatching(/role-writer-discussion\.md$/),
    })
    const writerPrompt = writer.buildIdentityPrompt()
    expect(writerPrompt).toContain('novel-writer-discussion Skill')
    // 铁律保留在薄身份壳中
    expect(writerPrompt).toContain('正文底线')
    expect(writerPrompt).not.toContain('编织边界')
    expect(writerPrompt).not.toContain('意图、心理、应对')

    // Reviewer：主身份挂 discussion Skill，最终验收挂标准 novel-reviewer Skill
    const reviewer = members.find((m: any) => m.id === 'novel-reviewer')
    expect(reviewer).toBeDefined()
    expect(reviewer.skill?.name).toBe('novel-reviewer-discussion')
    expect(reviewer.finalReviewSkill).toEqual({
      name: 'novel-reviewer',
      path: expect.stringMatching(/role-reviewer\.md$/),
    })

    // Reviser：无 role-reviser-discussion 模板 → 回退旧身份路径，不挂 Skill
    const reviser = members.find((m: any) => m.id === 'novel-reviser')
    expect(reviser).toBeDefined()
    expect(reviser.skill).toBeUndefined()
    expect(reviser.buildIdentityPrompt()).toContain('负责局部修订')
  })

  it('buildMembers 角色成员挂 novel-character-actor Skill，合并身份保留完整模板', () => {
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
    // Skill 白名单接入：单角色调用由 novel-character-actor Skill 提供演出方法
    expect(character.skill).toEqual({
      name: 'novel-character-actor',
      path: expect.stringMatching(/role-character-actor\.md$/),
    })
    const charPrompt = character.buildIdentityPrompt()
    expect(charPrompt).toContain('novel-character-actor Skill')
    expect(charPrompt).not.toContain('[动作/表情/心理外化]')
    // 角色人设字段保留在薄壳之前
    expect(charPrompt).toContain('王芳')
    expect(charPrompt).toContain('机敏聪慧')

    // 合并演出路径不走 Skill 展开，必须内联完整模板（剧本格式/演出规则）
    const mergedPrompt = character.buildMergedActorIdentityPrompt()
    expect(mergedPrompt).toContain('[动作/表情/心理外化]')
    expect(mergedPrompt).toContain('2-6 行剧本')
    expect(mergedPrompt).toContain('PUSHBACK')
  })

  it('角色演员读取 N-1 边界状态，不读取当前章之后的角色、冲突和认知', () => {
    const project = store.createProject({
      id: 'p-test-boundary', title: '边界测试', genre: '都市', synopsis: '', outline: '', targetWords: 0,
      currentVolume: 1, currentChapter: 2, currentStage: 'rising', status: 'active',
    } as any)
    store.createChapter({
      id: 'ch-boundary-1', projectId: project.id, volume: 1, chapterNumber: 1, title: '第一章',
      content: '第一章已经写完。', wordCount: 8, status: 'review', narrativeTask: '', outline: '',
      volumeId: null, acceptanceResult: null,
    } as any)
    store.createChapter({
      id: 'ch-boundary-2', projectId: project.id, volume: 1, chapterNumber: 2, title: '第二章',
      content: '旧的第二章。', wordCount: 6, status: 'review', narrativeTask: '', outline: '',
      volumeId: null, acceptanceResult: null,
    } as any)
    const character = store.createCharacter({
      id: 'c-boundary', projectId: project.id, name: '沈舟', personality: '谨慎', identity: '调查员',
      currentState: '未来章已经脱险', currentGoal: '追查幕后者', secret: '', arcStage: 'rising',
    } as any)
    const conflict = store.createConflict({
      id: 'cf-boundary', projectId: project.id, description: '码头追捕', type: 'survival', intensity: 8,
      stage: 'erupting', participants: JSON.stringify([character.id]), chapterSpans: [[1, 2]], tier: 'main',
    } as any)
    const layer = store.createInformationLayer({
      id: 'il-boundary', projectId: project.id, infoDescription: '叛徒已经现身', authorKnows: true,
      readerKnows: true, characterKnowledge: JSON.stringify({ [character.id]: { knows: true } }),
      revealStage: 'reveal', revealChapter: 2, isRevealed: true,
    })
    memoryStore.saveSnapshot({
      projectId: project.id, chapterNumber: 1, snapshotType: 'full', entityId: null,
      snapshotData: JSON.stringify({
        characters: [{ ...character, currentState: '第一章末仍被困在码头' }],
        relationships: [],
        conflicts: [{ ...conflict, stage: 'escalating', intensity: 5 }],
        foreshadowing: [], clues: [], factions: [], locations: [], items: [], worldElements: [],
        informationLayers: [{ ...layer, readerKnows: false, isRevealed: false, characterKnowledge: JSON.stringify({ [character.id]: { suspects: true } }) }],
        edges: [],
      }),
    })

    const promptManager = new PromptManager(db, process.cwd())
    const promptBuilder = new NovelPromptBuilder(promptManager, store, memoryStore)
    const runner = new NovelDiscussionRunner(
      store,
      memoryStore,
      promptBuilder,
      new NovelEngine(store),
      { createAgUiSession: vi.fn(), createSession: vi.fn(), logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } } as any,
      {} as any,
    )
    const arranged = {
      characterIds: [character.id], conflictIds: [conflict.id], foreshadowIds: [], clueIds: [], factionIds: [], locationIds: [], itemIds: [],
    }
    const boundary = promptBuilder.getChapterBoundaryContext(project.id, 2)
    const member = (runner as any).buildMembers(project.id, 2, arranged, boundary)
      .find((candidate: any) => candidate.id === `char-${character.id}`)

    expect(member.buildIdentityPrompt()).toContain('第一章末仍被困在码头')
    expect(member.buildIdentityPrompt()).not.toContain('未来章已经脱险')
    const context = member.buildContextPrompt()
    expect(context).toContain('当前阶段：escalating')
    expect(context).not.toContain('当前阶段：erupting')
    expect(context).toContain('你有所怀疑：叛徒已经现身')
    expect(context).not.toContain('你知道：叛徒已经现身')
  })

  it('群聊可加载 Snapshot 外的新编排角色，但不把当前表动态状态带回历史章节', () => {
    const project = store.createProject({
      id: 'p-test-new-arranged-character', title: '新角色边界', genre: '都市', synopsis: '',
      outline: '', targetWords: 0, currentVolume: 1, currentChapter: 2,
      currentStage: 'rising', status: 'active',
    } as any)
    store.createChapter({
      id: 'ch-new-arranged-1', projectId: project.id, volume: 1, chapterNumber: 1,
      title: '第一章', content: '第一章正文。', wordCount: 6, status: 'review',
      narrativeTask: '', outline: '', volumeId: null, acceptanceResult: null,
    } as any)
    store.createChapter({
      id: 'ch-new-arranged-2', projectId: project.id, volume: 1, chapterNumber: 2,
      title: '第二章', content: '旧第二章。', wordCount: 5, status: 'review',
      narrativeTask: '', outline: '', volumeId: null, acceptanceResult: null,
    } as any)
    const character = store.createCharacter({
      id: 'c-new-arranged', projectId: project.id, name: '顾遥', identity: '法医',
      personality: '冷静严谨', speechStyle: '术语少，句子简短',
      currentState: '未来章已经负伤', currentGoal: '未来章追捕凶手',
      currentPressure: '未来章证据被毁', secret: '未来章才揭露的秘密', arcStage: '未来章转变',
    } as any)
    const conflict = store.createConflict({
      id: 'cf-new-arranged', projectId: project.id, description: '旧仓库对峙', type: 'external',
      intensity: 9, stage: 'erupting', participants: JSON.stringify([character.id]),
      chapterSpans: [[2, 2]], tier: 'main', currentStep: '未来章已经抓到嫌疑人',
    } as any)
    memoryStore.saveSnapshot({
      projectId: project.id, chapterNumber: 1, snapshotType: 'full', entityId: null,
      snapshotData: JSON.stringify({
        characters: [], relationships: [], conflicts: [], foreshadowing: [], clues: [],
        factions: [], locations: [], items: [], worldElements: [], informationLayers: [], edges: [],
      }),
    })

    const promptBuilder = new NovelPromptBuilder(new PromptManager(db, process.cwd()), store, memoryStore)
    const runner = new NovelDiscussionRunner(
      store,
      memoryStore,
      promptBuilder,
      new NovelEngine(store),
      { createAgUiSession: vi.fn(), createSession: vi.fn(), logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } } as any,
      {} as any,
    )
    const boundary = promptBuilder.getChapterBoundaryContext(project.id, 2)
    const arranged = {
      characterIds: [character.id], conflictIds: [conflict.id], foreshadowIds: [], clueIds: [],
      factionIds: [], locationIds: [], itemIds: [],
    }
    const member = (runner as any).buildMembers(project.id, 2, arranged, boundary)
      .find((candidate: any) => candidate.id === `char-${character.id}`)

    expect(member).toBeDefined()
    expect(member.characterProfile).toMatchObject({
      personality: '冷静严谨', currentState: '', currentGoal: '', secret: '', arcStage: '',
    })
    const identity = member.buildIdentityPrompt()
    expect(identity).toContain('顾遥')
    expect(identity).toContain('法医')
    expect(identity).toContain('冷静严谨')
    expect(identity).toContain('术语少，句子简短')
    expect(identity).not.toContain('未来章已经负伤')
    expect(identity).not.toContain('未来章追捕凶手')
    expect(identity).not.toContain('未来章才揭露的秘密')
    expect(identity).not.toContain('未来章转变')
    const context = member.buildContextPrompt()
    expect(context).toContain('旧仓库对峙')
    expect(context).toContain('章前动态状态未知')
    expect(context).not.toContain('当前阶段：erupting')
    expect(context).not.toContain('未来章已经抓到嫌疑人')
  })

  it('Director 动态点名 Snapshot 外的已建档角色时保留档案并裁掉未来状态', () => {
    const project = store.createProject({
      id: 'p-test-dynamic-character', title: '动态补员', genre: '都市', synopsis: '', outline: '',
      targetWords: 0, currentVolume: 1, currentChapter: 2, currentStage: 'rising', status: 'active',
    } as any)
    store.createChapter({
      id: 'ch-dynamic-1', projectId: project.id, volume: 1, chapterNumber: 1,
      title: '第一章', content: '第一章正文。', wordCount: 6, status: 'review',
      narrativeTask: '', outline: '', volumeId: null, acceptanceResult: null,
    } as any)
    store.createChapter({
      id: 'ch-dynamic-2', projectId: project.id, volume: 1, chapterNumber: 2,
      title: '第二章', content: '旧第二章。', wordCount: 5, status: 'review',
      narrativeTask: '', outline: '', volumeId: null, acceptanceResult: null,
    } as any)
    const character = store.createCharacter({
      id: 'c-dynamic-character', projectId: project.id, name: '赵父', identity: '退休教师',
      personality: '固执但克制', speechStyle: '慢句，少说结论',
      currentState: '未来章已经住院', currentGoal: '未来章寻找儿子',
      secret: '未来章才公开', arcStage: '未来章和解',
    } as any)
    memoryStore.saveSnapshot({
      projectId: project.id, chapterNumber: 1, snapshotType: 'full', entityId: null,
      snapshotData: JSON.stringify({
        characters: [], relationships: [], conflicts: [], foreshadowing: [], clues: [],
        factions: [], locations: [], items: [], worldElements: [], informationLayers: [], edges: [],
      }),
    })
    const promptBuilder = new NovelPromptBuilder(new PromptManager(db, process.cwd()), store, memoryStore)
    const runner = new NovelDiscussionRunner(
      store,
      memoryStore,
      promptBuilder,
      new NovelEngine(store),
      { createAgUiSession: vi.fn(), createSession: vi.fn(), logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } } as any,
      {} as any,
    )
    const boundary = promptBuilder.getChapterBoundaryContext(project.id, 2)

    const member = (runner as any).resolveCharacterMembers(
      project.id,
      2,
      undefined,
      boundary,
      ['赵父'],
    )[0]

    expect(member.id).toBe(`char-${character.id}`)
    expect(member.expertise).toContain('固执但克制')
    expect(member.characterProfile).toMatchObject({
      currentState: '', currentGoal: '', secret: '', arcStage: '',
    })
    const identity = member.buildIdentityPrompt()
    expect(identity).toContain('退休教师')
    expect(identity).toContain('固执但克制')
    expect(identity).not.toContain('未来章已经住院')
    expect(identity).not.toContain('未来章寻找儿子')
    expect(identity).not.toContain('未来章才公开')
    expect(identity).not.toContain('未来章和解')
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
    // Finalizer 的清洗后正文是群聊结果的权威返回值，必须与数据库一致。
    expect(result.content).toBe('修订后的正文')
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
      // 实际挂载的工具名：日志必须能区分"工具没挂上"与"工具挂了但模型没调"
      toolNames: ['novel_apply_revision'],
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
        // 2026-08-12 逻辑统一：日志大文本外置到 payload 表，列表查询不含全文，
        // 以 resultLength 校验结果确实落库
        resultLength: '正文'.length,
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

  // ───────────────────────── 插话登记契约（对话化交互形态 §3.1） ─────────────────────────
  // engine 调用返回后、ChapterFinalizer 收尾（数十秒）之前必须注销投递闭包，
  // 否则收尾窗口内的插话会 201+queued 进入无人消费的死队列，SSE 永停 queued。

  function setupInterjectContractProject(projectId: string, chapterId: string) {
    const project = store.createProject({
      id: projectId, title: '插话登记契约', genre: '都市', synopsis: '', outline: '',
      targetWords: 3000, currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
    } as any)
    store.createChapter({
      id: chapterId, projectId: project.id, volume: 1, chapterNumber: 1,
      title: '第一章', content: '', wordCount: 0, status: 'planned',
      narrativeTask: '', acceptanceResult: null,
    } as any)
    const promptBuilder = new NovelPromptBuilder(new PromptManager(db, process.cwd()), store, memoryStore)
    const runner = new NovelDiscussionRunner(
      store, memoryStore, promptBuilder, new NovelEngine(store),
      {
        createAgUiSession: vi.fn(), createSession: vi.fn(),
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      } as any,
      {} as any,
    )
    return { projectId: project.id, runner, flowKey: `${project.id}|1` }
  }

  it('插话登记契约：run 期间可取到 enqueuer，engine 返回后立即注销（finalizer 之前），finally 注销幂等', async () => {
    const { projectId, runner, flowKey } = setupInterjectContractProject('p-interject-contract', 'ch-interject-contract')
    const registryChecks: Array<{ phase: string; registered: boolean }> = []

    vi.spyOn(TeamDiscussionEngine.prototype, 'run').mockImplementation(async () => {
      const enqueuer = getInterjectEnqueuer(flowKey)
      // run 期间注册表能取到 enqueuer，且投递成功（存活标记为 true）
      registryChecks.push({
        phase: 'engine-run',
        registered: typeof enqueuer === 'function' && enqueuer({ id: 'probe-1', content: '运行中的插话', createdAt: 1 }),
      })
      return { status: 'completed', content: '正文内容', transcript: [], scenes: [] }
    })
    vi.spyOn(ChapterFinalizer.prototype, 'finalize').mockImplementation(async () => {
      // engine 已返回、正在收尾（数十秒窗口）：注册表必须已注销 → 此窗口插话 409
      registryChecks.push({ phase: 'finalizer', registered: getInterjectEnqueuer(flowKey) !== undefined })
      return { status: 'completed', content: '正文内容', stateChanges: [] }
    })

    const result = await runner.run(projectId, 1, makeOptionsForRun())

    expect(result.status).toBe('completed')
    expect(registryChecks).toEqual([
      { phase: 'engine-run', registered: true },
      { phase: 'finalizer', registered: false },
    ])
    // runner finally 的幂等双保险：run 结束后注册表仍为空，重复注销不抛错
    expect(getInterjectEnqueuer(flowKey)).toBeUndefined()
    expect(() => unregisterInterjectEnqueuer(flowKey)).not.toThrow()
  })

  it('engine 抛错时同样在 engine 调用处注销 enqueuer（错误收尾窗口内插话 409）', async () => {
    const { projectId, runner, flowKey } = setupInterjectContractProject('p-interject-contract-err', 'ch-interject-contract-err')
    let registeredWhenEngineThrew = false
    vi.spyOn(TeamDiscussionEngine.prototype, 'run').mockImplementation(async () => {
      registeredWhenEngineThrew = getInterjectEnqueuer(flowKey) !== undefined
      throw new Error('LLM 连接中断')
    })

    const result = await runner.run(projectId, 1, makeOptionsForRun())

    expect(registeredWhenEngineThrew).toBe(true)
    expect(result.status).toBe('error')
    expect(result.error).toBe('LLM 连接中断')
    // 引擎抛错路径：engine 调用的 finally 已注销，runner 外层 finally 再注销一次（幂等）
    expect(getInterjectEnqueuer(flowKey)).toBeUndefined()
  })

  it('finalizer 抛错时 enqueuer 已在此前注销（engine 返回与收尾失败之间不受理插话）', async () => {
    const { projectId, runner, flowKey } = setupInterjectContractProject('p-interject-contract-finalize', 'ch-interject-contract-finalize')
    let registeredWhenFinalizeThrew = false
    vi.spyOn(TeamDiscussionEngine.prototype, 'run').mockResolvedValue({
      status: 'completed', content: '正文内容', transcript: [], scenes: [],
    })
    vi.spyOn(ChapterFinalizer.prototype, 'finalize').mockImplementation(async () => {
      registeredWhenFinalizeThrew = getInterjectEnqueuer(flowKey) !== undefined
      throw new Error('Memory 写入失败')
    })

    const result = await runner.run(projectId, 1, makeOptionsForRun())

    expect(registeredWhenFinalizeThrew).toBe(false)
    expect(result.status).toBe('error')
    expect(getInterjectEnqueuer(flowKey)).toBeUndefined()
  })
})

function makeOptionsForRun(): DiscussionOptions {
  return {
    emit: vi.fn(),
    onCheckpoint: vi.fn().mockResolvedValue('approve'),
    onProgress: vi.fn(),
  }
}
