import { describe, expect, it } from 'vitest'
import { evaluateProseQuality, formatProseQualityReport } from '../plugins/novel-plugin/core/prose-quality-evaluator.js'

describe('prose quality evaluator', () => {
  it('识别连续单句碎段和短段密度', () => {
    const content = Array.from({ length: 30 }, (_, index) => `他停下了${index}。`).join('\n\n')
    const report = evaluateProseQuality(content)

    expect(report.metrics.singleSentenceParagraphs).toBe(30)
    expect(report.metrics.maxConsecutiveSingleSentenceParagraphs).toBe(30)
    expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'fragmented_paragraphs',
      'short_paragraph_density',
    ]))
    expect(report.score).toBeLessThan(80)
  })

  it('识别解释腔、对称句式和元说明', () => {
    const report = evaluateProseQuality([
      '先核对前文，再创作第 10 章正文。',
      '这不是风险，而是变量。这意味着结论已经改变。',
      '并非他不肯说，而是逻辑很清楚。换句话说，他们没有选择。',
      '不在于门是否打开，而在于谁先进去。由此可见，答案已经出现。',
    ].join('\n\n'))

    expect(report.metrics.patternCounts.metaWriting).toBeGreaterThan(0)
    expect(report.metrics.patternCounts.binaryContrast).toBe(3)
    expect(report.metrics.patternCounts.explanatoryTone).toBeGreaterThanOrEqual(3)
    expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'meta_writing',
      'binary_contrast',
      'explanatory_tone',
    ]))
  })

  it('输出给 Reviewer 的短报告，不把指标当成自动验收结论', () => {
    const report = formatProseQualityReport(evaluateProseQuality('他推开门。\n\n屋里没人，桌上的茶还热着。'))
    expect(report).toContain('需结合文风档案复核')
    expect(report).toContain('不等于文学质量自动通过')
  })
})
