import { createHash } from 'node:crypto'
import type {
  ReferenceDistributionSummary,
  ReferenceFrequencyItem,
  ReferenceLocalAnalysisReport,
  ReferenceQualityReport,
  ReferenceSection,
  ReferenceTextCandidate,
  ReferenceTextEncoding
} from '@repo/shared/novel'

export const REFERENCE_PARSER_VERSION = 'reference-parser-v1'
export const REFERENCE_ANALYZER_VERSION = 'reference-local-v1'
export const MAX_REFERENCE_SOURCE_BYTES = 20 * 1024 * 1024
export const MAX_REFERENCE_PREVIEW_CHARS = 2000

const CHAPTER_HEADING =
  /^(?:#{1,6}\s*)?(?:第[0-9零〇一二两三四五六七八九十百千万]+[章节回卷篇部].*|chapter\s+\d+\b.*)$/i
const STRUCTURAL_HEADING = /^(?:#{1,6}\s*)?(目录|序章|序言|前言|楔子|后记|尾声|附录)\s*$/
const MARKDOWN_HEADING = /^#{1,6}\s+\S+.*$/
const AD_PATTERN =
  /(?:最新网址|本章未完|请收藏|求月票|求推荐票|加群|公众号|手机用户请|点击下一页|广告)/i
const WATERMARK_PATTERN = /(?:[a-z0-9-]+\.(?:com|net|cn)|[A-Z]{2,}\d{2,}|txt下载|电子书下载)/i
const MOJIBAKE_PATTERNS = [/�/g, /锟斤拷/g, /烫烫烫/g, /屯屯屯/g]

export interface DecodedReferenceText {
  text: string
  encoding: ReferenceTextEncoding
  confidence: number
  warnings: string[]
}

export interface NormalizedReferenceText {
  text: string
  changes: Array<{ type: string; count: number }>
  controlCharacterCount: number
}

export interface DetectedReferenceStructure {
  sections: ReferenceSection[]
  chapterBoundaryConfidence: number
  warnings: string[]
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function estimateReferenceTokens(text: string): number {
  const hanCount = (text.match(/[\u3400-\u9fff]/g) ?? []).length
  const nonHan = text.length - hanCount
  return Math.max(1, Math.ceil(hanCount * 1.05 + nonHan / 4))
}

function hasGb18030FourByteSequence(bytes: Uint8Array): boolean {
  for (let i = 0; i <= bytes.length - 4; i += 1) {
    if (
      bytes[i]! >= 0x81 &&
      bytes[i]! <= 0xfe &&
      bytes[i + 1]! >= 0x30 &&
      bytes[i + 1]! <= 0x39 &&
      bytes[i + 2]! >= 0x81 &&
      bytes[i + 2]! <= 0xfe &&
      bytes[i + 3]! >= 0x30 &&
      bytes[i + 3]! <= 0x39
    )
      return true
  }
  return false
}

function decodeWith(bytes: Uint8Array, encoding: ReferenceTextEncoding): string {
  const label = encoding === 'utf-8-bom' ? 'utf-8' : encoding === 'gbk' ? 'gb18030' : encoding
  const decoded = new TextDecoder(label, { fatal: true }).decode(bytes)
  return encoding === 'utf-8-bom' && decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded
}

export function detectAndDecodeReferenceText(
  bytes: Uint8Array,
  encodingOverride?: ReferenceTextEncoding
): DecodedReferenceText {
  if (bytes.length === 0) throw new Error('参考文本不能为空')
  if (encodingOverride) {
    const text = decodeWith(bytes, encodingOverride)
    return {
      text,
      encoding: encodingOverride,
      confidence: 1,
      warnings: collectMojibakeWarnings(text)
    }
  }

  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const text = decodeWith(bytes, 'utf-8-bom')
    return { text, encoding: 'utf-8-bom', confidence: 1, warnings: collectMojibakeWarnings(text) }
  }

  try {
    const text = decodeWith(bytes, 'utf-8')
    const asciiOnly = bytes.every((byte) => byte < 0x80)
    return {
      text,
      encoding: 'utf-8',
      confidence: asciiOnly ? 0.75 : 0.99,
      warnings: asciiOnly
        ? ['纯 ASCII 文本无法区分 UTF-8 与 GBK，按 UTF-8 处理']
        : collectMojibakeWarnings(text)
    }
  } catch {
    try {
      const encoding: ReferenceTextEncoding = hasGb18030FourByteSequence(bytes) ? 'gb18030' : 'gbk'
      const text = decodeWith(bytes, encoding)
      return {
        text,
        encoding,
        confidence: encoding === 'gb18030' ? 0.9 : 0.86,
        warnings: collectMojibakeWarnings(text)
      }
    } catch {
      throw new Error('无法可靠识别文本编码，请选择 UTF-8、GBK 或 GB18030 后重试')
    }
  }
}

export function normalizeReferenceText(input: string): NormalizedReferenceText {
  const changes: Array<{ type: string; count: number }> = []
  const crlfCount = (input.match(/\r\n?|\u2028|\u2029/g) ?? []).length
  let text = input.replace(/\r\n?|\u2028|\u2029/g, '\n')
  if (crlfCount > 0) changes.push({ type: 'normalized_line_endings', count: crlfCount })

  const normalized = text.normalize('NFC')
  if (normalized !== text) changes.push({ type: 'unicode_nfc', count: 1 })
  text = normalized

  let controlCharacterCount = 0
  // eslint-disable-next-line no-control-regex -- 精确移除允许换行和制表符之外的 C0/DEL 控制字符。
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, () => {
    controlCharacterCount += 1
    return ''
  })
  if (controlCharacterCount > 0)
    changes.push({ type: 'removed_control_characters', count: controlCharacterCount })

  let trailingWhitespaceCount = 0
  text = text.replace(/[\t ]+$/gm, (value) => {
    trailingWhitespaceCount += value.length
    return ''
  })
  if (trailingWhitespaceCount > 0)
    changes.push({ type: 'trimmed_trailing_whitespace', count: trailingWhitespaceCount })

  let excessBlankLineCount = 0
  text = text
    .replace(/\n{4,}/g, (value) => {
      excessBlankLineCount += value.length - 3
      return '\n\n\n'
    })
    .trim()
  if (excessBlankLineCount > 0)
    changes.push({ type: 'collapsed_blank_lines', count: excessBlankLineCount })

  return { text, changes, controlCharacterCount }
}

export function collectMojibakeWarnings(text: string): string[] {
  const warnings: string[] = []
  for (const pattern of MOJIBAKE_PATTERNS) {
    const count = (text.match(pattern) ?? []).length
    if (count > 0) warnings.push(`检测到 ${count} 处疑似乱码（${pattern.source}）`)
  }
  return warnings
}

function sectionTypeForTitle(title: string): ReferenceSection['type'] {
  const plain = title.replace(/^#{1,6}\s*/, '').trim()
  if (plain === '目录') return 'directory'
  if (/^(?:序章|序言|前言|楔子)$/.test(plain)) return 'preface'
  if (/^(?:后记|尾声)$/.test(plain)) return 'afterword'
  if (plain === '附录') return 'appendix'
  return 'chapter'
}

export function detectReferenceSections(
  text: string,
  sourceId: string
): DetectedReferenceStructure {
  const headings: Array<{ start: number; title: string; confidence: number }> = []
  const linePattern = /^.*$/gm
  for (const match of text.matchAll(linePattern)) {
    const line = match[0].trim()
    if (!line) continue
    if (CHAPTER_HEADING.test(line))
      headings.push({
        start: match.index ?? 0,
        title: line,
        confidence: line.startsWith('#') ? 0.98 : 0.94
      })
    else if (STRUCTURAL_HEADING.test(line))
      headings.push({ start: match.index ?? 0, title: line, confidence: 0.9 })
    else if (MARKDOWN_HEADING.test(line))
      headings.push({ start: match.index ?? 0, title: line, confidence: 0.82 })
  }

  const warnings: string[] = []
  if (headings.length === 0) {
    warnings.push('未识别到明确章节标题，已将全文作为单章；请手动确认边界')
    return {
      sections: [createSection(sourceId, 0, 'chapter', '全文', 0, text.length, 0.3, text)],
      chapterBoundaryConfidence: 0.3,
      warnings
    }
  }

  const sections: ReferenceSection[] = []
  let order = 0
  if (headings[0]!.start > 0 && text.slice(0, headings[0]!.start).trim()) {
    sections.push(
      createSection(sourceId, order++, 'preface', '章节前文本', 0, headings[0]!.start, 0.55, text)
    )
  }
  headings.forEach((heading, index) => {
    const end = headings[index + 1]?.start ?? text.length
    const type = sectionTypeForTitle(heading.title)
    const included = type === 'chapter' || type === 'preface'
    sections.push(
      createSection(
        sourceId,
        order++,
        type,
        heading.title.replace(/^#{1,6}\s*/, ''),
        heading.start,
        end,
        heading.confidence,
        text,
        included
      )
    )
  })
  const chapterSections = sections.filter((section) => section.type === 'chapter')
  if (chapterSections.length === 0) warnings.push('只识别到目录或前后记，未识别到正文章节')
  return {
    sections,
    chapterBoundaryConfidence: average(sections.map((section) => section.boundaryConfidence)),
    warnings
  }
}

function createSection(
  sourceId: string,
  order: number,
  type: ReferenceSection['type'],
  title: string,
  start: number,
  end: number,
  confidence: number,
  text: string,
  included = true
): ReferenceSection {
  const content = text.slice(start, end)
  return {
    id: crypto.randomUUID(),
    sourceId,
    type,
    order,
    title,
    start,
    end,
    characterCount: content.length,
    estimatedTokens: estimateReferenceTokens(content),
    boundaryConfidence: confidence,
    contentHash: sha256(content),
    included,
    exclusionReason: included ? undefined : `自动识别为${type}`,
    warnings: confidence < 0.6 ? ['章节边界置信度较低，需要人工确认'] : [],
    version: 1
  }
}

function lineCandidate(line: string, lineStart: number, reason: string): ReferenceTextCandidate {
  return { start: lineStart, end: lineStart + line.length, preview: line.slice(0, 80), reason }
}

export function buildReferenceQualityReport(
  sourceId: string,
  text: string,
  encoding: ReferenceTextEncoding,
  encodingConfidence: number,
  normalized: NormalizedReferenceText,
  structure: DetectedReferenceStructure
): ReferenceQualityReport {
  const lineCounts = new Map<string, number>()
  const lineOffsets = new Map<string, number>()
  const watermarkCandidates: ReferenceTextCandidate[] = []
  const adCandidates: ReferenceTextCandidate[] = []
  let offset = 0
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line) {
      lineCounts.set(line, (lineCounts.get(line) ?? 0) + 1)
      if (!lineOffsets.has(line)) lineOffsets.set(line, offset + rawLine.indexOf(line))
      if (WATERMARK_PATTERN.test(line))
        watermarkCandidates.push(
          lineCandidate(line, offset + rawLine.indexOf(line), '疑似站点水印')
        )
      if (AD_PATTERN.test(line))
        adCandidates.push(lineCandidate(line, offset + rawLine.indexOf(line), '疑似广告或站点提示'))
    }
    offset += rawLine.length + 1
  }
  const duplicateHeaderFooterCount = [...lineCounts.entries()]
    .filter(([line, count]) => count >= 3 && line.length <= 80)
    .reduce((sum, [, count]) => sum + count, 0)
  const duplicateCandidates = [...lineCounts.entries()]
    .filter(([line, count]) => count >= 3 && line.length <= 80)
    .slice(0, 30)
    .map(([line]) => lineCandidate(line, lineOffsets.get(line) ?? 0, '疑似重复页眉或页脚'))
  const mojibakeWarnings = collectMojibakeWarnings(text)
  const lowConfidenceSectionIds = structure.sections
    .filter((section) => section.boundaryConfidence < 0.6)
    .map((section) => section.id)
  return {
    id: crypto.randomUUID(),
    sourceId,
    encoding,
    encodingConfidence,
    mojibakeWarnings,
    controlCharacterCount: normalized.controlCharacterCount,
    duplicateHeaderFooterCount,
    watermarkCandidates: watermarkCandidates.slice(0, 30),
    adCandidates: adCandidates.slice(0, 30),
    chapterBoundaryConfidence: structure.chapterBoundaryConfidence,
    sceneBoundaryConfidence: 0,
    normalizationChanges: normalized.changes,
    lowConfidenceSectionIds,
    excludedCandidates: [...duplicateCandidates, ...watermarkCandidates, ...adCandidates].slice(
      0,
      60
    ),
    generatedAt: new Date().toISOString()
  }
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0
}

function summarize(values: number[]): ReferenceDistributionSummary {
  if (values.length === 0) return { count: 0, min: 0, max: 0, average: 0, median: 0, p90: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: values.length,
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
    average: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)),
    median: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9)
  }
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;])/u)
    .map((value) => value.trim())
    .filter(Boolean)
}

