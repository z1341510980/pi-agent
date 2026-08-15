/**
 * create-flow 插话队列测试（对话化交互形态 §3.1 / 批次 1 任务 1）。
 *
 * 背景：
 *   既有 setUserMessages 是「覆盖」语义（检查点决策 comment 通道），
 *   无法承载运行中用户的多条中途反馈。本测试钉死插话队列作为并行第二通道的行为：
 *   - enqueue 追加不覆盖；drain 按 targetAgent 定向取走且不重复；
 *   - 与 setUserMessages 两通道互不干扰（覆盖语义只作用于自己的通道）；
 *   - runAgentOnce 在既有「用户创作指令」注入点旁以「用户中途反馈」区块注入，
 *     并触发 onInterjectInjected 回调（供任务 2 SSE injected 状态）；
 *   - 盲审（consumeUserMessages: false）不消费插话，留给完整 Reviewer；
 *   - flow 到达终态（completed / error）后队列清空，drain 返回空（§4 不静默丢失的反面：不残留）；
 *   - 队列按 flow 隔离（orchestrator 是插件级单例）：flowKey 定向的消息不被其他 flow
 *     drain、不被其他 flow 的终态误清，收尾时经 onInterjectDropped 回调暴露 dropped ids；
 *   - targetAgent='memory' 前置拒绝（返回 false）：Memory 主路径是结构化 LLM 调用，不经插话通道。
 *
 * 测试策略：
 *   队列 API 与注入用例沿用 novel-orchestrator-skill-path.test.ts 的哨兵模式
 *   （createAgUiSession 抛错，让 runAgentOnce 在 LLM 调用前停下，断言收到的参数）；
 *   终态清空用例沿用 novel-orchestrator-run-context.test.ts 的轻量编排模式
 *   （Object.create + mock runAgent/finalizer，最小代价跑完真实状态机到终态）。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NovelOrchestrator, type InterjectMessage } from '../core/novel-orchestrator.js'
import { NovelPromptBuilder } from '../core/prompt-builder.js'
import { PromptManager } from '../core/prompting/prompt-manager.js'
import { getNovelAskStoryPolicy } from '../core/domain/novel-ask-story-policy.js'
import { createChapterBudgetUsage } from '../core/chapters/chapter-budget.js'
import type { NovelAgentType } from '../core/domain/novel-agents.js'
import type { NovelEngine } from '../core/novel-engine.js'
import type { PluginContext } from '../../../core/plugin/plugin-types.js'
import type { CreationOptions } from '../../../core/agent/chapter-finalizer.js'
import {
  createNovelFixture,
  createPromptStores,
  FIXTURE_TARGET_CHAPTER,
  type NovelFixture,
} from './fixtures/novel-fixture.js'

/** createAgUiSession 抛出的哨兵错误：让 runAgentOnce 在 LLM 调用前停下。 */
const STOP_ERROR = 'test-stop-before-llm'

// —— 以下常量与轻量编排 mock 沿用 novel-orchestrator-run-context.test.ts 的模式 ——
// Director / Reviewer 通过工具提交结构化对象（mock runAgent 时从 overrides.extraTools
// 拿到工具实例并 execute），让真实状态机能走完 completed 路径。
async function invokeExtraTool(overrides: unknown, params: Record<string, unknown>): Promise<void> {
  const tools = (overrides as { extraTools?: Array<{ execute: (id: string, p: Record<string, unknown>) => Promise<unknown> }> } | undefined)?.extraTools
  if (!tools || tools.length === 0) return
  await tools[0]!.execute('test-call', params)
}

const DIRECTOR_TOOL_PARAMS = {
  taskType: 'advance_mainline',
  priority: 'high',
  narrativeTask: '本章核心目标：推进主线，让主角通过行动解决当前困境。',
  secondaryTasks: [],
  requiredReferences: [],
  chapterEndingHook: { type: 'suspense', description: '章尾钩子' },
  povCharacters: ['主角'],
  sceneCount: 1,
  positioning: 'high_pressure',
  timelineOffset: { days: 0, description: '同日' },
}

const REVIEWER_TOOL_PARAMS = {
  consistencyScore: 8,
  characterScore: 7,
  taskCompletionScore: 9,
  clueProgressScore: 6,
  foreshadowStatusScore: 8,
  conflictChangeScore: 7,
  pacingScore: 6,
  infoControlScore: 9,
  readerHookScore: 8,
  styleScore: 7,
  overallScore: 7.5,
  verdict: 'accept' as const,
  issues: [],
  suggestions: [],
}

