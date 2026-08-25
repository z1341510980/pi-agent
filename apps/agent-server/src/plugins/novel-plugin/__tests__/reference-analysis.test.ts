import { describe, expect, it } from 'vitest'
import {
  analyzeReferenceText,
  buildReferenceLocalChunkPlan,
  buildReferenceQualityReport,
  detectAndDecodeReferenceText,
  detectReferenceSections,
  normalizeReferenceText,
  sampleSectionIdsEvenly,
  sha256
} from '../core/analysis/reference-analysis.js'

const SAMPLE = `第一章 雨夜

“你听见了吗？”他望向昏暗的窗外，掌心全是冷汗。

雨声很响。雨声很响。雨声很响。

第二章 清晨

我闻到潮湿的气味，天已经亮了。

她说：“该走了。”`

describe('参考文本编码与结构识别', () => {
  it('识别 UTF-8 BOM，并执行稳定的换行/控制字符清洗', () => {
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode('第一章\r\n正文\u0000')
    ])
    const decoded = detectAndDecodeReferenceText(bytes)
    const normalized = normalizeReferenceText(decoded.text)

    expect(decoded.encoding).toBe('utf-8-bom')
    expect(decoded.confidence).toBe(1)
    expect(normalized.text).toBe('第一章\n正文')
    expect(normalized.controlCharacterCount).toBe(1)
  })

  it('把合法双字节中文预检为 GBK', () => {
    // "第一章 测试" 的 GBK 字节。
    const bytes = new Uint8Array([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x20, 0xb2, 0xe2, 0xca, 0xd4])
    const decoded = detectAndDecodeReferenceText(bytes)

    expect(decoded.encoding).toBe('gbk')
    expect(decoded.text).toBe('第一章 测试')
  })

  it('通过四字节序列区分 GB18030 与 GBK', () => {
    const decoded = detectAndDecodeReferenceText(new Uint8Array([0x94, 0x39, 0xfc, 0x36]))

    expect(decoded.encoding).toBe('gb18030')
    expect(decoded.text).toBe('😀')
  })

  it('识别中文章节并在无标题时返回低置信度单章契约', () => {
    const detected = detectReferenceSections(SAMPLE, 'source-1')
    const markdown = detectReferenceSections('# 起点\n正文\n\n## 转折\n继续。', 'source-md')
    const fallback = detectReferenceSections('没有标题的短篇正文。', 'source-2')

    expect(detected.sections.filter((section) => section.type === 'chapter')).toHaveLength(2)
    expect(detected.sections[0]).toMatchObject({ title: '第一章 雨夜', included: true })
    expect(markdown.sections).toHaveLength(2)
    expect(markdown.sections[1]).toMatchObject({ title: '转折', boundaryConfidence: 0.82 })
    expect(fallback.sections).toHaveLength(1)
    expect(fallback.sections[0]).toMatchObject({ title: '全文', boundaryConfidence: 0.3 })
    expect(fallback.warnings).toHaveLength(1)
  })
})

describe('参考文本本地章节分包', () => {
  it('以章节为边界组合接近目标的本地分包', () => {
    const sections = [180_000, 110_000, 40_000].map((estimatedTokens, index) => ({
      id: `chapter-${index + 1}`,
      sourceId: 'source-1',
      type: 'chapter' as const,
      order: index,
      title: `第${index + 1}章`,
      start: index * 100,
      end: (index + 1) * 100,
      characterCount: estimatedTokens,
      estimatedTokens,
      boundaryConfidence: 1,
      contentHash: '',
      included: true,
      warnings: [],
      version: 1
    }))

    const plan = buildReferenceLocalChunkPlan(sections, 300_000)

    expect(plan).toMatchObject({ strategy: 'chapter_boundary', splitRequired: true })
    expect(plan.chunks).toHaveLength(2)
    expect(plan.chunks[0]).toMatchObject({
      sectionIds: ['chapter-1', 'chapter-2'],
      estimatedTokens: 290_000
    })
    expect(plan.chunks[1]).toMatchObject({ sectionIds: ['chapter-3'], estimatedTokens: 40_000 })
  })

  it('不在章节内部隐式拆分超大章节', () => {
    const plan = buildReferenceLocalChunkPlan(
      [
        {
          id: 'chapter-1',
          sourceId: 'source-1',
          type: 'chapter',
          order: 0,
          title: '第一章',
          start: 0,
          end: 100,
          characterCount: 320_000,
          estimatedTokens: 320_000,
          boundaryConfidence: 1,
          contentHash: '',
          included: true,
          warnings: [],
          version: 1
        }
      ],
      300_000
    )

    expect(plan.chunks).toHaveLength(1)
    expect(plan.chunks[0]).toMatchObject({ sectionIds: ['chapter-1'], exceedsTarget: true })
    expect(plan.warnings.join('\n')).toContain('为保留章节完整性已单独成包')
  })
})

