/**
 * 实体生成器 Skill 白名单路径测试（GPT 建议的能力拆分落地）：
 * - 编排（source='outline'）走 novel-matrix-arranger Skill；
 * - 反推（source='content'）走 novel-entity-extractor Skill；
 * - SQLite 覆盖模板时回退旧身份路径。
 *
 * 测试策略：真实 PromptManager + NovelPromptBuilder + fixture NovelStore，
 * mock context.createSession 捕获参数并返回内存 session，让
 * planEntitiesFromOutline 走完「构建提示词 → 创建会话 → 解析 JSON」链路。
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NovelEntityGenerator } from '../core/generation/novel-entity-generator.js'
import { NovelPromptBuilder } from '../core/prompt-builder.js'
import { PromptManager } from '../core/prompting/prompt-manager.js'
import type { PluginContext } from '../../../core/plugin/plugin-types.js'
import {
  createNovelFixture,
  createPromptStores,
  FIXTURE_TARGET_CHAPTER,
  type NovelFixture,
} from './fixtures/novel-fixture.js'

const EMPTY_PLAN_JSON = '{"characters":[],"conflicts":[],"foreshadows":[],"factions":[],"locations":[],"items":[]}'

describe('NovelEntityGenerator Skill 白名单路径（能力拆分）', () => {
  let fx: NovelFixture
  let promptManager: PromptManager
  let createSessionSpy: ReturnType<typeof vi.fn>

  beforeAll(() => {
    fx = createNovelFixture()
    promptManager = new PromptManager(fx.db, process.cwd())
  })

  afterAll(() => fx.close())

  beforeEach(() => {
    createSessionSpy = vi.fn(async () => ({
      sessionId: 'arrange-session',
      promptStream: async () => EMPTY_PLAN_JSON,
      subscribe: () => () => {},
      dispose: vi.fn(),
    }))
  })

  function makeGenerator(): NovelEntityGenerator {
    const promptBuilder = new NovelPromptBuilder(
      promptManager,
      createPromptStores(fx.store) as never,
      fx.memoryStore,
    )
    const context = {
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, trace: () => {}, fatal: () => {}, child: () => context.logger },
      createSession: createSessionSpy,
    } as unknown as PluginContext
    return new NovelEntityGenerator(
      promptBuilder,
      promptManager,
      context,
      {} as never,
      fx.store,
      fx.memoryStore,
    )
  }

  function sessionOptions(): {
    skill?: { name: string; path: string }
    userMessage: string
    responseFormat: string
  } {
    return createSessionSpy.mock.calls[0][0] as never
  }

  it('编排（outline）透传 novel-matrix-arranger Skill', async () => {
    const result = await (makeGenerator() as unknown as {
      planEntitiesFromOutline: (
        projectId: string, chapterNumber: number, outline: string,
        onProgress?: never, source?: 'outline' | 'content', signal?: never,
      ) => Promise<{ plan: unknown; logContext: { status: string } }>
    }).planEntitiesFromOutline(
      fx.projectId, FIXTURE_TARGET_CHAPTER, '主角进入旧城区，遇见线人。', undefined, 'outline', undefined,
    )

    expect(result.logContext.status).toBe('success')
    const opts = sessionOptions()
    expect(opts.skill).toEqual({
      name: 'novel-matrix-arranger',
      path: expect.stringMatching(/role-matrix-arranger\.md$/),
    })
    expect(opts.responseFormat).toBe('json')
    expect(opts.userMessage).toContain('novel-matrix-arranger Skill')
    // 角色方法正文由 /skill: 展开提供，不重复嵌入任务消息
    expect(opts.userMessage).not.toContain('## 规划原则')
  })

  it('反推（content）透传 novel-entity-extractor Skill', async () => {
    const result = await (makeGenerator() as unknown as {
      planEntitiesFromOutline: (
        projectId: string, chapterNumber: number, outline: string,
        onProgress?: never, source?: 'outline' | 'content', signal?: never,
      ) => Promise<{ plan: unknown; logContext: { status: string } }>
    }).planEntitiesFromOutline(
      fx.projectId, FIXTURE_TARGET_CHAPTER, '正文：主角与线人在旧城区接头。', undefined, 'content', undefined,
    )

    expect(result.logContext.status).toBe('success')
    const opts = sessionOptions()
    expect(opts.skill).toEqual({
      name: 'novel-entity-extractor',
      path: expect.stringMatching(/role-entity-extractor\.md$/),
    })
    expect(opts.userMessage).toContain('novel-entity-extractor Skill')
  })

  it('SQLite 覆盖 role-matrix-arranger 时回退旧身份，不绕过用户配置', async () => {
    promptManager.saveTemplate('role-matrix-arranger', '用户自定义编排模板', fx.projectId)
    try {
      await (makeGenerator() as unknown as {
        planEntitiesFromOutline: (
          projectId: string, chapterNumber: number, outline: string,
          onProgress?: never, source?: 'outline' | 'content', signal?: never,
        ) => Promise<{ logContext: { status: string } }>
      }).planEntitiesFromOutline(
        fx.projectId, FIXTURE_TARGET_CHAPTER, '主角进入旧城区。', undefined, 'outline', undefined,
      )

      const opts = sessionOptions()
      expect(opts.skill).toBeUndefined()
      expect(opts.userMessage).toContain('用户自定义编排模板')
    } finally {
      fx.db.prepare('DELETE FROM novel_prompt_templates WHERE name = ?').run('role-matrix-arranger')
      promptManager.clearCache()
    }
  })
})
