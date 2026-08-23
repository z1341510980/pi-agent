/**
 * P1-3 v1.1 节奏预重构（rhythmPrePass）护栏测试。
 *
 * 背景：ch4 实测——Writer 产出 158 段/41.8% 超短段/95% 完整句台词的快节奏草稿，
 * 碎段率/短段密度/voice_all_complete 三个**分布级** error 让 Reviser 的逐对替换
 * 两轮 0 改善后 blocked。分布级问题必须由 Writer 整体重构节奏，而不是补丁。
 *
 * 守护行为：
 * 1. rhythmPrePass 启用且起点确有形态/声音 error → 第一次调用是 writer（带形态指令），
 *   重构后干净则直接通过，不进 Reviser 轮
 * 2. 预重构后仍有残留 → 继续走正常 Reviser 轮
 * 3. 未启用 rhythmPrePass 时行为不变（第一调用仍是 reviser）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NovelOrchestrator } from '../core/novel-orchestrator.js'
import type { NovelEngine } from '../core/novel-engine.js'
import type { PluginContext } from '../../../core/plugin/plugin-types.js'
import type { CreationOptions } from '../core/chapter-finalizer.js'
import { createNovelFixture, FIXTURE_TARGET_CHAPTER, type NovelFixture } from './fixtures/novel-fixture.js'

/** 干净叙述：单个长段、无对话、段落数低于形态检查下限 */
function cleanNarration(): string {
  const sentences: string[] = []
  for (let i = 1; i <= 40; i += 1) {
    sentences.push(`他走到窗边数到第${i}下，把窗帘拉上，又回到桌前坐好，把灯拧亮了一格。`)
  }
  return sentences.join('')
}

/** 形态不达标正文：30 个连续超短段（短段占比 100%、碎段连跑超限） */
function shortParagraphContent(): string {
  return Array.from({ length: 30 }, (_, i) => `他停下${i}。`).join('\n\n')
}

describe('节奏预重构（rhythmPrePass）', () => {
  let fx: NovelFixture
  let orchestrator: NovelOrchestrator
  let runAgentMock: ReturnType<typeof vi.fn>
  const progressMessages: string[] = []

  const options: CreationOptions = {
    emit: vi.fn(),
    onCheckpoint: vi.fn(async () => 'approve'),
    onProgress: (event: { phase: string; data?: { message?: string } }) => {
      if (event.data?.message) progressMessages.push(event.data.message)
    },
    onConversationMessage: vi.fn(),
  } as unknown as CreationOptions

  beforeAll(() => {
    fx = createNovelFixture()
    const silentLogger = {
      debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, trace: () => {}, fatal: () => {},
      child: () => silentLogger,
    }
    const context = { logger: silentLogger, db: fx.db, subagentManager: undefined, agentCallLogger: undefined } as unknown as PluginContext
    const engine = { buildChapterConstraints: () => fx.constraints } as unknown as NovelEngine
    orchestrator = new NovelOrchestrator(
      fx.store, fx.memoryStore, [], undefined as never, engine, context, undefined,
    )
  })

  afterAll(() => { fx.close() })

  beforeEach(() => {
    progressMessages.length = 0
    // 默认：writer 返回干净长段叙述；reviser 应用一个无效 patch（from=to）
    runAgentMock = vi.fn(async (agentType: string, _p: string, _c: number, _input: string, _o: unknown, overrides?: { extraTools?: Array<{ execute: (id: string, params: { pairs: Array<{ from: string; to: string }> }) => Promise<unknown> }> }) => {
      if (agentType === 'writer') return cleanNarration()
      const tool = overrides?.extraTools?.[0]
      if (tool) await tool.execute('t', { pairs: [{ from: '他停下0。', to: '他停下0。' }] })
      return '已应用修订。'
    })
    vi.spyOn(orchestrator as unknown as { runAgent: typeof runAgentMock }, 'runAgent').mockImplementation(runAgentMock)
  })

  async function invoke(params: { rhythmPrePass?: { details: string } }) {
    return (orchestrator as unknown as {
      runTargetedRevisionLoop: (p: Record<string, unknown>) => Promise<{
        content: string; status: string; rounds: unknown[]; failedItems: unknown[]; styleDiffText?: string
      }>
    }).runTargetedRevisionLoop({
      projectId: fx.projectId,
      chapterNumber: FIXTURE_TARGET_CHAPTER,
      options,
      initialContent: shortParagraphContent(),
      ...(params.rhythmPrePass ? { rhythmPrePass: params.rhythmPrePass } : {}),
      buildRoundPrompt: ({ round }: { round: number }) => `prompt-${round}`,
    })
  }

  it('启用预重构：先 Writer 重构，干净即通过且不进 Reviser 轮', async () => {
    const result = await invoke({ rhythmPrePass: { details: '正文形态：短段密度超标' } })

    expect(result.status).toBe('passed')
    expect(result.rounds).toHaveLength(0)
    expect(runAgentMock).toHaveBeenCalledTimes(1)
    expect(runAgentMock.mock.calls[0][0]).toBe('writer')
    // 指令包含形态重构要求
    expect(String(runAgentMock.mock.calls[0][3])).toContain('重构叙事节奏')
    expect(progressMessages.some((m) => m.includes('节奏级问题'))).toBe(true)
    // 形态指标差异报告已产出
    expect(result.styleDiffText).toContain('修订前后形态指标对比')
  })

  it('未启用预重构：保持原行为，第一调用是 reviser', async () => {
    const result = await invoke({})

    expect(runAgentMock.mock.calls[0][0]).toBe('reviser')
    expect(result.status).toBe('blocked') // 无效 patch + 恒脏短段内容
  })

  it('预重构后仍有残留：继续进入 Reviser 轮处理剩余问题', async () => {
    // writer 重构结果仍然脏（结尾带强制 AI 腔句式）→ 预重构不通过 → 进 reviser
    runAgentMock.mockImplementation(async (agentType: string, _p: string, _c: number, _input: string, _o: unknown, overrides?: { extraTools?: Array<{ execute: (id: string, params: { pairs: Array<{ from: string; to: string }> }) => Promise<unknown> }> }) => {
      if (agentType === 'writer') return `${cleanNarration()}就这样，一切都结束了。`
      const tool = overrides?.extraTools?.[0]
      if (tool) await tool.execute('t', { pairs: [{ from: '就这样，一切都结束了。', to: '他关上门，走廊里的灯熄了。' }] })
      return '已应用修订。'
    })

    const result = await invoke({ rhythmPrePass: { details: '形态' } })

    expect(runAgentMock.mock.calls[0][0]).toBe('writer')
    expect(runAgentMock.mock.calls[1]?.[0]).toBe('reviser')
    expect(result.status).toBe('passed')
  })
})
