/**
 * NovelOrchestrator 调用 Reviser 时的上下文模式护栏测试。
 *
 * 背景：
 *   Reviser 的输入已经自带「原章节正文 + 结构化审稿意见 + 文风身份」，
 *   再把全书大纲、实体档案等章节 shared 上下文塞进去既浪费 token 又会让
 *   Reviser 借机改动剧情。因此 orchestrator 在两处 Reviser 调用点都传了
 *   contextMode: 'editor'（见 novel-orchestrator.ts 第 1162 / 1385 行）。
 *
 *   runAgentOnce 内部据此派生：
 *     editorOnly          = overrides?.contextMode === 'editor'
 *     needsChapterContext = !identityOnly && !editorOnly
 *   当 needsChapterContext 为 false 时：
 *     - systemPrompt  为 ''（不调用 promptBuilder.buildSystemPrompt）
 *     - sharedContext 为 ''（不调用 promptBuilder.buildChapterContextShared）
 *   而 buildAgentIdentity 仍被调用——文风身份得以保留。
 *
 * 测试策略：
 *   完整跑一遍 runAgentOnce 会走到真实 LLM 调用（context.createAgUiSession），
 *   这里把 createAgUiSession mock 成「抛错」，让流程在上下文构建完成、即将发起
 *   LLM 调用时停下。此时 buildSystemPrompt / buildChapterContextShared 是否被
 *   调用已经发生（或未发生），用 vi.spyOn 断言即可。
 *
 *   相比纯函数化的逻辑测试，这种做法直接验证真实 runAgentOnce 的行为分支，
 *   重构提示词构建分层时护栏仍然有效。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type MockInstance } from 'vitest'
import { NovelOrchestrator } from '../core/novel-orchestrator.js'
import { NovelPromptBuilder } from '../core/prompt-builder.js'
import { PromptManager } from '../core/prompt-manager.js'
import { getNovelAskStoryPolicy } from '../core/novel-ask-story-policy.js'
import { createChapterBudgetUsage } from '../core/chapter-budget.js'
import type { NovelAgentType } from '../core/novel-agents.js'
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

describe('NovelOrchestrator Reviser 上下文模式', () => {
  let fx: NovelFixture
  let orchestrator: NovelOrchestrator
  let buildSystemPromptSpy: MockInstance<(...args: any[]) => string>
  let buildChapterContextSharedSpy: MockInstance<(...args: any[]) => string>
  let buildAgentIdentitySpy: MockInstance<(...args: any[]) => string>
  let createAgUiSessionSpy: ReturnType<typeof vi.fn>

  /** 贯穿 runAgentOnce 的 CreationOptions，回调全部用 noop mock。 */
  const options: CreationOptions = {
    emit: vi.fn(),
    onCheckpoint: vi.fn(async () => 'approve'),
    onProgress: vi.fn(),
    onConversationMessage: vi.fn(),
  } as unknown as CreationOptions

  beforeAll(() => {
    fx = createNovelFixture()

    // 真实 promptBuilder：代理到 fixture 的 NovelStore，能跑出真实的 system/shared/identity。
    const promptManager = new PromptManager(fx.db, process.cwd())
    const promptBuilder = new NovelPromptBuilder(
      promptManager,
      createPromptStores(fx.store) as never,
      fx.memoryStore,
    )
    buildSystemPromptSpy = vi.spyOn(promptBuilder, 'buildSystemPrompt')
    buildChapterContextSharedSpy = vi.spyOn(promptBuilder, 'assembleSharedFromChunks')
    buildAgentIdentitySpy = vi.spyOn(promptBuilder, 'buildAgentIdentity')

    // engine 在 runAgentOnce 路径上只会用到 buildChapterConstraints，直接返回 fixture 的稳定值。
    const engine = {
      buildChapterConstraints: () => fx.constraints,
    } as unknown as NovelEngine

    // 静默 logger，避免测试输出噪音；createAgUiSession 抛哨兵错误截停 LLM 调用。
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

    orchestrator = new NovelOrchestrator(
      fx.store,
      fx.memoryStore,
      [], // novelTools：Reviser 的 extraTools 由 overrides 注入，这里给空数组即可
      promptBuilder,
      engine,
      context,
      undefined, // memoryGenerator：本测试不触及 Memory 阶段
    )
  })

  afterAll(() => {
    fx.close()
  })

  beforeEach(() => {
    // 每个用例独立断言调用次数，清空 spy 历史。
    buildSystemPromptSpy.mockClear()
    buildChapterContextSharedSpy.mockClear()
    buildAgentIdentitySpy.mockClear()
    createAgUiSessionSpy.mockClear()
  })

  /**
   * 在 runStorage（AsyncLocalStorage）上下文里直接调用私有 runAgentOnce。
   *
   * 用 runAgentOnce 而非外层 runAgent：runAgent 自带重试退避循环，createAgUiSession
   * 抛错会被判定为可重试错误而反复重试，徒增耗时且干扰调用次数断言。runAgentOnce
   * 才是 contextMode 分支所在的方法，直接测它最精准。
   */
  async function invokeRunAgentOnce(
    agentType: NovelAgentType,
    overrides?: { contextMode?: 'full' | 'editor' | 'identity_only' },
  ): Promise<unknown> {
    // 复刻 createChapterWithFlow 进入 runStorage 时的 CreationRunContext 形态。
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
          overrides?: { contextMode?: 'full' | 'editor' | 'identity_only' },
        ) => Promise<unknown>
      }).runAgentOnce(
        agentType,
        fx.projectId,
        FIXTURE_TARGET_CHAPTER,
        '请根据审稿意见修订本章局部内容。',
        options,
        overrides,
      ),
    )
  }

  // ───────────────────────── Reviser：editor 模式 ─────────────────────────

  it('Reviser 调用 contextMode=editor：不构建全局 system prompt', async () => {
    await expect(invokeRunAgentOnce('reviser', { contextMode: 'editor' })).rejects.toThrow(STOP_ERROR)

    // editor 模式下 needsChapterContext=false，buildSystemPrompt 必须不被调用，
    // 否则 Reviser 会收到世界规则、风格、角色定义等全局上下文。
    expect(buildSystemPromptSpy).not.toHaveBeenCalled()
  })

  it('Reviser 调用 contextMode=editor：不构建章节 shared 上下文（全书大纲、实体档案等）', async () => {
    await expect(invokeRunAgentOnce('reviser', { contextMode: 'editor' })).rejects.toThrow(STOP_ERROR)

    // shared 前缀承载章节信息+约束+故事状态+实体关联+信息差+摘要+因果链，
    // 是 Reviser 不应看到的「完整章节 shared 上下文」。
    expect(buildChapterContextSharedSpy).not.toHaveBeenCalled()
  })

  it('Reviser 调用 contextMode=editor：仍保留 agent 身份提示词（文风身份）', async () => {
    await expect(invokeRunAgentOnce('reviser', { contextMode: 'editor' })).rejects.toThrow(STOP_ERROR)

    // editor 只跳过「全局 system + 章节 shared」，agent 身份（含文风指纹）必须保留，
    // 否则 Reviser 修订后会丢失声音一致性。
    expect(buildAgentIdentitySpy).toHaveBeenCalledWith(fx.projectId, 'reviser')
  })

  it('Reviser 调用 contextMode=editor：确实推进到 LLM 调用前一刻（验证断点位置正确）', async () => {
    // 如果 runAgentOnce 在到达 createAgUiSession 之前就因别的错误停下，
    // 上面的「未调用」断言会变成假阳性。这里确认它走到了 LLM 调用入口。
    await expect(invokeRunAgentOnce('reviser', { contextMode: 'editor' })).rejects.toThrow(STOP_ERROR)
    expect(createAgUiSessionSpy).toHaveBeenCalledTimes(1)
  })

  // ───────────────────────── Writer：full 模式（对照组） ─────────────────────────

  it('Writer 调用 contextMode=full：构建全局 system prompt 与章节 shared 上下文', async () => {
    await expect(invokeRunAgentOnce('writer', { contextMode: 'full' })).rejects.toThrow(STOP_ERROR)

    // full 模式是 Writer 的正常形态：需要完整上下文才能写出贴合大纲与实体的正文。
    expect(buildSystemPromptSpy).toHaveBeenCalledWith(fx.projectId, 'writer')
    expect(buildChapterContextSharedSpy).toHaveBeenCalledTimes(1)
  })

  it('不传 contextMode 时按 full 处理：构建完整上下文（默认行为不回退到 editor）', async () => {
    await expect(invokeRunAgentOnce('writer', undefined)).rejects.toThrow(STOP_ERROR)

    // contextMode 缺省时 editorOnly=false → needsChapterContext=true，走完整上下文路径。
    // 这条护栏确保「只有显式传 editor 才会裁剪上下文」，避免默认值漂移。
    expect(buildSystemPromptSpy).toHaveBeenCalled()
    expect(buildChapterContextSharedSpy).toHaveBeenCalled()
  })
})
