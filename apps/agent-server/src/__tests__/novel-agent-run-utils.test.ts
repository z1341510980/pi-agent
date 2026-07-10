import { describe, expect, it } from 'vitest'
import {
  addLlmUsage,
  applySafeRevision,
  extractLlmUsageFromMessage,
} from '../plugins/novel-plugin/core/agent-run-utils.js'

const originalChapter = [
  '叶明远在黑暗里睁着眼，听见木板外的脚步声一点点靠近。工棚里的鼾声此起彼伏，只有他掌心的玉佩还残着一点温热。',
  '门闩被人轻轻拨了一下，他屏住呼吸，把电钻和线缆往怀里一揽。那点灵力像针一样刺进玉佩，怀里的东西忽然没了重量。',
  '门被推开半尺，工头提着油灯往里照。叶明远翻了个身，装作被光刺醒，含糊地骂了一句。工头盯了他片刻，没有发现异样。',
  '等脚步声走远，他才敢把手松开。玉佩贴在掌心，沉得像一块刚从井里捞出来的石头。',
].join('\n\n')

describe('agent-run-utils - safe revision', () => {
  it('拒绝把短修订说明覆盖为章节正文', () => {
    const decision = applySafeRevision(originalChapter, '修订结果：已把工头探查段落改得更紧张，并弱化了解释。')

    expect(decision.accepted).toBe(false)
    expect(decision.mode).toBe('rejected')
    expect(decision.content).toBe(originalChapter)
  })

  it('将原文/修改后格式应用回原章节正文', () => {
    const decision = applySafeRevision(originalChapter, [
      '原文：',
      '门闩被人轻轻拨了一下，他屏住呼吸，把电钻和线缆往怀里一揽。那点灵力像针一样刺进玉佩，怀里的东西忽然没了重量。',
      '',
      '修改后：',
      '门闩被人轻轻拨了一下，他屏住呼吸，把电钻和线缆往怀里一压。那点灵力像针一样刺进玉佩，铁壳和胶皮线在掌心里骤然消失。',
    ].join('\n'))

    expect(decision.accepted).toBe(true)
    expect(decision.mode).toBe('patch')
    expect(decision.content).toContain('铁壳和胶皮线在掌心里骤然消失')
    expect(decision.content).toContain('工头提着油灯往里照')
  })

  it('接受保留大部分原文段落的完整正文', () => {
    const revised = originalChapter.replace('没有发现异样', '只看见一个被吵醒的杂役')
    const decision = applySafeRevision(originalChapter, revised)

    expect(decision.accepted).toBe(true)
    expect(decision.mode).toBe('full')
    expect(decision.content).toContain('只看见一个被吵醒的杂役')
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
