/**
 * Writer 重写策略
 *
 * 此前 Guard 命中一律让 Writer 从零重写整章，只传一个 reason 字符串。
 * 实测 ch9 重写 10 次、ch10 重写 13 次，每次重新吃 19k input ——
 * 那两章烧掉 46 万 / 126 万输入 token 的主要来源之一。
 *
 * 用例的重点是那条**最容易做错**的判断：上一稿可不可用。
 * 把退化输出（复读/截断/只有计划没正文）当"上一稿"喂回去，
 * 模型会顺着那段垃圾继续复读，比全量重写更糟。
 */
import { describe, it, expect } from 'vitest'
import {
  buildWriterRewritePlan,
  isDraftUnusable,
  PREVIOUS_DRAFT_CHAR_LIMIT,
} from '../core/chapters/writer-rewrite-plan.js'

const DRAFT = '第一段正文。\n\n第二段正文。'

function plan(
  reason: string,
  overrides: Partial<Parameters<typeof buildWriterRewritePlan>[0]> = {},
): ReturnType<typeof buildWriterRewritePlan> {
  return buildWriterRewritePlan({
    chapterNumber: 10,
    reason,
    previousDraft: DRAFT,
    attempt: 1,
    maxAttempts: 2,
    ...overrides,
  })
}

describe('isDraftUnusable：上一稿可用性', () => {
  it('模型未输出正文 → 不可用', () => {
    expect(isDraftUnusable('模型未输出正文')).toBe(true)
  })

  it('模型退化检测命中 → 不可用', () => {
    expect(isDraftUnusable('模型退化检测命中')).toBe(true)
  })

  it('字数问题 → 上一稿是有效正文，可用', () => {
    expect(isDraftUnusable('字数严重不足')).toBe(false)
    expect(isDraftUnusable('字数严重超标')).toBe(false)
  })

  it('矩阵编排缺失 → 可用', () => {
    expect(isDraftUnusable('未完整执行矩阵编排')).toBe(false)
  })

  it('未知原因保守视为可用（定向修改的代价低于全量重写）', () => {
    expect(isDraftUnusable('某个新增的 Guard 原因')).toBe(false)
  })
})

describe('全量重写：上一稿不可用时绝不带回去', () => {
  it('模型退化时不把上一稿塞进 prompt —— 否则模型顺着垃圾继续复读', () => {
    const result = plan('模型退化检测命中', { previousDraft: '重复重复重复重复' })

    expect(result.strategy).toBe('full')
    expect(result.input).not.toContain('重复重复重复重复')
    expect(result.input).toContain('上一稿不作为参考')
  })

  it('模型未输出正文时同样全量重写', () => {
    const result = plan('模型未输出正文', { previousDraft: '我先核对一下章纲……' })

    expect(result.strategy).toBe('full')
    expect(result.input).not.toContain('我先核对一下章纲')
  })

  it('上一稿为空时降级为全量重写', () => {
    expect(plan('字数严重不足', { previousDraft: '' }).strategy).toBe('full')
    expect(plan('字数严重不足', { previousDraft: '   \n  ' }).strategy).toBe('full')
  })

  it('全量重写仍要求沿用已批准的叙事任务，不重新规划', () => {
    const result = plan('模型退化检测命中')
    expect(result.input).toContain('沿用已批准的本章叙事任务')
    expect(result.input).toContain('不要重新规划或推回 Director')
  })
})

describe('定向修改：带上一稿 + 按原因给具体指令', () => {
  it('字数不足 → 只扩写，明确禁止改写已有内容', () => {
    const result = plan('字数严重不足', { details: '实际 1200 字，目标 3000 字' })

    expect(result.strategy).toBe('targeted')
    expect(result.input).toContain(DRAFT)
    expect(result.input).toContain('只做扩写')
    expect(result.input).toContain('保留上一稿的情节走向')
    // 关键：不能靠新增情节凑字数，那等于改写
    expect(result.input).toContain('不要新增情节事件')
    expect(result.input).toContain('实际 1200 字，目标 3000 字')
  })

  it('字数超标 → 只压缩，且不能删掉已推进的冲突/伏笔', () => {
    const result = plan('字数严重超标')

    expect(result.input).toContain('只做压缩')
    expect(result.input).toContain('不要删掉任何已经推进的冲突或已埋设的伏笔')
  })

  it('矩阵编排缺失 → 补入参与，且说明"提到名字不算参与"', () => {
    const result = plan('未完整执行矩阵编排', { details: '正文未出现矩阵角色：林霜' })

    expect(result.input).toContain('林霜')
    expect(result.input).toContain('只是提到名字不算参与')
    expect(result.input).toContain('保留其余段落原样')
  })

  it('未知原因回落到通用定向指令，仍不退化成全量重写', () => {
    const result = plan('某个新增的 Guard 原因')

    expect(result.strategy).toBe('targeted')
    expect(result.input).toContain(DRAFT)
    expect(result.input).toContain('不要重写整章')
  })

  it('要求输出完整正文 —— 只输出差异会让 orchestrator 拿不到可入库的内容', () => {
    const result = plan('字数严重不足')
    expect(result.input).toContain('完整')
    expect(result.input).toContain('不要输出差异说明')
  })
})

describe('定向修改：超长上一稿截断', () => {
  it('未超限时原样带入', () => {
    const result = plan('字数严重超标', { previousDraft: 'x'.repeat(1000) })
    expect(result.input).not.toContain('中间部分略')
  })

  it('超限时保留首尾、省略中间（首尾承接最关键）', () => {
    const long = 'A'.repeat(PREVIOUS_DRAFT_CHAR_LIMIT) + 'B'.repeat(5000)
    const result = plan('字数严重超标', { previousDraft: long })

    expect(result.input).toContain('中间部分略')
    expect(result.input).toContain('保持原样不要改动')
    // 尾部必须保留：下一章开头要承接这里
    expect(result.input).toContain('B'.repeat(100))
  })

  it('截断后 prompt 不会超过上限太多', () => {
    const long = 'A'.repeat(100_000)
    const result = plan('字数严重超标', { previousDraft: long })
    // 指令部分本身很短，总长应接近截断上限
    expect(result.input.length).toBeLessThan(PREVIOUS_DRAFT_CHAR_LIMIT + 2000)
  })
})

describe('summary：供进度展示与日志', () => {
  it('标明策略与重写进度', () => {
    expect(plan('字数严重不足', { attempt: 2, maxAttempts: 2 }).summary)
      .toBe('定向修改（第 2/2 次重写）：字数严重不足')
  })

  it('全量重写的 summary 明确区分', () => {
    expect(plan('模型退化检测命中').summary).toContain('全量重写')
  })
})
