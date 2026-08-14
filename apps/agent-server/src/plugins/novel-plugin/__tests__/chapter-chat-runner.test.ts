import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { novelMigrations } from '../novel-migrations.js'
import { NovelStore } from '../core/novel-store.js'
import { NovelMemoryStore } from '../core/novel-memory-store.js'
import { PromptManager } from '../core/prompting/prompt-manager.js'
import { NovelPromptBuilder } from '../core/prompt-builder.js'
import { NovelEngine } from '../core/novel-engine.js'
import { ChapterChatStore } from '../core/chapters/chapter-chat-store.js'
import { ChapterChatRunner } from '../core/chapters/chapter-chat-runner.js'

describe('ChapterChatRunner', () => {
  let db: Database.Database
  let store: NovelStore
  let chatStore: ChapterChatStore

  beforeEach(() => {
    db = new Database(':memory:')
    for (const migration of novelMigrations) db.exec(migration.sql)
    store = new NovelStore(db)
    chatStore = new ChapterChatStore(db)
  })

  afterEach(() => db.close())

  function createRunner(createAgUiSession = vi.fn()) {
    const memoryStore = new NovelMemoryStore(db)
    const promptBuilder = new NovelPromptBuilder(
      new PromptManager(db, process.cwd()), store, memoryStore,
    )
    return {
      runner: new ChapterChatRunner(
        store,
        promptBuilder,
        new NovelEngine(store),
        {
          createAgUiSession,
          createSession: vi.fn(),
          logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        } as any,
        chatStore,
      ),
      createAgUiSession,
    }
  }

  it('不存在的项目或章节在用户消息落库前失败', async () => {
    const { runner, createAgUiSession } = createRunner(vi.fn())

    await expect(runner.run(
      'missing-project', 1, { message: '有人吗' },
      { emit: vi.fn(), modelId: { provider: 'test', modelId: 'test' } },
    )).rejects.toThrow('项目不存在')

    expect(chatStore.list('missing-project', 1)).toEqual([])
    expect(createAgUiSession).not.toHaveBeenCalled()

    const project = store.createProject({
      id: 'project-without-chapter', title: '空项目', genre: '悬疑', synopsis: '', outline: '',
      targetWords: 50000, currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
    } as any)
    await expect(runner.run(
      project.id, 1, { message: '这一章呢' },
      { emit: vi.fn(), modelId: { provider: 'test', modelId: 'test' } },
    )).rejects.toThrow('章节不存在或不属于该项目')
    expect(chatStore.list(project.id, 1)).toEqual([])
    expect(createAgUiSession).not.toHaveBeenCalled()
  })

  it('选择本次模型且未点名时仍由 Moderator 选择回复方', async () => {
    const project = store.createProject({
      id: 'moderated-model-chat', title: '调度测试', genre: '悬疑', synopsis: '', outline: '',
      targetWords: 3000, currentVolume: 1, currentChapter: 1, currentStage: 'setup', status: 'active',
    } as any)
    store.createChapter({
      id: 'moderated-model-chapter', projectId: project.id, volume: 1, chapterNumber: 1,
      title: '第一章', content: '正文', wordCount: 2, status: 'review', narrativeTask: '', outline: '',
      volumeId: null, acceptanceResult: null,
    } as any)
    const createSession = vi.fn().mockResolvedValue({
      prompt: vi.fn().mockResolvedValue(JSON.stringify({
        type: 'invite', agentId: 'novel-writer', prompt: '回答问题', reason: '写作问题',
      })),
      dispose: vi.fn(),
    })
    const createAgUiSession = vi.fn().mockResolvedValue({
      session: { prompt: vi.fn().mockResolvedValue('写作回复') },
      streamEmitter: { finishTextMessage: vi.fn() }, messageId: 'reply', dispose: vi.fn(),
    })
    const promptBuilder = new NovelPromptBuilder(
      new PromptManager(db, process.cwd()), store, new NovelMemoryStore(db),
    )
    const runner = new ChapterChatRunner(
      store, promptBuilder, new NovelEngine(store),
      { createAgUiSession, createSession, logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } } as any,
      chatStore,
      { provider: 'cheap', modelId: 'moderator' },
    )
    const selectedModel = { provider: 'selected', modelId: 'reply-model' }

    const result = await runner.run(
      project.id, 1, { message: '这一段怎么改？' }, { emit: vi.fn(), modelId: selectedModel },
    )

    expect(result.replies[0]?.agentId).toBe('novel-writer')
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      modelId: { provider: 'cheap', modelId: 'moderator' },
    }))
    expect(createAgUiSession).toHaveBeenCalledWith(expect.objectContaining({ modelId: selectedModel }))
  })

  it('未选择本次模型时工种回复使用 AgentPage 模型配置', async () => {
    const project = store.createProject({
      id: 'configured-model-chat', title: '配置模型', genre: '悬疑', synopsis: '', outline: '',
      targetWords: 3000, currentVolume: 1, currentChapter: 1, currentStage: 'setup', status: 'active',
    } as any)
    store.createChapter({
      id: 'configured-model-chapter', projectId: project.id, volume: 1, chapterNumber: 1,
      title: '第一章', content: '正文', wordCount: 2, status: 'review', narrativeTask: '', outline: '',
      volumeId: null, acceptanceResult: null,
    } as any)
    const configuredModel = { provider: 'agent', modelId: 'writer-model' }
    const createAgUiSession = vi.fn().mockResolvedValue({
      session: { prompt: vi.fn().mockResolvedValue('写作回复') },
      streamEmitter: { finishTextMessage: vi.fn() }, messageId: 'reply', dispose: vi.fn(),
    })
    const promptBuilder = new NovelPromptBuilder(
      new PromptManager(db, process.cwd()), store, new NovelMemoryStore(db),
    )
    const runner = new ChapterChatRunner(
      store, promptBuilder, new NovelEngine(store),
      {
        createAgUiSession, createSession: vi.fn(),
        subagentManager: { getAgent: vi.fn((id: string) => id === 'novel-writer' ? { model: configuredModel } : undefined) },
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      } as any,
      chatStore,
    )

    await runner.run(
      project.id, 1, { message: '给我建议', mentionedAgents: ['novel-writer'] }, { emit: vi.fn() },
    )

    expect(createAgUiSession).toHaveBeenCalledWith(expect.objectContaining({ modelId: configuredModel }))
  })

  it('角色回复读取章节、说话风格、声音坐标和本人认知，不读取作者全知信息', async () => {
    const project = store.createProject({
      id: 'chat-project', title: '暗门', genre: '悬疑', synopsis: '', outline: '', targetWords: 50000,
      currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
    } as any)
    store.createChapter({
      id: 'chat-chapter-1', projectId: project.id, volume: 1, chapterNumber: 1,
      title: '门后的声音', content: '林晚停在暗门前，听见里面有人敲了三下。', wordCount: 22,
      status: 'review', narrativeTask: '决定是否打开暗门', outline: '林晚发现暗门',
      volumeId: null, acceptanceResult: null, positioning: '推进章',
    } as any)
    const character = store.createCharacter({
      id: 'chat-character', projectId: project.id, name: '林晚', identity: '调查员',
      personality: '谨慎，不轻易相信别人', currentState: '站在暗门外', currentGoal: '确认门后的人',
      secret: '她曾来过这里', arcStage: 'rising', speechStyle: '短句，直答，语气克制',
    } as any)
    store.createInformationLayer({
      id: 'chat-info', projectId: project.id, infoDescription: '敲门者使用约定暗号',
      authorKnows: true, readerKnows: false,
      characterKnowledge: JSON.stringify({ [character.id]: { suspects: true } }),
      revealStage: null, revealChapter: null, isRevealed: false,
    })
    const createAgUiSession = vi.fn().mockResolvedValue({
      session: { prompt: vi.fn().mockResolvedValue('我不会贸然开门。') },
      streamEmitter: { finishTextMessage: vi.fn() },
      messageId: 'chapter-chat-message',
      dispose: vi.fn(),
    })
    const { runner } = createRunner(createAgUiSession)

    const result = await runner.run(
      project.id,
      1,
      { message: '你会开门吗？', mentionedAgents: [`char-${character.id}`] },
      { emit: vi.fn(), modelId: { provider: 'test', modelId: 'test' } },
    )

    expect(result.replies).toEqual([expect.objectContaining({
      agentId: `char-${character.id}`,
      content: '我不会贸然开门。',
    })])
    const invocation = createAgUiSession.mock.calls[0][0]
    expect(invocation.systemPrompt).toContain('角色推演')
    expect(invocation.prefixUserMessage).toEqual([
      expect.stringContaining('林晚发现暗门'),
      expect.stringContaining('说话风格'),
    ])
    const prefix = JSON.stringify(invocation.prefixUserMessage)
    expect(prefix).toContain('当前章节：第 1 章')
    expect(prefix).toContain('句长')
    expect(prefix).toContain('你有所怀疑：敲门者使用约定暗号')
    expect(prefix).not.toContain('林晚停在暗门前，听见里面有人敲了三下')
    expect(prefix).not.toContain('作者知道')
    expect(chatStore.list(project.id, 1).map(message => message.role)).toEqual(['user', 'agent'])
  })

  it('历史章节自由聊天使用 N-1 角色卡，不读取当前表的未来动态状态', async () => {
    const project = store.createProject({
      id: 'historical-chat-project', title: '旧章对话', genre: '悬疑', synopsis: '', outline: '',
      targetWords: 3000, currentVolume: 1, currentChapter: 2, currentStage: 'rising', status: 'active',
    } as any)
    store.createChapter({
      id: 'historical-chat-1', projectId: project.id, volume: 1, chapterNumber: 1,
      title: '码头', content: '沈舟被困在码头。', wordCount: 9, status: 'review',
      narrativeTask: '', outline: '', volumeId: null, acceptanceResult: null,
    } as any)
    store.createChapter({
      id: 'historical-chat-2', projectId: project.id, volume: 1, chapterNumber: 2,
      title: '追捕', content: '旧第二章正文。', wordCount: 7, status: 'review',
      narrativeTask: '逃出码头', outline: '', volumeId: null, acceptanceResult: null,
    } as any)
    const character = store.createCharacter({
      id: 'historical-chat-character', projectId: project.id, name: '沈舟', identity: '调查员',
      personality: '谨慎', speechStyle: '短句，克制', currentState: '未来章已经脱险',
      currentGoal: '未来章追查幕后者', secret: '未来章才揭露', arcStage: '未来章觉醒',
    } as any)
    const memoryStore = new NovelMemoryStore(db)
    memoryStore.saveSnapshot({
      projectId: project.id, chapterNumber: 1, snapshotType: 'full', entityId: null,
      snapshotData: JSON.stringify({
        characters: [{
          ...character,
          currentState: '第一章末仍被困在码头',
          currentGoal: '设法离开码头',
          secret: '尚未说出的旧案线索',
          arcStage: '怀疑',
        }],
        relationships: [], conflicts: [], foreshadowing: [], clues: [], factions: [],
        locations: [], items: [], worldElements: [], informationLayers: [], edges: [],
      }),
    })
    const createAgUiSession = vi.fn().mockResolvedValue({
      session: { prompt: vi.fn().mockResolvedValue('我还在找出口。') },
      streamEmitter: { finishTextMessage: vi.fn() },
      messageId: 'historical-chat-message',
      dispose: vi.fn(),
    })
    const promptBuilder = new NovelPromptBuilder(
      new PromptManager(db, process.cwd()), store, memoryStore,
    )
    const runner = new ChapterChatRunner(
      store,
      promptBuilder,
      new NovelEngine(store),
      {
        createAgUiSession,
        createSession: vi.fn(),
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      } as any,
      chatStore,
    )

    await runner.run(
      project.id,
      2,
      { message: '你现在在哪里？', mentionedAgents: [`char-${character.id}`] },
      { emit: vi.fn(), modelId: { provider: 'test', modelId: 'test' } },
    )

    const prefix = JSON.stringify(createAgUiSession.mock.calls[0][0].prefixUserMessage)
    expect(prefix).toContain('第一章末仍被困在码头')
    expect(prefix).toContain('设法离开码头')
    expect(prefix).toContain('尚未说出的旧案线索')
    expect(prefix).toContain('怀疑')
    expect(prefix).not.toContain('未来章已经脱险')
    expect(prefix).not.toContain('未来章追查幕后者')
    expect(prefix).not.toContain('未来章才揭露')
    expect(prefix).not.toContain('未来章觉醒')
  })
})
