import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { NovelStore } from '../core/novel-store.js'
import { NovelMemoryStore } from '../core/novel-memory-store.js'
import { PromptManager } from '../core/prompting/prompt-manager.js'
import { NovelPromptBuilder } from '../core/prompting/prompt-builder.js'
import { NovelEngine } from '../core/novel-engine.js'
import { NovelCharacterGenerator } from '../core/generation/novel-character-generator.js'
import { novelMigrations } from '../novel-migrations.js'
import type {
  PluginContext,
  PluginSessionHandle,
  PluginSessionOptions
} from '../../../core/plugin/plugin-types.js'

let db: Database.Database
let store: NovelStore
let memoryStore: NovelMemoryStore
let promptManager: PromptManager
let promptBuilder: NovelPromptBuilder
let engine: NovelEngine
let characterGenerator: NovelCharacterGenerator

/** 捕获 createSession 调用与 handle 状态 */
interface MockHandle extends PluginSessionHandle {
  promptCalls: number
  promptStreamCalls: number
  disposeCalls: number
  abortCalls: number
  promptReturn: string
}

interface MockState {
  createSessionCalls: number
  lastOptions: PluginSessionOptions | null
  handles: MockHandle[]
}

let mockState: MockState

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const m of novelMigrations) {
    db.exec(m.sql)
  }
  store = new NovelStore(db)
  memoryStore = new NovelMemoryStore(db)
  promptManager = new PromptManager(db, process.cwd())
  promptBuilder = new NovelPromptBuilder(promptManager, store)
  engine = new NovelEngine(store)

  mockState = {
    createSessionCalls: 0,
    lastOptions: null,
    handles: []
  }
})

afterEach(() => {
  db.close()
})

/** 构建一个 mock PluginContext，其 createSession 返回可控 handle */
function createMockContext(): PluginContext {
  const noop = () => {}
  const logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => logger,
    level: 'silent'
  } as any

  return {
    pluginName: 'novel',
    config: {},
    logger,
    db,
    cwd: process.cwd(),
    dataDir: process.cwd(),
    resolvePath: (...segments: string[]) => join(process.cwd(), ...segments),
    registerBackgroundWork: () => noop,
    registerSettings: () => {},
    subagentManager: undefined,
    teamManager: undefined,
    agentCallLogger: undefined,
    modelRegistry: undefined,
    confirmationManager: {
      requestDecision: () => Promise.resolve('approve'),
      respondDecision: () => true,
      listPending: () => [],
      dispose: noop
    } as any,
    effect: (
      _kind: string,
      _metadata: Record<string, unknown>,
      setup: () => (() => void | Promise<void>) | void
    ) => setup() ?? noop,
    registerDisposable: (dispose: () => void | Promise<void>) => dispose,
    trackSession: (handle: PluginSessionHandle) => () => {
      handle.abort()
      handle.dispose()
    },
    registerTool: noop,
    registerRoute: noop,
    onEvent: noop,
    registerPanel: noop,
    registerMigration: noop,
    registerSessionTools: noop,
    registerService: noop,
    registerPromptTemplates: noop,
    createSession: async (options: PluginSessionOptions): Promise<PluginSessionHandle> => {
      mockState.createSessionCalls++
      mockState.lastOptions = options

      const handle: MockHandle = {
        promptCalls: 0,
        promptStreamCalls: 0,
        disposeCalls: 0,
        abortCalls: 0,
        promptReturn: 'LLM-mock-result',
        async prompt() {
          this.promptCalls++
          return this.promptReturn
        },
        async promptStream(onDelta: (delta: string) => void) {
          this.promptStreamCalls++
          // 模拟流式推送：将完整结果作为单个 delta 推送一次
          if (onDelta) onDelta(this.promptReturn)
          return this.promptReturn
        },
        subscribe(_handler: (event: Record<string, unknown>) => void): () => void {
          return () => {}
        },
        abort() {
          this.abortCalls++
        },
        dispose() {
          this.disposeCalls++
        }
      }
      mockState.handles.push(handle)
      return handle
    },
    // 工厂 stub：测试不直接使用 AG-UI 基础设施，仅满足接口契约
    async createAgUiSession(agUiOptions) {
      const session = await this.createSession(agUiOptions)
      const noop = () => {}
      return {
        session,
        streamEmitter: {
          handleSessionEvent: noop,
          finishTextMessage: noop
        } as any,
        reasoningPipeline: {} as any,
        messageId: 'test-message-id',
        dispose() {
          try {
            session.dispose()
          } catch {
            /* 忽略 */
          }
        }
      }
    }
  } as PluginContext
}

