export interface ProseQualityMetrics {
  characterCount: number
  paragraphCount: number
  sentenceCount: number
  singleSentenceParagraphs: number
  shortParagraphs: number
  maxConsecutiveSingleSentenceParagraphs: number
  dialogueRatio: number
  patternCounts: {
    binaryContrast: number
    explanatoryTone: number
    genericSimile: number
    genericSuspense: number
    metaWriting: number
  }
}

export interface ProseQualityIssue {
  code:
    | 'fragmented_paragraphs'
    | 'short_paragraph_density'
    | 'binary_contrast'
    | 'explanatory_tone'
    | 'generic_simile'
    | 'generic_suspense'
    | 'meta_writing'
  severity: 'warning' | 'error'
  message: string
}

export interface ProseQualityReport {
  score: number
  metrics: ProseQualityMetrics
  issues: ProseQualityIssue[]
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length
}

function splitParagraphs(content: string): string[] {
  return content
    .replace(/\r\n/g, '\n')
    .split(/\n+/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean)
}

function countSentences(paragraph: string): number {
  const count = countMatches(paragraph, /[。！？!?]+(?=[”"」』）)]|\s|$)/g)
  return Math.max(1, count)
}

function computeDialogueRatio(content: string, characterCount: number): number {
  if (characterCount === 0) return 0
  const dialogueCharacters = [...content.matchAll(/[“「『"]([^”」』"\n]{1,500})[”」』"]/g)]
    .reduce((sum, match) => sum + (match[1]?.replace(/\s/g, '').length ?? 0), 0)
  return Math.round((dialogueCharacters / characterCount) * 1000) / 10
}

/**
 * 只测量可确定的正文形态，不判断剧情好坏。
 *
 * 阈值刻意保守：报告用于 Reviewer 复核，不直接触发整章重写，避免把风格偏好
 * 误判为致命错误。项目文风档案仍是最终判断依据。
 */
export function evaluateProseQuality(content: string): ProseQualityReport {
  const paragraphs = splitParagraphs(content)
  const characterCount = content.replace(/\s/g, '').length
  const sentenceCounts = paragraphs.map(countSentences)
  const singleSentenceParagraphs = sentenceCounts.filter(count => count === 1).length
  const shortParagraphs = paragraphs.filter(paragraph => paragraph.replace(/\s/g, '').length <= 18).length
  let maxConsecutiveSingleSentenceParagraphs = 0
  let currentConsecutive = 0
  for (const count of sentenceCounts) {
    currentConsecutive = count === 1 ? currentConsecutive + 1 : 0
    maxConsecutiveSingleSentenceParagraphs = Math.max(maxConsecutiveSingleSentenceParagraphs, currentConsecutive)
  }

  const patternCounts = {
    binaryContrast: countMatches(content, /(?:不是|并非|不在于)[^。！？\n]{1,60}(?:而是|而在于)|与其说[^。！？\n]{1,50}不如说/g),
    explanatoryTone: countMatches(content, /(?:这意味着|换句话说|也就是说|由此可见|显而易见|他明白了|她明白了|逻辑(?:很)?清楚)/g),
    genericSimile: countMatches(content, /像(?:是|有|一|某|什么|被|在)?[^，。！？\n]{1,24}/g),
    genericSuspense: countMatches(content, /(?:黑暗里.*睁开|命运的齿轮|冥冥之中|真正的.*才刚刚开始|一切才刚开始)/g),
    metaWriting: countMatches(content.slice(0, 600), /(?:先核对|按(?:章纲|导演方案)|下面(?:开始|是).*正文|创作第\s*\d+\s*章|输出完整正文|修订完成|修改说明)/g),
  }

  const metrics: ProseQualityMetrics = {
    characterCount,
    paragraphCount: paragraphs.length,
    sentenceCount: sentenceCounts.reduce((sum, count) => sum + count, 0),
    singleSentenceParagraphs,
    shortParagraphs,
    maxConsecutiveSingleSentenceParagraphs,
    dialogueRatio: computeDialogueRatio(content, characterCount),
    patternCounts,
  }
  const issues: ProseQualityIssue[] = []
  const singleRatio = paragraphs.length > 0 ? singleSentenceParagraphs / paragraphs.length : 0
  const shortRatio = paragraphs.length > 0 ? shortParagraphs / paragraphs.length : 0
  const perThousand = Math.max(1, characterCount / 1000)

  if (paragraphs.length >= 20 && (singleRatio >= 0.55 || maxConsecutiveSingleSentenceParagraphs >= 6)) {
    issues.push({
      code: 'fragmented_paragraphs',
      severity: singleRatio >= 0.7 ? 'error' : 'warning',
      message: `单句段 ${singleSentenceParagraphs}/${paragraphs.length}，最长连续 ${maxConsecutiveSingleSentenceParagraphs} 段，正文可能呈现提纲式碎片节奏`,
    })
  }
  if (paragraphs.length >= 20 && shortRatio >= 0.3) {
    issues.push({
      code: 'short_paragraph_density',
      severity: shortRatio >= 0.45 ? 'error' : 'warning',
      message: `18 字以内短段 ${shortParagraphs}/${paragraphs.length}，需检查是否用空行制造虚假节奏`,
    })
  }
  if (patternCounts.binaryContrast >= 3) {
    issues.push({ code: 'binary_contrast', severity: 'warning', message: `检测到 ${patternCounts.binaryContrast} 处“不是 A 而是 B”式对称解释` })
  }
  if (patternCounts.explanatoryTone >= 3) {
    issues.push({ code: 'explanatory_tone', severity: 'warning', message: `检测到 ${patternCounts.explanatoryTone} 处替读者归纳的解释句` })
  }
  if (patternCounts.genericSimile / perThousand >= 2.5) {
    issues.push({ code: 'generic_simile', severity: 'warning', message: `泛化“像……”比喻 ${patternCounts.genericSimile} 处，密度偏高` })
  }
  if (patternCounts.genericSuspense > 0) {
    issues.push({ code: 'generic_suspense', severity: 'warning', message: `检测到 ${patternCounts.genericSuspense} 处模板化悬念句` })
  }
  if (patternCounts.metaWriting > 0) {
    issues.push({ code: 'meta_writing', severity: 'error', message: '正文开头包含核对、创作或修订说明' })
  }

  const score = Math.max(0, issues.reduce((current, issue) => (
    current - (issue.severity === 'error' ? 18 : 8)
  ), 100))
  return { score, metrics, issues }
}

export function formatProseQualityReport(report: ProseQualityReport): string {
  const { metrics } = report
  const lines = [
    '## 正文形态扫描（确定性指标，需结合文风档案复核）',
    `- 形态分：${report.score}/100`,
    `- 段落：${metrics.paragraphCount}；单句段：${metrics.singleSentenceParagraphs}；18 字内短段：${metrics.shortParagraphs}；最长连续单句段：${metrics.maxConsecutiveSingleSentenceParagraphs}`,
    `- 估算对话占比：${metrics.dialogueRatio}%`,
  ]
  if (report.issues.length === 0) {
    lines.push('- 未命中高置信度形态问题；这不等于文学质量自动通过。')
  } else {
    lines.push(...report.issues.map(issue => `- [${issue.severity === 'error' ? '严重' : '提示'}] ${issue.message}`))
  }
  return lines.join('\n')
}
