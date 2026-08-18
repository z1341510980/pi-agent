/**
 * NovelOrchestrator Skill 白名单路径护栏测试（Writer / Reviser 迁移）。
 *
 * 背景：
 *   Reviewer 试点已验证「plugin:* 会话 noSkills=true + additionalSkillPaths 定向
 *   加载 + /skill:<name> 展开」通道，Director 已迁移。本测试钉死 Writer / Reviser
 *   迁移的关键分支：
 *   - 标准工作流 Writer（full）通过 novel-writer Skill 提供角色方法，identity 只保留
 *     system-base + 铁律 + 文风的薄身份壳（不重复嵌入 role-writer 正文）；
 *   - Reviser（editor 是其标准路径）通过 novel-reviser Skill 提供角色方法；
 *   - Reviewer 在 editor 模式（ask_story 开启时的标准路径）同样走 Skill；
 *   - Memory 工具循环回退路径通过 novel-memory Skill 提供角色方法；
 *   - identity_only 盲审保持旧模板路径；
 *   - SQLite 覆盖 role-writer 模板时自动回退旧路径，不绕过用户配置。
 *
 * 测试策略与 novel-orchestrator-reviser-context.test.ts 相同：
 *   createAgUiSession mock 成「抛哨兵错误」，让 runAgentOnce 在上下文构建完成、
 *   即将发起 LLM 调用时停下，然后断言 createAgUiSession 收到的参数与
 *   buildAgentIdentity 等方法的调用情况。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type MockInstance } from 'vitest'
import { NovelOrchestrator } from '../core/novel-orchestrator.js'
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

interface InvokeOverrides {
  contextMode?: 'full' | 'identity_only' | 'editor'
}

describe('NovelOrchestrator Skill 白名单路径（Writer / Reviser 迁移）', () => {
  let fx: NovelFixture
  let orchestrator: NovelOrchestrator
  let promptBuilder: NovelPromptBuilder
  let promptManager: PromptManager
  let buildAgentIdentitySpy: MockInstance<(...args: any[]) => string>
  let createAgUiSessionSpy: ReturnType<typeof vi.fn>

  const options: CreationOptions = {
    emit: vi.fn(),
    onCheckpoint: vi.fn(async () => 'approve'),
    onProgress: vi.fn(),
    onConversationMessage: vi.fn(),
  } as unknown as CreationOptions

  beforeAll(() => {
    fx = createNovelFixture()

    promptManager = new PromptManager(fx.db, process.cwd())
    promptBuilder = new NovelPromptBuilder(
      promptManager,
      createPromptStores(fx.store) as never,
      fx.memoryStore,
    )
    buildAgentIdentitySpy = vi.spyOn(promptBuilder, 'buildAgentIdentity')

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

    orchestrator = new NovelOrchestrator(
      fx.store,
      fx.memoryStore,
      [],
      promptBuilder,
      engine,
      context,
      undefined,
    )
  })

  afterAll(() => {
    fx.close()
  })

  beforeEach(() => {
    buildAgentIdentitySpy.mockClear()
    createAgUiSessionSpy.mockClear()
  })

  it('统一创作入口暴露 novel-creation Skill 路径和薄身份契约', () => {
    expect(promptBuilder.getNovelCreationSkillPath(fx.projectId)).toEqual(
      expect.stringMatching(/novel-creation\.md$/),
    )
    expect(promptBuilder.buildNovelCreationSkillIdentity(fx.projectId)).toContain(
      'novel-creation Skill',
    )
  })

  async function invokeRunAgentOnce(
    agentType: NovelAgentType,
    overrides?: InvokeOverrides,
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
          overrides?: InvokeOverrides,
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
    return createAgUiSessionSpy.mock.calls[0][0] as Record<string, unknown>
  }

  // ───────────────────────── 标准工作流 Director：Skill 路径 ─────────────────────────

  it('标准 Director 透传 novel-director Skill，identity 不重复嵌入角色正文', async () => {
    await expect(invokeRunAgentOnce('director')).rejects.toThrow(STOP_ERROR)

    const arg = sessionArg()
    expect(arg.skill).toEqual({
      name: 'novel-director',
      path: expect.stringMatching(/role-director\.md$/),
    })
    // Skill 路径不调用旧模板身份组装，避免同一套规划规则注入两次
    expect(buildAgentIdentitySpy).not.toHaveBeenCalled()

    // 薄身份壳：指向 Skill，不包含 role-director 正文
    const prefix = arg.prefixUserMessage as string[]
    expect(prefix[1]).toContain('novel-director Skill')
    expect(prefix[1]).not.toContain('判断章节任务和剧情阶段')
    expect(prefix[1]).not.toContain('novel_submit_narrative_task')
  })

  it('标准 Director 写入缓存遥测字段', async () => {
    // 哨兵错误在 LLM 调用前中断，但 finally 仍会同步写 insertAgentLog → 可捕获入参
    const insertLogSpy = vi.spyOn(fx.store, 'insertAgentLog')
    try {
      await expect(invokeRunAgentOnce('director')).rejects.toThrow(STOP_ERROR)

      expect(insertLogSpy).toHaveBeenCalledTimes(1)
      const record = insertLogSpy.mock.calls[0][0] as Record<string, unknown>
      // 缓存域与 createAgUiSession 的 promptCacheScope 同源：novel:${projectId}:${chapterNumber}
      expect(record.cacheKey).toBe(`novel:${fx.projectId}:${FIXTURE_TARGET_CHAPTER}`)
      // 哨兵路径在 LLM 调用前中断，usage 为空 → provider/model 均为空串 → 协议不可判定。
      // （automatic-prefix 需要 provider/model/baseUrl 至少一项非空才可判）
      expect(record.cacheProtocol).toBe('unknown')
      expect(record.requestFingerprint).toMatch(/^[0-9a-f]{16}$/)
      // 可缓存前缀 = system + shared + identity；Director 标准路径三段均非空
      expect(record.cacheablePrefixChars).toBeGreaterThan(0)
      expect(['complete', 'partial', 'no_data']).toContain(record.dataQuality)
      // 哨兵错误不属于任何已知类别 → llm-error-policy 归一化为 'unknown'
      expect(record.errorCode).toBe('unknown')
    } finally {
      insertLogSpy.mockRestore()
    }
  })

  it('标准 Reviewer 仍走 novel-reviewer Skill（试点回归）', async () => {
    await expect(invokeRunAgentOnce('reviewer')).rejects.toThrow(STOP_ERROR)

    const arg = sessionArg()
    expect(arg.skill).toEqual({
      name: 'novel-reviewer',
      path: expect.stringMatching(/role-reviewer\.md$/),
    })
    expect(buildAgentIdentitySpy).not.toHaveBeenCalled()

    const prefix = arg.prefixUserMessage as string[]
    expect(prefix[1]).toContain('novel-reviewer Skill')
    expect(prefix[1]).not.toContain('检查正文是否成立')
  })

  // ───────────────────────── Writer / Reviser：Skill 路径 ─────────────────────────

  it('标准 Writer 透传 novel-writer Skill，identity 保留铁律与文风壳', async () => {
    await expect(invokeRunAgentOnce('writer')).rejects.toThrow(STOP_ERROR)

    const arg = sessionArg()
    expect(arg.skill).toEqual({
      name: 'novel-writer',
      path: expect.stringMatching(/role-writer\.md$/),
    })
    expect(buildAgentIdentitySpy).not.toHaveBeenCalled()

    const prefix = arg.prefixUserMessage as string[]
    expect(prefix[1]).toContain('novel-writer Skill')
    expect(prefix[1]).not.toContain('负责正文生成')
    // 薄身份壳仍保留铁律（破折号底线是 Writer 正文形态硬约束）
    expect(prefix[1]).toContain('正文底线')
  })

  it('Reviser（editor 标准路径）透传 novel-reviser Skill', async () => {
    await expect(invokeRunAgentOnce('reviser', { contextMode: 'editor' })).rejects.toThrow(STOP_ERROR)

    const arg = sessionArg()
    expect(arg.skill).toEqual({
      name: 'novel-reviser',
      path: expect.stringMatching(/role-reviser\.md$/),
    })
    expect(buildAgentIdentitySpy).not.toHaveBeenCalled()

    // editor 模式 shared 为空，identity 是第一条 prefix
    const prefix = arg.prefixUserMessage as string[]
    expect(prefix[0]).toContain('novel-reviser Skill')
    expect(prefix[0]).not.toContain('负责局部修订')
  })

  it('Reviewer 在 editor 模式（ask_story 标准路径）同样走 novel-reviewer Skill', async () => {
    await expect(invokeRunAgentOnce('reviewer', { contextMode: 'editor' })).rejects.toThrow(STOP_ERROR)

    const arg = sessionArg()
    expect(arg.skill).toEqual({
      name: 'novel-reviewer',
      path: expect.stringMatching(/role-reviewer\.md$/),
    })
    expect(buildAgentIdentitySpy).not.toHaveBeenCalled()
  })

  // ───────────────────────── 收敛边界：盲审 / 覆盖回退 / 未迁移角色 ─────────────────────────

  it('identity_only Director 不走 Skill 路径', async () => {
    await expect(invokeRunAgentOnce('director', { contextMode: 'identity_only' })).rejects.toThrow(STOP_ERROR)

    expect(sessionArg().skill).toBeUndefined()
    expect(buildAgentIdentitySpy).toHaveBeenCalledWith(fx.projectId, 'director', false, undefined)
  })

  it('SQLite 覆盖 role-writer 时回退旧模板，不绕过用户配置', async () => {
    promptManager.saveTemplate('role-writer', '用户自定义 Writer 模板', fx.projectId)
    try {
      await expect(invokeRunAgentOnce('writer')).rejects.toThrow(STOP_ERROR)

      expect(sessionArg().skill).toBeUndefined()
      expect(buildAgentIdentitySpy).toHaveBeenCalledWith(fx.projectId, 'writer', false, undefined)

      const prefix = sessionArg().prefixUserMessage as string[]
      expect(prefix[1]).toContain('用户自定义 Writer 模板')
    } finally {
      fx.db.prepare('DELETE FROM novel_prompt_templates WHERE name = ?').run('role-writer')
    }
  })

  it('Memory 工具循环回退路径透传 novel-memory Skill', async () => {
    await expect(invokeRunAgentOnce('memory')).rejects.toThrow(STOP_ERROR)

    const arg = sessionArg()
    expect(arg.skill).toEqual({
      name: 'novel-memory',
      path: expect.stringMatching(/role-memory\.md$/),
    })
    expect(buildAgentIdentitySpy).not.toHaveBeenCalled()

    const prefix = arg.prefixUserMessage as string[]
    expect(prefix[1]).toContain('novel-memory Skill')
    expect(prefix[1]).not.toContain('沉淀新状态')
  })
})