describe('Plugin createSession 集成 - 句柄结构', () => {
  beforeEach(() => {
    characterGenerator = new NovelCharacterGenerator(
      promptBuilder,
      promptManager,
      createMockContext()
    )
    // 预置项目
    store.createProject({
      id: 'p-1',
      title: '测试小说',
      genre: '玄幻',
      synopsis: '',
      targetWords: 0,
      currentVolume: 1,
      currentChapter: 0,
      currentStage: 'setup',
      status: 'active'
    })
  })

  it('createSession 返回包含 prompt/promptStream/abort/dispose 的 handle', async () => {
    const ctx = createMockContext()
    const handle = await ctx.createSession({
      systemPrompt: 'test-system',
      userMessage: 'test-user'
    })
    expect(typeof handle.prompt).toBe('function')
    expect(typeof handle.promptStream).toBe('function')
    expect(typeof handle.abort).toBe('function')
    expect(typeof handle.dispose).toBe('function')
  })

  it('handle.prompt() 返回字符串', async () => {
    const ctx = createMockContext()
    const handle = await ctx.createSession({
      systemPrompt: 'sys',
      userMessage: 'user'
    })
    const result = await handle.prompt()
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('handle.dispose() 可被多次调用不抛错', async () => {
    const ctx = createMockContext()
    const handle = await ctx.createSession({
      systemPrompt: 'sys',
      userMessage: 'user'
    })
    expect(() => handle.dispose()).not.toThrow()
    expect(() => handle.dispose()).not.toThrow()
  })

  it('handle.abort() 不抛错', async () => {
    const ctx = createMockContext()
    const handle = await ctx.createSession({
      systemPrompt: 'sys',
      userMessage: 'user'
    })
    expect(() => handle.abort()).not.toThrow()
  })

  it('createSession 传递的 options 被正确接收', async () => {
    const ctx = createMockContext()
    await ctx.createSession({
      systemPrompt: 'sys-prompt',
      userMessage: 'user-msg'
    })
    expect(mockState.lastOptions).not.toBeNull()
    expect(mockState.lastOptions!.systemPrompt).toBe('sys-prompt')
    expect(mockState.lastOptions!.userMessage).toBe('user-msg')
  })
})

describe('Plugin createSession 集成 - NovelCharacterGenerator', () => {
  beforeEach(() => {
    store.createProject({
      id: 'p-1',
      title: '测试小说',
      genre: '玄幻',
      synopsis: '',
      targetWords: 0,
      currentVolume: 1,
      currentChapter: 0,
      currentStage: 'setup',
      status: 'active'
    })
  })

  it('characterGenerator.generate 调用 createSession 1 次', async () => {
    characterGenerator = new NovelCharacterGenerator(
      promptBuilder,
      promptManager,
      createMockContext()
    )
    await characterGenerator.generate('p-1', '沉默寡言的剑客')
    expect(mockState.createSessionCalls).toBe(1)
    expect(mockState.lastOptions?.tools).toEqual([])
  })

  it('characterGenerator.generate 将本次指定模型传给 createSession', async () => {
    characterGenerator = new NovelCharacterGenerator(
      promptBuilder,
      promptManager,
      createMockContext()
    )
    const modelId = { provider: 'provider-a', modelId: 'model-a' }
    await characterGenerator.generate('p-1', '沉默寡言的剑客', undefined, undefined, modelId)
    expect(mockState.lastOptions?.modelId).toEqual(modelId)
  })

  it('characterGenerator.generate 调用 handle.promptStream() 并获取结果', async () => {
    characterGenerator = new NovelCharacterGenerator(
      promptBuilder,
      promptManager,
      createMockContext()
    )
    await characterGenerator.generate('p-1', '勇敢的少年')
    expect(mockState.handles).toHaveLength(1)
    // generate 现在使用 promptStream 而非 prompt
    expect(mockState.handles[0].promptStreamCalls).toBe(1)
    expect(mockState.handles[0].promptCalls).toBe(0)
  })

  it('characterGenerator.generate 在结束时调用 dispose()', async () => {
    characterGenerator = new NovelCharacterGenerator(
      promptBuilder,
      promptManager,
      createMockContext()
    )
    await characterGenerator.generate('p-1', '聪明的法师')
    expect(mockState.handles).toHaveLength(1)
    expect(mockState.handles[0].disposeCalls).toBe(1)
  })

  it('characterGenerator.generate LLM 返回有效 JSON 时被正确解析', async () => {
    const ctx = createMockContext()
    // 覆盖 createSession 返回特定 JSON
    const mockResult = JSON.stringify({
      name: '李寒山',
      description: '沉默寡言的剑客',
      identity: '出身寒门',
      personality: '冷静内敛',
      appearance: '黑衣长剑',
      currentState: '复仇途中',
      currentGoal: '寻找仇人',
      currentPressure: '身份暴露',
      secret: '前朝遗孤',
      arcStage: 'rising',
      speechStyle: '惜字如金'
    })
    ctx.createSession = async () => ({
      prompt: async () => mockResult,
      promptStream: async (onDelta: (delta: string) => void) => {
        if (onDelta) onDelta(mockResult)
        return mockResult
      },
      abort: () => {},
      subscribe: () => () => {},
      dispose: () => {}
    })
    characterGenerator = new NovelCharacterGenerator(promptBuilder, promptManager, ctx)

    const result = await characterGenerator.generate('p-1', '沉默寡言的剑客')
    expect(result.name).toBe('李寒山')
    expect(result.identity).toBe('出身寒门')
    expect(result.arcStage).toBe('rising')
  })

  it('characterGenerator.generate LLM 返回 ```json 代码块也能被解析', async () => {
    const ctx = createMockContext()
    const mockResult =
      '```json\n{"name":"代码块角色","description":"x","identity":"","personality":"","appearance":"","currentState":"","currentGoal":"","currentPressure":"","secret":"","arcStage":"setup","speechStyle":""}\n```'
    ctx.createSession = async () => ({
      prompt: async () => mockResult,
      promptStream: async (onDelta: (delta: string) => void) => {
        if (onDelta) onDelta(mockResult)
        return mockResult
      },
      abort: () => {},
      subscribe: () => () => {},
      dispose: () => {}
    })
    characterGenerator = new NovelCharacterGenerator(promptBuilder, promptManager, ctx)
    const result = await characterGenerator.generate('p-1', 'x')
    expect(result.name).toBe('代码块角色')
  })

  it('characterGenerator.generate LLM 返回非 JSON 时回退到模板角色', async () => {
    const ctx = createMockContext()
    const mockResult = '这不是 JSON 格式的回复'
    ctx.createSession = async () => ({
      prompt: async () => mockResult,
      promptStream: async (onDelta: (delta: string) => void) => {
        if (onDelta) onDelta(mockResult)
        return mockResult
      },
      abort: () => {},
      subscribe: () => () => {},
      dispose: () => {}
    })
    characterGenerator = new NovelCharacterGenerator(promptBuilder, promptManager, ctx)
    const result = await characterGenerator.generate('p-1', '沉默寡言的剑客背负血海深仇')
    // 回退到模板角色：name 应包含"沉默"作为推断姓名
    expect(result.name).toContain('沉默')
    // currentState 应基于关键词"沉默"推断
    expect(result.currentState).toContain('内心封闭')
  })

  it('characterGenerator.generate handle.prompt 抛错时回退到模板角色', async () => {
    const ctx = createMockContext()
    ctx.createSession = async () => ({
      prompt: async () => {
        throw new Error('LLM 调用失败')
      },
      promptStream: async () => {
        throw new Error('LLM 调用失败')
      },
      abort: () => {},
      subscribe: () => () => {},
      dispose: () => {}
    })
    characterGenerator = new NovelCharacterGenerator(promptBuilder, promptManager, ctx)
    const result = await characterGenerator.generate('p-1', '愤怒的战士')
    expect(result.name).toContain('愤怒')
    // 失败时仍应调用 dispose
  })

  it('characterGenerator.generate 即使失败也调用 dispose', async () => {
    const disposeFn = vi.fn()
    const ctx = createMockContext()
    ctx.createSession = async () => ({
      prompt: async () => {
        throw new Error('LLM 调用失败')
      },
      promptStream: async () => {
        throw new Error('LLM 调用失败')
      },
      abort: () => {},
      subscribe: () => () => {},
      dispose: disposeFn
    })
    characterGenerator = new NovelCharacterGenerator(promptBuilder, promptManager, ctx)
    await characterGenerator.generate('p-1', '聪明的法师')
    expect(disposeFn).toHaveBeenCalledTimes(1)
  })

  it('characterGenerator.generate createSession 抛错时不调用 dispose', async () => {
    // createSession 本身抛错，handle 不存在，无法调用 dispose
    const ctx = createMockContext()
    ctx.createSession = async () => {
      throw new Error('Session 创建失败')
    }
    characterGenerator = new NovelCharacterGenerator(promptBuilder, promptManager, ctx)
    // createSession 抛错未被捕获，将向上传播
    await expect(characterGenerator.generate('p-1', 'x')).rejects.toThrow('Session 创建失败')
  })
})

describe('Plugin createSession 集成 - 多次调用独立性', () => {
  beforeEach(() => {
    store.createProject({
      id: 'p-1',
      title: '测试小说',
      genre: '玄幻',
      synopsis: '',
      targetWords: 0,
      currentVolume: 1,
      currentChapter: 0,
      currentStage: 'setup',
      status: 'active'
    })
  })

  it('多次调用 generate 创建多个独立 handle', async () => {
    characterGenerator = new NovelCharacterGenerator(
      promptBuilder,
      promptManager,
      createMockContext()
    )
    await characterGenerator.generate('p-1', '角色A')
    await characterGenerator.generate('p-1', '角色B')
    expect(mockState.createSessionCalls).toBe(2)
    expect(mockState.handles).toHaveLength(2)
    // 每次 generate 都会 dispose 自己的 handle
    expect(mockState.handles[0].disposeCalls).toBe(1)
    expect(mockState.handles[1].disposeCalls).toBe(1)
  })

  it('handle 之间的 prompt 调用互不干扰', async () => {
    const ctx = createMockContext()
    const h1 = await ctx.createSession({ systemPrompt: 'a', userMessage: 'a' })
    const h2 = await ctx.createSession({ systemPrompt: 'b', userMessage: 'b' })

    // mock 句柄的 prompt 返回固定 'LLM-mock-result'，验证独立计数
    await h1.prompt()
    await h1.prompt()
    await h2.prompt()

    const handles = mockState.handles
    expect(handles[0].promptCalls).toBe(2)
    expect(handles[1].promptCalls).toBe(1)
  })
})
