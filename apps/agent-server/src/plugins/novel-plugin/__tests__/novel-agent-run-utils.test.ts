import { describe, expect, it } from 'vitest'
import {
  addLlmUsage,
  extractLlmUsageFromMessage,
  sanitizeNovelProse,
} from '../core/agent-run-utils.js'
import {
  createNovelApplyRevisionTool,
  type RevisionDraftHolder,
} from '../core/novel-tools.js'

const originalChapter = [
  '叶明远在黑暗里睁着眼，听见木板外的脚步声一点点靠近。工棚里的鼾声此起彼伏，只有他掌心的玉佩还残着一点温热。',
  '门闩被人轻轻拨了一下，他屏住呼吸，把电钻和线缆往怀里一揽。那点灵力像针一样刺进玉佩，怀里的东西忽然没了重量。',
  '门被推开半尺，工头提着油灯往里照。叶明远翻了个身，装作被光刺醒，含糊地骂了一句。工头盯了他片刻，没有发现异样。',
  '等脚步声走远，他才敢把手松开。玉佩贴在掌心，沉得像一块刚从井里捞出来的石头。',
].join('\n\n')

describe('agent-run-utils - novel_apply_revision tool', () => {
  it('通过工具应用精确字符串替换', async () => {
    // 工具化方案：Reviser 调用 novel_apply_revision 工具，传入 from/to 配对。
    // 工具内部用 String.replace 做精确替换，完全绕开正则解析自然语言。
    const draft: RevisionDraftHolder = { content: originalChapter, appliedPatches: [] }
    const tool = createNovelApplyRevisionTool(draft)

    const result = await tool.execute('test-call-id', {
      pairs: [
        {
          from: '门闩被人轻轻拨了一下，他屏住呼吸，把电钻和线缆往怀里一揽。',
          to: '门闩被人轻轻拨了一下，他屏住呼吸，把电钻和线缆往怀里一压。',
        },
      ],
    }, undefined, undefined, undefined as never)

    expect(draft.content).toContain('往怀里一压')
    expect(draft.content).not.toContain('往怀里一揽')
    expect(draft.appliedPatches).toHaveLength(1)
    expect(draft.appliedPatches[0]!.success).toBe(true)
    expect(result.content[0]!.type).toBe('text')
    expect((result.content[0] as { text: string }).text).toContain('已应用 1/1')
  })

  it('工具返回未定位的 patch 失败信息', async () => {
    // 当 Reviser 复制的原文片段不精确（标点/换行不符）时，工具会返回失败，
    // 不会修改 draft，orchestrator 据此告知用户"修订未生效"。
    const draft: RevisionDraftHolder = { content: originalChapter, appliedPatches: [] }
    const tool = createNovelApplyRevisionTool(draft)

    const result = await tool.execute('test-call-id', {
      pairs: [
        {
          from: '这段文字不在原章节中',
          to: '替换文字',
        },
      ],
    }, undefined, undefined, undefined as never)

    expect(draft.content).toBe(originalChapter)
    expect(draft.appliedPatches).toHaveLength(1)
    expect(draft.appliedPatches[0]!.success).toBe(false)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('已应用 0/1')
    expect(text).toContain('原文片段未在章节中找到')
  })

  it('支持多次调用累积修改', async () => {
    // Reviser 可多次调用工具，每次调用在上一次的结果上继续修改。
    // 工具通过闭包持有 draft，状态在多次调用间保持。
    const draft: RevisionDraftHolder = { content: originalChapter, appliedPatches: [] }
    const tool = createNovelApplyRevisionTool(draft)

    await tool.execute('call-1', {
      pairs: [
        { from: '没有发现异样', to: '只看见一个被吵醒的杂役' },
      ],
    }, undefined, undefined, undefined as never)
    await tool.execute('call-2', {
      pairs: [
        { from: '工头盯了他片刻', to: '工头盯着他看了半晌' },
      ],
    }, undefined, undefined, undefined as never)

    expect(draft.content).toContain('只看见一个被吵醒的杂役')
    expect(draft.content).toContain('工头盯着他看了半晌')
    expect(draft.appliedPatches).toHaveLength(2)
    expect(draft.appliedPatches.every(p => p.success)).toBe(true)
  })
})

describe('agent-run-utils - usage', () => {
  it('兼容 Pi SDK usage 字段', () => {
    const usage = extractLlmUsageFromMessage({
      role: 'assistant',
      provider: 'p1',
      model: 'm1',
      usage: {
        input: 100,
        output: 20,
        cacheRead: 80,
        cacheWrite: 10,
      },
    })

    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
      llmProvider: 'p1',
      llmModel: 'm1',
    })
  })

  it('兼容 snake_case usage 字段并可累加', () => {
    const usage = extractLlmUsageFromMessage({
      role: 'assistant',
      provider: 'p2',
      model: 'm2',
      usage: {
        input_tokens: 30,
        output_tokens: 5,
        cache_read_tokens: 70,
        cache_write_tokens: 0,
      },
    })

    expect(addLlmUsage({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, llmProvider: 'old', llmModel: 'old' }, usage!)).toEqual({
      inputTokens: 40,
      outputTokens: 6,
      cacheReadTokens: 72,
      cacheWriteTokens: 3,
      llmProvider: 'p2',
      llmModel: 'm2',
    })
  })
})

describe('agent-run-utils - prose sanitization', () => {
  it('按语境清理双破折号、单破折号和短横线', () => {
    expect(sanitizeNovelProse('他推开门——门外站着一个人。')).toBe('他推开门。门外站着一个人。')
    expect(sanitizeNovelProse('“我本来想—”')).toBe('“我本来想……”')
    expect(sanitizeNovelProse('刀–剑–枪')).toBe('刀，剑，枪')
  })

  it('保留普通连字符', () => {
    expect(sanitizeNovelProse('版本 v1-2 与 A-B 组')).toBe('版本 v1-2 与 A-B 组')
  })
})