describe('参考小说本地确定性统计', () => {
  it('生成句长、段落、对话、感官、词汇、标点与章节长度报告', () => {
    const normalized = normalizeReferenceText(SAMPLE)
    const structure = detectReferenceSections(normalized.text, 'source-1')
    const quality = buildReferenceQualityReport(
      'source-1',
      normalized.text,
      'utf-8',
      0.99,
      normalized,
      structure
    )
    const report = analyzeReferenceText(
      'source-1',
      2,
      normalized.text,
      sha256(normalized.text),
      structure.sections,
      quality
    )

    expect(report.sentenceLengths.count).toBeGreaterThan(3)
    expect(report.paragraphLengths.count).toBeGreaterThan(3)
    expect(report.dialogue.ratio).toBeGreaterThan(0)
    expect(report.punctuation.some((item) => item.value === '。')).toBe(true)
    expect(report.vocabulary.length).toBeGreaterThan(0)
    expect(report.sensoryVocabulary.auditory).toBeGreaterThan(0)
    expect(report.sensoryVocabulary.bodily).toBeGreaterThan(0)
    expect(report.chapterLengths).toHaveLength(2)
    expect(report.openingShape.sentenceLength.count).toBeGreaterThan(0)
    expect(report.endingShape.sentenceLength.count).toBeGreaterThan(0)
    expect(report.languageToneObservations.length).toBeGreaterThan(0)
  })

  it('只把广告和重复页眉标为候选，不从标准化文本中静默删除', () => {
    const text = `第一章\n站点.example.com\n正文\n请收藏本书\n页眉\n页眉\n页眉`
    const normalized = normalizeReferenceText(text)
    const structure = detectReferenceSections(normalized.text, 'source-1')
    const quality = buildReferenceQualityReport(
      'source-1',
      normalized.text,
      'utf-8',
      1,
      normalized,
      structure
    )

    expect(normalized.text).toContain('请收藏本书')
    expect(quality.adCandidates.length).toBeGreaterThan(0)
    expect(quality.watermarkCandidates.length).toBeGreaterThan(0)
    expect(quality.duplicateHeaderFooterCount).toBe(3)
  })
})

describe('蒸馏入参等距抽样', () => {
  it('未超上限时原样返回且不共享底层数组', () => {
    const ids = ['a', 'b', 'c']
    const sampled = sampleSectionIdsEvenly(ids, 500)

    expect(sampled).toEqual(['a', 'b', 'c'])
    expect(sampled).not.toBe(ids)
  })

  it('超上限时等距收敛：保留首尾、维持顺序、长度等于上限', () => {
    const ids = Array.from({ length: 1573 }, (_, index) => `s-${index + 1}`)
    const sampled = sampleSectionIdsEvenly(ids, 500)

    expect(sampled).toHaveLength(500)
    expect(sampled[0]).toBe('s-1')
    expect(sampled.at(-1)).toBe('s-1573')
    const positions = sampled.map((id) => ids.indexOf(id))
    expect(positions.every((position, index) => index === 0 || position > positions[index - 1])).toBe(true)
    expect(new Set(sampled).size).toBe(500)
  })

  it('limit 为 1 时只保留首章，非法上限直接抛错', () => {
    expect(sampleSectionIdsEvenly(['a', 'b', 'c'], 1)).toEqual(['a'])
    expect(() => sampleSectionIdsEvenly(['a'], 0)).toThrow()
    expect(() => sampleSectionIdsEvenly(['a'], 1.5)).toThrow()
  })
})
