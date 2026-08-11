/**
 * SharedOverlapAnalyzer：相邻章 shared 重复率统计（PRD §4.1 P0-3）。
 *
 * 数据来源（只读聚合）：
 * - novel_agent_logs.chapter_context：每章取第一条 Agent 日志的 SEMI 层拼接文本
 *   （shared + identity + suffix，其中 shared 占绝对主体），作为该章 shared 的持久化代理；
 *   归一化（去空白/换行）后按相邻字符 bigram 计算重复占比：
 *     overlap = |bigrams(A) ∩ bigrams(B)| / |bigrams(A)|
 * - novel_context_section_metrics：section 级 source_hash，用于
 *   （a）top 高频重复 section；（b）实体档案（arranged-entities）hash 级粗判
 *   （全同 = 1，不同 = 0，精确字符级重复由 sample-baseline.mjs 对全文做）。
 *
 * 输出分布 p50 / p75 / max 与 top 高频重复 section（P3 跨章缓存决策输入）。
 */
import type Database from 'better-sqlite3'

export interface OverlapPair {
  fromChapter: number
  toChapter: number
  /** 全 shared 口径重复率 0~1（基于 chapter_context 代理文本） */
  overlapRatio: number
  /** 仅实体档案口径重复率 0~1（hash 级粗判；缺任一数据时为 null） */
  arrangedOverlapRatio: number | null
}

export interface OverlapDistribution {
  count: number
  p50: number
  p75: number
  max: number
}

export interface SharedOverlapReport {
  projectId: string
  pairs: OverlapPair[]
  distribution: OverlapDistribution
  arrangedDistribution: OverlapDistribution
  /** top 高频重复 section（按出现次数降序） */
  topSections: Array<{ sectionId: string; count: number }>
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}

/** 归一化：去空白/换行 */
function normalize(text: string): string {
  return text.replace(/\s+/g, '')
}

/** 计算文本的相邻字符 bigram 集合 */
function bigrams(text: string): Set<string> {
  const set = new Set<string>()
  const norm = normalize(text)
  for (let i = 0; i + 1 < norm.length; i += 1) {
    set.add(norm.slice(i, i + 2))
  }
  return set
}

/** 重复率 = |bigrams(A) ∩ bigrams(B)| / |bigrams(A)| */
function overlapRatio(a: string, b: string): number {
  const bigramsA = bigrams(a)
  if (bigramsA.size === 0) return 0
  const bigramsB = bigrams(b)
  let common = 0
  for (const gram of bigramsA) {
    if (bigramsB.has(gram)) common += 1
  }
  return common / bigramsA.size
}

export class SharedOverlapAnalyzer {
  constructor(private db: Database.Database) {}

  /**
   * 分析相邻章 shared 重复率。
   * @param projectId 项目 ID
   * @param opts.chapterNumbers 限定抽样章节（升序）；缺省读取该项目全部有日志的章节
   */
  analyze(projectId: string, opts?: { chapterNumbers?: number[] }): SharedOverlapReport {
    // 1) 每章取第一条 Agent 日志的 chapter_context 作为 shared 代理文本
    const contextRows = this.db.prepare(
      `SELECT chapter_number, chapter_context, created_at
       FROM novel_agent_logs
       WHERE project_id = ? AND length(chapter_context) > 0
       ORDER BY created_at ASC`,
    ).all(projectId) as Array<{ chapter_number: number; chapter_context: string; created_at: number }>

    const chapterContext = new Map<number, string>()
    for (const row of contextRows) {
      if (!chapterContext.has(row.chapter_number)) {
        chapterContext.set(row.chapter_number, row.chapter_context)
      }
    }

    // 2) 度量表：top 高频重复 section + arranged-entities hash 粗判
    const metricRows = this.db.prepare(
      `SELECT chapter_number, section_id, source_hash, chars
       FROM novel_context_section_metrics
       WHERE project_id = ? AND section_type = 'shared'
       ORDER BY chapter_number ASC`,
    ).all(projectId) as Array<{
      chapter_number: number
      section_id: string
      source_hash: string
      chars: number
    }>

    const sectionCount = new Map<string, number>()
    const chapterArrangedHash = new Map<number, string>()
    for (const row of metricRows) {
      sectionCount.set(row.section_id, (sectionCount.get(row.section_id) ?? 0) + 1)
      if (row.section_id === 'arranged-entities') {
        chapterArrangedHash.set(row.chapter_number, row.source_hash)
      }
    }

    const chapters = opts?.chapterNumbers?.slice().sort((a, b) => a - b)
      ?? [...new Set([...chapterContext.keys(), ...chapterArrangedHash.keys()])].sort((a, b) => a - b)

    const pairs: OverlapPair[] = []
    for (let i = 0; i + 1 < chapters.length; i += 1) {
      const fromChapter = chapters[i]
      const toChapter = chapters[i + 1]
      const fromText = chapterContext.get(fromChapter)
      const toText = chapterContext.get(toChapter)
      if (fromText == null || toText == null) continue
      const fromArranged = chapterArrangedHash.get(fromChapter)
      const toArranged = chapterArrangedHash.get(toChapter)
      pairs.push({
        fromChapter,
        toChapter,
        overlapRatio: overlapRatio(fromText, toText),
        arrangedOverlapRatio: fromArranged != null && toArranged != null
          ? (fromArranged === toArranged ? 1 : 0)
          : null,
      })
    }

    const allRatios = pairs.map((p) => p.overlapRatio).sort((a, b) => a - b)
    const arrangedRatios = pairs
      .filter((p) => p.arrangedOverlapRatio != null)
      .map((p) => p.arrangedOverlapRatio as number)
      .sort((a, b) => a - b)

    const topSections = [...sectionCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([sectionId, count]) => ({ sectionId, count }))

    return {
      projectId,
      pairs,
      distribution: {
        count: allRatios.length,
        p50: percentile(allRatios, 0.5),
        p75: percentile(allRatios, 0.75),
        max: allRatios.length > 0 ? allRatios[allRatios.length - 1] : 0,
      },
      arrangedDistribution: {
        count: arrangedRatios.length,
        p50: percentile(arrangedRatios, 0.5),
        p75: percentile(arrangedRatios, 0.75),
        max: arrangedRatios.length > 0 ? arrangedRatios[arrangedRatios.length - 1] : 0,
      },
      topSections,
    }
  }
}
