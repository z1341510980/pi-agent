/**
 * Golden prompt 快照：重构护栏。
 *
 * 这些快照锁定「当前实际发给 LLM 的四段文本」全文：
 *   system / prefix[0]=shared / prefix[1]=identity / prefix[2]=suffix
 *
 * 重构 prompt-builder 的结构时（拆 section、抽 ContextComposer、改预算表的组织方式），
 * 快照 diff 必须为空。只有刻意的行为变更才允许 `-u` 更新快照，且必须在 PR 里逐条说明
 * 「哪一段为什么变了」。
 *
 * ⚠️ 不要往这里加断言逻辑。断言属于行为测试，这里只负责"字节级不变"。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NovelPromptBuilder } from '../core/prompt-builder.js'
import { PromptManager } from '../core/prompting/prompt-manager.js'
import {
  createNovelFixture,
  createPromptStores,
  FIXTURE_TARGET_CHAPTER,
  type NovelFixture,
} from './fixtures/novel-fixture.js'

describe('Golden prompt 快照', () => {
  let fx: NovelFixture
  let builder: NovelPromptBuilder

  beforeAll(() => {
    fx = createNovelFixture()
    const promptManager = new PromptManager(fx.db, process.cwd())
    builder = new NovelPromptBuilder(
      promptManager,
      createPromptStores(fx.store) as never,
      fx.memoryStore,
    )
  })

  afterAll(() => {
    fx.close()
  })

  /**
   * 文风档案标识是 profile.id（randomUUID）参与计算的 sha256 前缀，每次建 fixture 都变。
   * 它不承载语义，只用于缓存失效判断，快照里替换成占位符。
   */
  function scrub(text: string): string {
    return text.replace(/文风档案标识：[0-9a-f]+/g, '文风档案标识：«hash»')
  }

  // ── system 层（跨 Agent 共享，缓存命中率最高的一段）──
  it('system prompt', () => {
    expect(scrub(builder.buildSystemPrompt(fx.projectId, 'writer'))).toMatchSnapshot()
  })

  // ── prefix[1] identity 层（同 Agent 重试复用）──
  for (const agentType of ['director', 'writer', 'reviewer', 'reviser', 'memory'] as const) {
    it(`agent identity: ${agentType}`, () => {
      expect(scrub(builder.buildAgentIdentity(fx.projectId, agentType))).toMatchSnapshot()
    })
  }

  it('agent identity: writer（群聊模式）', () => {
    expect(scrub(builder.buildAgentIdentity(fx.projectId, 'writer', true))).toMatchSnapshot()
  })

  // ── prefix[0] shared 层（单章跨 Agent 复用，13 个 section 的组装结果）──
  it('chapter context shared：带完整编排实体', () => {
    expect(scrub(builder.buildChapterContextShared(
      fx.projectId,
      FIXTURE_TARGET_CHAPTER,
      fx.narrativeTask,
      fx.constraints,
      fx.arrangedEntities,
    ))).toMatchSnapshot()
  })

  it('chapter context shared：无编排实体（走 formatStoryState 兜底分支）', () => {
    expect(scrub(builder.buildChapterContextShared(
      fx.projectId,
      FIXTURE_TARGET_CHAPTER,
      fx.narrativeTask,
      fx.constraints,
    ))).toMatchSnapshot()
  })

  it('chapter context shared：第 1 章（无前置章节，指纹/摘要/锚点均缺省）', () => {
    expect(scrub(builder.buildChapterContextShared(
      fx.projectId,
      1,
      fx.narrativeTask,
      fx.constraints,
      fx.arrangedEntities,
    ))).toMatchSnapshot()
  })

  it('chapter context diff 模式（context-preview 用）', () => {
    expect(scrub(builder.buildChapterContextShared(
      fx.projectId,
      FIXTURE_TARGET_CHAPTER,
      fx.narrativeTask,
      fx.constraints,
      fx.arrangedEntities,
      { mode: 'diff' },
    ))).toMatchSnapshot()
  })

  // ── prefix[2] suffix 层（Agent 专属，易变，放最后以保护前两层缓存）──
  for (const agentType of ['director', 'writer', 'reviewer', 'reviser'] as const) {
    it(`chapter context suffix: ${agentType}`, () => {
      expect(scrub(builder.buildChapterContextSuffix(
        fx.projectId,
        FIXTURE_TARGET_CHAPTER,
        fx.narrativeTask,
        fx.constraints,
        fx.arrangedEntities,
        agentType,
      ))).toMatchSnapshot()
    })
  }
})