function dialogueMetrics(text: string): {
  characterCount: number
  ratio: number
  paragraphRatio: number
} {
  let characterCount = 0
  const matches = text.matchAll(/[“「『"]([^”」』"\n]+)[”」』"]/g)
  for (const match of matches) characterCount += match[0].length
  const nonWhitespaceLength = text.replace(/\s/g, '').length
  const paragraphs = text
    .split(/\n+/)
    .map((value) => value.trim())
    .filter(Boolean)
  const dialogueParagraphs = paragraphs.filter((value) => /[“「『"].+[”」』"]/.test(value)).length
  return {
    characterCount,
    ratio:
      nonWhitespaceLength === 0 ? 0 : Number((characterCount / nonWhitespaceLength).toFixed(4)),
    paragraphRatio:
      paragraphs.length === 0 ? 0 : Number((dialogueParagraphs / paragraphs.length).toFixed(4))
  }
}

function frequencies(entries: string[], total: number, limit: number): ReferenceFrequencyItem[] {
  const counts = new Map<string, number>()
  for (const entry of entries) counts.set(entry, (counts.get(entry) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({
      value,
      count,
      ratio: total === 0 ? 0 : Number((count / total).toFixed(4))
    }))
}

function vocabulary(text: string): string[] {
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
  return [...segmenter.segment(text)]
    .filter((part) => part.isWordLike && part.segment.trim().length > 0)
    .map((part) => part.segment.toLocaleLowerCase())
}

function repeatedExpressions(text: string): ReferenceFrequencyItem[] {
  const compact = text.replace(/[^\u3400-\u9fff]/g, '')
  const counts = new Map<string, number>()
  for (let i = 0; i <= compact.length - 4; i += 1) {
    const value = compact.slice(i, i + 4)
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  const repeated = [...counts.entries()].filter(([, count]) => count >= 3)
  const total = repeated.reduce((sum, [, count]) => sum + count, 0)
  return repeated
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 30)
    .map(([value, count]) => ({
      value,
      count,
      ratio: total === 0 ? 0 : Number((count / total).toFixed(4))
    }))
}

const SENSORY_TERMS = {
  visual: ['看', '望', '瞥', '亮', '暗', '颜色', '光', '影'],
  auditory: ['听', '响', '声', '鸣', '吼', '低语', '耳边'],
  olfactory: ['闻', '气味', '香', '臭', '腥', '焦味'],
  tactile: ['冷', '热', '触', '摸', '粗糙', '柔软', '刺痛'],
  taste: ['甜', '苦', '酸', '咸', '辣', '味道'],
  bodily: ['呼吸', '心跳', '掌心', '喉咙', '胸口', '颤', '疼', '汗']
} as const

function countTerms(text: string, terms: readonly string[]): number {
  return terms.reduce((sum, term) => sum + (text.split(term).length - 1), 0)
}

function shape(text: string): ReferenceLocalAnalysisReport['openingShape'] {
  const sampleSentences = sentences(text)
  return {
    sentenceLength: summarize(sampleSentences.map((value) => value.replace(/\s/g, '').length)),
    dialogueRatio: dialogueMetrics(text).ratio
  }
}

export function analyzeReferenceText(
  sourceId: string,
  sourceVersion: number,
  text: string,
  normalizedHash: string,
  sections: ReferenceSection[],
  qualityReport: ReferenceQualityReport
): ReferenceLocalAnalysisReport {
  const allSentences = sentences(text)
  const sentenceLengths = allSentences.map((value) => value.replace(/\s/g, '').length)
  const paragraphs = text
    .split(/\n+/)
    .map((value) => value.trim())
    .filter(Boolean)
  const paragraphLengths = paragraphs.map((value) => value.replace(/\s/g, '').length)
  const dialogue = dialogueMetrics(text)
  const punctuationEntries = text.match(/[，。！？；：、,.!?;:…—]/g) ?? []
  const words = vocabulary(text)
  const expressions = repeatedExpressions(text)
  const includedCharacters = sections
    .filter((section) => section.included)
    .reduce((sum, section) => sum + section.characterCount, 0)
  const chapterLengths = sections
    .filter((section) => section.type === 'chapter')
    .map((section) => {
      const content = text.slice(section.start, section.end)
      return {
        sectionId: section.id,
        title: section.title ?? `第 ${section.order + 1} 章`,
        characterCount: section.characterCount,
        sentenceCount: sentences(content).length,
        paragraphCount: content.split(/\n+/).filter((value) => value.trim()).length,
        dialogueRatio: dialogueMetrics(content).ratio
      }
    })
  const sentenceSummary = summarize(sentenceLengths)
  const observations: string[] = []
  if (sentenceSummary.average >= 30)
    observations.push('平均句长较长，文本更偏连续展开；这是语言形态观察，不等同于文风结论。')
  else if (sentenceSummary.average > 0 && sentenceSummary.average <= 16)
    observations.push('平均句长较短，文本更偏快速断句；这是语言形态观察，不等同于节奏结论。')
  if (dialogue.ratio >= 0.4) observations.push('对话字符占比较高，人物直接发言承担了较多文本篇幅。')
  if (paragraphLengths.length > 0 && summarize(paragraphLengths).average <= 60)
    observations.push('段落平均长度较短，版面切分较密。')
  if (observations.length === 0) observations.push('当前统计未显示明显的句长、段落或对话极端倾向。')

  const warnings = [...qualityReport.mojibakeWarnings]
  if (qualityReport.lowConfidenceSectionIds.length > 0)
    warnings.push('存在低置信度章节边界，请在使用统计前人工确认。')
  if (qualityReport.adCandidates.length > 0 || qualityReport.watermarkCandidates.length > 0)
    warnings.push('检测到广告或水印候选，当前统计仍包含这些文本。')

  return {
    id: crypto.randomUUID(),
    sourceId,
    sourceVersion,
    normalizedHash,
    analyzerVersion: REFERENCE_ANALYZER_VERSION,
    sentenceLengths: {
      ...sentenceSummary,
      buckets: {
        '1-10': sentenceLengths.filter((value) => value <= 10).length,
        '11-20': sentenceLengths.filter((value) => value >= 11 && value <= 20).length,
        '21-40': sentenceLengths.filter((value) => value >= 21 && value <= 40).length,
        '41+': sentenceLengths.filter((value) => value >= 41).length
      }
    },
    paragraphLengths: summarize(paragraphLengths),
    dialogue,
    punctuation: frequencies(punctuationEntries, punctuationEntries.length, 30),
    vocabulary: frequencies(words, words.length, 50),
    sensoryVocabulary: {
      visual: countTerms(text, SENSORY_TERMS.visual),
      auditory: countTerms(text, SENSORY_TERMS.auditory),
      olfactory: countTerms(text, SENSORY_TERMS.olfactory),
      tactile: countTerms(text, SENSORY_TERMS.tactile),
      taste: countTerms(text, SENSORY_TERMS.taste),
      bodily: countTerms(text, SENSORY_TERMS.bodily)
    },
    narrativePersonSignals: {
      firstPerson: countTerms(text, ['我', '我们', '咱们']),
      thirdPerson: countTerms(text, ['他', '她', '他们', '她们'])
    },
    highFrequencyExpressions: expressions,
    chapterLengths,
    openingShape: shape(text.slice(0, 1000)),
    endingShape: shape(text.slice(Math.max(0, text.length - 1000))),
    languageToneObservations: observations,
    dataQuality: {
      includedCharacterRatio:
        text.length === 0 ? 0 : Number((includedCharacters / text.length).toFixed(4)),
      lowConfidenceChapterCount: qualityReport.lowConfidenceSectionIds.length,
      mojibakeWarningCount: qualityReport.mojibakeWarnings.length,
      warnings
    },
    generatedAt: new Date().toISOString()
  }
}

function average(values: number[]): number {
  return values.length === 0
    ? 0
    : Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4))
}
