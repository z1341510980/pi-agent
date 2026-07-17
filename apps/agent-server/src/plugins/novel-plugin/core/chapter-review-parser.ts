import type { NovelChapterReview } from './types.js'

type ParsedReview = Omit<NovelChapterReview, 'id' | 'projectId' | 'chapterId' | 'reviewedBy' | 'createdAt'>

const SCORE_LABELS: Array<[keyof ParsedReview, string]> = [
  ['consistencyScore', '一致性'], ['characterScore', '角色'],
  ['taskCompletionScore', '任务完成'], ['clueProgressScore', '线索推进'],
  ['foreshadowStatusScore', '伏笔状态'], ['conflictChangeScore', '冲突变化'],
  ['pacingScore', '节奏'], ['infoControlScore', '信息控制'],
  ['readerHookScore', '读者钩子'], ['styleScore', '文风'], ['overallScore', '总体'],
]

export function parseChapterReviewReport(report: string): ParsedReview {
  const result = Object.fromEntries(SCORE_LABELS.map(([key]) => [key, null])) as unknown as ParsedReview
  for (const [key, label] of SCORE_LABELS) {
    const match = report.match(new RegExp(`(?:^|\\n)[^\\n]*${label}\\s*[：:]\\s*(\\d+(?:\\.\\d+)?)\\s*(?:/\\s*10)?`, 'i'))
    if (match) result[key] = Math.max(0, Math.min(10, Number(match[1]))) as never
  }

  const verdict = report.match(/##\s*结论\s*[：:]\s*(accept|revise|reject)\b/i)?.[1]?.toLowerCase()
  result.verdict = verdict === 'accept' || verdict === 'revise' || verdict === 'reject' ? verdict : null

  const issues: string[] = []
  const suggestions: string[] = []
  for (const line of report.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim()).filter(Boolean)
    if (cells.length < 6 || !/^\d+$/.test(cells[0]) || !/^S[1-4]$/i.test(cells[1])) continue
    issues.push(`[${cells[1].toUpperCase()}/${cells[2]}] ${cells[4]}：${cells[3]}`)
    if (cells[5] && cells[5] !== '无') suggestions.push(cells[5])
  }
  result.issues = JSON.stringify(issues)
  result.suggestions = JSON.stringify(suggestions)
  return result
}
