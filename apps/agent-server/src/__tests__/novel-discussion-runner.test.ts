import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { NovelStore } from '../plugins/novel-plugin/core/novel-store.js'
import { NovelMemoryStore } from '../plugins/novel-plugin/core/novel-memory-store.js'
import { PromptManager } from '../plugins/novel-plugin/core/prompt-manager.js'
import { NovelPromptBuilder } from '../plugins/novel-plugin/core/prompt-builder.js'
import { NovelEngine } from '../plugins/novel-plugin/core/novel-engine.js'
import { NovelSessionFactory } from '../plugins/novel-plugin/core/novel-session.js'
import { novelMigrations } from '../plugins/novel-plugin/novel-migrations.js'
import { NovelDiscussionRunner } from '../plugins/novel-plugin/core/novel-discussion-runner.js'
import type { DiscussionOptions } from '../core/agent/discussion-types.js'

function setupTestDb(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of novelMigrations) {
    db.exec(migration.sql)
  }
  return db
}

function makeOptions(): DiscussionOptions {
  return {
    emit: vi.fn(),
    onCheckpoint: vi.fn().mockResolvedValue('approve'),
    onProgress: vi.fn(),
  }
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
    const sessionFactory = new NovelSessionFactory(store, promptManager)
    const engine = new NovelEngine(store, sessionFactory)
    const mockContext = {
      createAgUiSession: vi.fn(),
      createSession: vi.fn(),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    } as any

    const runner = new NovelDiscussionRunner(
      store, memoryStore, sessionFactory, promptBuilder, engine, mockContext, {} as any,
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
    const sessionFactory = new NovelSessionFactory(store, promptManager)
    const engine = new NovelEngine(store, sessionFactory)
    const mockContext = {
      createAgUiSession: vi.fn(),
      createSession: vi.fn(),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    } as any

    const runner = new NovelDiscussionRunner(
      store, memoryStore, sessionFactory, promptBuilder, engine, mockContext, {} as any,
    )
    const prompt = (runner as any).buildCharacterPrompt(char)
    expect(prompt).toContain('李明')
    expect(prompt).toContain('沉稳冷静')
    expect(prompt).toContain('焦虑')
    expect(prompt).toContain('保护家人')
    expect(prompt).toContain('欠债')
    expect(prompt).toContain('挣扎')
    expect(prompt).toContain('绝不使用破折号')
  })
})