describe('NovelOrchestrator 插话队列（create-flow 中途反馈）', () => {
  let fx: NovelFixture
  let orchestrator: NovelOrchestrator
  let onInterjectInjected: ReturnType<typeof vi.fn>
  let createAgUiSessionSpy: ReturnType<typeof vi.fn>

  const options: CreationOptions = {
    emit: vi.fn(),
    onCheckpoint: vi.fn(async () => 'approve'),
    onProgress: vi.fn(),
    onConversationMessage: vi.fn(),
  } as unknown as CreationOptions

  beforeAll(() => {
    fx = createNovelFixture()
  })

  afterAll(() => {
    fx.close()
  })

  beforeEach(() => {
    // 每用例新建 orchestrator：队列按实例隔离，避免用例间队列残留
    const promptManager = new PromptManager(fx.db, process.cwd())
    const promptBuilder = new NovelPromptBuilder(
      promptManager,
      createPromptStores(fx.store) as never,
      fx.memoryStore,
    )
    const engine = {
      buildChapterConstraints: () => fx.constraints,
    } as unknown as NovelEngine

    const silentLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      trace: () => {},
      fatal: () => {},
      child: () => silentLogger,
    }
    createAgUiSessionSpy = vi.fn(() => {
      throw new Error(STOP_ERROR)
    })
    const context = {
      logger: silentLogger,
      db: fx.db,
      subagentManager: undefined,
      agentCallLogger: undefined,
      createAgUiSession: createAgUiSessionSpy,
    } as unknown as PluginContext

    onInterjectInjected = vi.fn()
    orchestrator = new NovelOrchestrator(
      fx.store,
      fx.memoryStore,
      [],
      promptBuilder,
      engine,
      context,
      undefined,
      { onInterjectInjected },
    )
  })

  async function invokeRunAgentOnce(
    agentType: NovelAgentType,
    overrides?: { contextMode?: 'full' | 'identity_only' | 'editor'; consumeUserMessages?: boolean },
  ): Promise<unknown> {
    const run = {
      askStoryPolicy: getNovelAskStoryPolicy(fx.store.getProject(fx.projectId)?.novelAskStoryPolicy),
      factPackPathActive: true,
      arrangedEntities: fx.arrangedEntities,
      semiLayerSharedCache: null,
      budget: createChapterBudgetUsage(),
    }
    const runStorage = (orchestrator as unknown as { runStorage: { run: (s: unknown, cb: () => Promise<unknown>) => Promise<unknown> } }).runStorage
    return runStorage.run(run, () =>
      (orchestrator as unknown as {
        runAgentOnce: (
          agentType: NovelAgentType,
          projectId: string,
          chapterNumber: number,
          input: unknown,
          options: CreationOptions,
          overrides?: Record<string, unknown>,
        ) => Promise<unknown>
      }).runAgentOnce(
        agentType,
        fx.projectId,
        FIXTURE_TARGET_CHAPTER,
        `请为第 ${FIXTURE_TARGET_CHAPTER} 章执行你的角色职责。`,
        options,
        overrides,
      ),
    )
  }

  /** 读取 createAgUiSession 收到的调用参数（哨兵错误前已完整构建）。 */
  function sessionArg(): Record<string, unknown> {
    expect(createAgUiSessionSpy).toHaveBeenCalled()
    return createAgUiSessionSpy.mock.calls[0][0] as Record<string, unknown>
  }

  // ───────────────────────── 队列 API ─────────────────────────

  it('enqueue 追加不覆盖；drain 按 targetAgent 定向取走且不重复返回', () => {
    expect(orchestrator.enqueueUserMessage({ id: 'm-free', content: '打斗戏改用棍' })).toBe(true)
    expect(orchestrator.enqueueUserMessage({ id: 'm-writer', content: '结尾留一个悬念钩子', targetAgent: 'writer' })).toBe(true)
    expect(orchestrator.enqueueUserMessage({ id: 'm-reviser', content: '修订时保留对话原貌', targetAgent: 'reviser' })).toBe(true)

    // 剩余未注入保持完整（FIFO 顺序）
    expect(orchestrator.pendingMessages().map(m => m.id)).toEqual(['m-free', 'm-writer', 'm-reviser'])
    expect(orchestrator.pendingMessages()[0].createdAt).toBeGreaterThan(0)

    // director 只取走无 targetAgent 的消息
    const forDirector = orchestrator.drainPendingMessages('director')
    expect(forDirector.map(m => m.id)).toEqual(['m-free'])
    expect(forDirector[0].content).toBe('打斗戏改用棍')

    // 已 drain 不重复返回
    expect(orchestrator.drainPendingMessages('director')).toEqual([])

    // 定向消息等目标 Agent 被调用时注入
    const forWriter = orchestrator.drainPendingMessages('writer')
    expect(forWriter.map(m => m.id)).toEqual(['m-writer'])

    const forReviser = orchestrator.drainPendingMessages('reviser')
    expect(forReviser.map(m => m.id)).toEqual(['m-reviser'])

    expect(orchestrator.pendingMessages()).toEqual([])
  })

  it('targetAgent=memory 前置拒绝：返回 false 且不入队（memory 主路径不经插话通道）', () => {
    expect(orchestrator.enqueueUserMessage({ id: 'm-mem', content: '本章要回收伏笔', targetAgent: 'memory' })).toBe(false)
    // 被拒消息不进队列：不会以 queued → dropped 的假流转糊弄调用方
    expect(orchestrator.pendingMessages()).toEqual([])
  })

  it('并发 flow 隔离：drain 只消费本 flow 定向与全局消息，不消费其他 flow 的', () => {
    orchestrator.enqueueUserMessage({ id: 'fa-1', content: 'flowA 定向反馈', flowKey: 'projA|1' })
    orchestrator.enqueueUserMessage({ id: 'global-1', content: '全局反馈' })
    orchestrator.enqueueUserMessage({ id: 'fb-1', content: 'flowB 定向反馈', flowKey: 'projB|2', targetAgent: 'writer' })

    // flowB 的 director：取走全局的，不取 flowA 定向的，也不取 flowB 里 writer 定向的
    const forFlowBDirector = orchestrator.drainPendingMessages('director', 'projB|2')
    expect(forFlowBDirector.map(m => m.id)).toEqual(['global-1'])

    // flowB 的 writer：只取 flowB 定向的；flowA 定向的仍留给 flowA
    const forFlowBWriter = orchestrator.drainPendingMessages('writer', 'projB|2')
    expect(forFlowBWriter.map(m => m.id)).toEqual(['fb-1'])

    // flowA 的任意 Agent 可取回自己的定向消息
    const forFlowA = orchestrator.drainPendingMessages('director', 'projA|1')
    expect(forFlowA.map(m => m.id)).toEqual(['fa-1'])
    expect(orchestrator.pendingMessages()).toEqual([])
  })

  it('setUserMessages 与插话队列互不干扰：覆盖语义只作用于检查点通道', async () => {
    orchestrator.setUserMessages(fx.projectId, FIXTURE_TARGET_CHAPTER, ['第一条检查点意见'])
    orchestrator.enqueueUserMessage({ id: 'm-1', content: '打斗戏改用棍' })
    // 检查点通道仍是覆盖语义（既有调用方行为零改动）
    orchestrator.setUserMessages(fx.projectId, FIXTURE_TARGET_CHAPTER, ['第二条检查点意见'])

    await expect(invokeRunAgentOnce('director')).rejects.toThrow(STOP_ERROR)

    const userMessage = sessionArg().userMessage as string
    // 检查点通道：覆盖后只剩第二条
    expect(userMessage).toContain('## 用户创作指令')
    expect(userMessage).toContain('第二条检查点意见')
    expect(userMessage).not.toContain('第一条检查点意见')
    // 插话通道：追加消息完整保留，以「用户中途反馈」区块呈现
    expect(userMessage).toContain('【用户中途反馈】')
    expect(userMessage).toContain('（流程进行中用户提出，优先级高于任务指令）')
    expect(userMessage).toContain('打斗戏改用棍')
    // 插话已注入即出队
    expect(orchestrator.pendingMessages()).toEqual([])
  })

  it('runAgentOnce 注入后触发 onInterjectInjected（ids + agentType），盲审不消费', async () => {
    orchestrator.enqueueUserMessage({ id: 'i-free', content: '自由反馈给下一个 Agent' })
    orchestrator.enqueueUserMessage({ id: 'i-dir', content: '定向给导演的意见', targetAgent: 'director' })
    orchestrator.enqueueUserMessage({ id: 'i-wri', content: '定向给写手的意见', targetAgent: 'writer' })

    await expect(invokeRunAgentOnce('director')).rejects.toThrow(STOP_ERROR)

    // 回调收到注入的 id 列表（无 target + 匹配 target，按入队顺序）与 agentType
    expect(onInterjectInjected).toHaveBeenCalledTimes(1)
    expect(onInterjectInjected).toHaveBeenCalledWith(['i-free', 'i-dir'], 'director')

    const userMessage = sessionArg().userMessage as string
    expect(userMessage).toContain('自由反馈给下一个 Agent')
    expect(userMessage).toContain('定向给导演的意见')
    // writer 定向消息不被 director 消费，留在队列
    expect(userMessage).not.toContain('定向给写手的意见')
    expect(orchestrator.pendingMessages().map(m => m.id)).toEqual(['i-wri'])

    // 盲审（consumeUserMessages: false）不消费插话，留给完整 Reviewer
    onInterjectInjected.mockClear()
    await expect(invokeRunAgentOnce('reviewer', { contextMode: 'identity_only', consumeUserMessages: false }))
      .rejects.toThrow(STOP_ERROR)
    expect(onInterjectInjected).not.toHaveBeenCalled()
    expect(orchestrator.pendingMessages().map(m => m.id)).toEqual(['i-wri'])
  })

  // ───────────────────────── flow 终态清空 ─────────────────────────

  /** 轻量编排实例（沿用 novel-orchestrator-run-context.test.ts 的模式）：mock runAgent / finalizer。 */
  function createLightweightOrchestrator(): { orchestrator: NovelOrchestrator; failFirstAgentRun: (err: Error) => void } {
    const instance = Object.create(NovelOrchestrator.prototype) as any
    instance.runStorage = new AsyncLocalStorage()
    instance.pendingUserMessages = new Map()
    instance.store = {
      getNovelModelId: () => undefined,
      getProject: () => ({ currentStage: 'setup', rhythmModelId: 'default', currentChapter: 1 }),
      getWritingStyleProfile: () => undefined,
      listChapters: () => [],
      listConflicts: () => [],
      listForeshadowing: () => [],
      getChapter: () => ({ id: 'chapter-1', positioning: null }),
      listHooksByChapter: () => [],
    }
    instance.promptBuilder = {
      stripEmDash: (value: string) => value,
      buildProseEditorIdentity: () => '文字编辑身份',
      buildReviewFactPack: vi.fn(() => ''),
      getChapterBoundaryContext: () => ({
        chapterNumber: 1,
        fromSnapshot: false,
        state: {},
        entities: {
          characters: [], relationships: [], conflicts: [], foreshadowing: [], clues: [],
          factions: [], locations: [], items: [], worldElements: [], informationLayers: [], edges: [],
        },
      }),
    }
    instance.context = { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }
    instance.engine = {
      buildChapterConstraints: () => ({ wordBudget: { target: 3000 } }),
      saveReview: vi.fn(async () => ({})),
    }
    let agentError: Error | undefined
    instance.runAgent = vi.fn(async (
      agentType: string,
      _projectId: string,
      _chapterNumber: number,
      _input: string,
      _options: unknown,
      overrides?: unknown,
    ) => {
      if (agentError) {
        const err = agentError
        agentError = undefined
        throw err
      }
      if (agentType === 'director') {
        await invokeExtraTool(overrides, DIRECTOR_TOOL_PARAMS)
        return 'Director 已通过工具提交叙事任务'
      }
      if (agentType === 'writer') return '通过的完整正文'
      if (agentType === 'reviewer') {
        await invokeExtraTool(overrides, REVIEWER_TOOL_PARAMS).catch(() => {})
      }
      return '验收通过'
    })
    instance.runPostWriteGuard = vi.fn(() => ({ shouldRewrite: false, reason: '' }))
    instance.finalizer = {
      finalize: vi.fn(async ({ content }: { content: string }) => ({ status: 'completed', content })),
    }
    return {
      orchestrator: instance as NovelOrchestrator,
      failFirstAgentRun: (err: Error) => { agentError = err },
    }
  }

  it('flow 到达 completed 终态后清空插话队列', async () => {
    const { orchestrator: orch } = createLightweightOrchestrator()
    orch.enqueueUserMessage({ id: 'drop-1', content: '来不及注入的反馈', targetAgent: 'reviser' })
    expect(orch.pendingMessages()).toHaveLength(1)

    const result = await orch.createChapterWithFlow('project', 1, {
      emit: vi.fn(),
      onCheckpoint: vi.fn(async () => 'approve' as const),
      onProgress: vi.fn(),
    })

    expect(result.status).toBe('completed')
    expect(orch.pendingMessages()).toEqual([])
    expect(orch.drainPendingMessages('reviser')).toEqual([])
  })

  it('并发 flow 终态隔离：flowA 结束只清自己的插话并回调 onInterjectDropped，不动 flowB 的', async () => {
    const { orchestrator: orch } = createLightweightOrchestrator()
    const onInterjectDropped = vi.fn()
    ;(orch as unknown as { hooks?: unknown }).hooks = { onInterjectDropped }

    orch.enqueueUserMessage({ id: 'fa-drop', content: 'flowA 来不及注入的反馈', flowKey: 'projA|1' })
    orch.enqueueUserMessage({ id: 'fb-stay', content: 'flowB 运行中的反馈', flowKey: 'projB|2' })

    const result = await orch.createChapterWithFlow('projA', 1, {
      emit: vi.fn(),
      onCheckpoint: vi.fn(async () => 'approve' as const),
      onProgress: vi.fn(),
    })

    expect(result.status).toBe('completed')
    // flowA 终态：只清 flowA 定向的消息，flowB 的定向插话原样保留
    expect(orch.pendingMessages().map(m => m.id)).toEqual(['fb-stay'])
    // 被清消息通过 onInterjectDropped 暴露（ids + flowKey，供端点推 SSE dropped 状态）
    expect(onInterjectDropped).toHaveBeenCalledTimes(1)
    expect(onInterjectDropped).toHaveBeenCalledWith(['fa-drop'], 'projA|1')

    // flowB 的消息仍可被 flowB 正常 drain
    expect(orch.drainPendingMessages('director', 'projB|2').map(m => m.id)).toEqual(['fb-stay'])
  })

  it('flow 到达 error 终态后同样清空插话队列', async () => {
    const { orchestrator: orch, failFirstAgentRun } = createLightweightOrchestrator()
    orch.enqueueUserMessage({ id: 'drop-2', content: '流程失败前的反馈' })
    failFirstAgentRun(new Error('llm-down'))

    const result = await orch.createChapterWithFlow('project', 1, {
      emit: vi.fn(),
      onCheckpoint: vi.fn(async () => 'approve' as const),
      onProgress: vi.fn(),
    })

    expect(result.status).toBe('error')
    expect(orch.pendingMessages()).toEqual([])
    expect(orch.drainPendingMessages('director')).toEqual([])
  })

  it('同章重启 flow 前清理竞态窗口残留：陈旧插话不被 drain，onInterjectDropped 收到被清 ids', () => {
    const { orchestrator: orch } = createLightweightOrchestrator()
    const onInterjectDropped = vi.fn()
    ;(orch as unknown as { hooks?: unknown }).hooks = { onInterjectDropped }

    // 模拟竞态窗口残留：上一 flow 终态收尾（finalizeInterjectQueue）后、
    // route finally 删任务表前入队的定向消息（flow 已终态，无人再 drain）
    orch.enqueueUserMessage({ id: 'stale-1', content: '上一流程窗口期的反馈', flowKey: 'projA|1' })
    orch.enqueueUserMessage({ id: 'stale-2', content: '上一流程窗口期的定向反馈', flowKey: 'projA|1', targetAgent: 'writer' })
    orch.enqueueUserMessage({ id: 'other-flow', content: '别的 flow 的消息', flowKey: 'projB|2' })
    orch.enqueueUserMessage({ id: 'global-1', content: '全局消息' })

    // create-flow 启动路径调用清理：只清本 flowKey 定向的，不动全局/其他 flow 的
    const cleared = orch.clearStaleInterjectMessages('projA|1')
    expect(cleared).toEqual(['stale-1', 'stale-2'])
    expect(onInterjectDropped).toHaveBeenCalledTimes(1)
    expect(onInterjectDropped).toHaveBeenCalledWith(['stale-1', 'stale-2'], 'projA|1')
    expect(orch.pendingMessages().map(m => m.id)).toEqual(['other-flow', 'global-1'])

    // 重启后的 flow drain 不含陈旧消息（陈旧注入已被阻断）
    expect(orch.drainPendingMessages('director', 'projA|1').map(m => m.id)).toEqual(['global-1'])
    expect(orch.drainPendingMessages('writer', 'projA|1')).toEqual([])

    // 无残留时清理幂等：返回空且不触发 dropped 回调
    onInterjectDropped.mockClear()
    expect(orch.clearStaleInterjectMessages('projA|1')).toEqual([])
    expect(onInterjectDropped).not.toHaveBeenCalled()
  })
})
