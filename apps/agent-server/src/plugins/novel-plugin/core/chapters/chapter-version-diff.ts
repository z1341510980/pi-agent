/**
 * 章节版本段落级 Diff 算法
 *
 * 用 LCS（最长公共子序列）DP 对齐两个段落数组，
 * 输出 unchanged / added / removed / modified 四种 segment。
 *
 * 纯函数，不依赖 Store，可前后端共享。
 */
import type { ChapterVersionDiffSegment } from '../types.js'

/** 分段：按空行切分，保留单段内的换行；过滤空段 */
function splitParagraphs(content: string): string[] {
  if (!content) return []
  return content.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0)
}

/** LCS DP 表：返回 dp[i][j] = from[0..i) 与 to[0..j) 的 LCS 长度 */
function buildLcsTable(from: string[], to: string[]): number[][] {
  const n = from.length
  const m = to.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (from[i - 1] === to[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }
  return dp
}

/** LCS 回溯：生成原始 op 列表（equal / delete / insert） */
type LcsOp =
  | { type: 'equal'; fromIndex: number; toIndex: number; content: string }
  | { type: 'delete'; fromIndex: number; content: string }
  | { type: 'insert'; toIndex: number; content: string }

type DeleteOp = Extract<LcsOp, { type: 'delete' }>
type InsertOp = Extract<LcsOp, { type: 'insert' }>

function backtrackLcs(
  from: string[],
  to: string[],
  dp: number[][],
): LcsOp[] {
  const ops: LcsOp[] = []
  let i = from.length
  let j = to.length
  while (i > 0 && j > 0) {
    if (from[i - 1] === to[j - 1]) {
      ops.push({ type: 'equal', fromIndex: i - 1, toIndex: j - 1, content: from[i - 1] })
      i--
      j--
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      ops.push({ type: 'delete', fromIndex: i - 1, content: from[i - 1] })
      i--
    } else {
      ops.push({ type: 'insert', toIndex: j - 1, content: to[j - 1] })
      j--
    }
  }
  while (i > 0) {
    ops.push({ type: 'delete', fromIndex: i - 1, content: from[i - 1] })
    i--
  }
  while (j > 0) {
    ops.push({ type: 'insert', toIndex: j - 1, content: to[j - 1] })
    j--
  }
  // 回溯是逆序的，反转得到正序
  return ops.reverse()
}

/** 把相邻的 delete + insert 合并为 modified，提升可读性 */
function mergeModified(ops: LcsOp[]): ChapterVersionDiffSegment[] {
  const segments: ChapterVersionDiffSegment[] = []
  let i = 0
  while (i < ops.length) {
    const op = ops[i]
    if (op.type === 'equal') {
      segments.push({
        type: 'unchanged',
        content: op.content,
        fromIndex: op.fromIndex,
        toIndex: op.toIndex,
      })
      i++
      continue
    }

    // 收集连续的 delete
    const deletes: DeleteOp[] = []
    while (i < ops.length && ops[i].type === 'delete') {
      deletes.push(ops[i] as DeleteOp)
      i++
    }
    // 收集紧随其后的连续 insert
    const inserts: InsertOp[] = []
    while (i < ops.length && ops[i].type === 'insert') {
      inserts.push(ops[i] as InsertOp)
      i++
    }

    if (deletes.length > 0 && inserts.length === 0) {
      // 纯删除
      for (const d of deletes) {
        segments.push({ type: 'removed', content: d.content, fromIndex: d.fromIndex })
      }
    } else if (deletes.length === 0 && inserts.length > 0) {
      // 纯新增
      for (const ins of inserts) {
        segments.push({ type: 'added', content: ins.content, toIndex: ins.toIndex })
      }
    } else if (deletes.length > 0 && inserts.length > 0) {
      // 同时有删除和新增：按位置配对合并为 modified，多余的单独输出
      const pairCount = Math.min(deletes.length, inserts.length)
      for (let k = 0; k < pairCount; k++) {
        const d = deletes[k]
        const ins = inserts[k]
        segments.push({
          type: 'modified',
          fromContent: d.content,
          toContent: ins.content,
          fromIndex: d.fromIndex,
          toIndex: ins.toIndex,
        })
      }
      // 多余的 delete
      for (let k = pairCount; k < deletes.length; k++) {
        segments.push({ type: 'removed', content: deletes[k].content, fromIndex: deletes[k].fromIndex })
      }
      // 多余的 insert
      for (let k = pairCount; k < inserts.length; k++) {
        segments.push({ type: 'added', content: inserts[k].content, toIndex: inserts[k].toIndex })
      }
    }
  }
  return segments
}

/** diff 结果的 stats 部分（不含 versionId 等元数据） */
export interface ChapterVersionDiffStats {
  segments: ChapterVersionDiffSegment[]
  stats: {
    added: number
    removed: number
    modified: number
    unchanged: number
    wordCountDelta: number
  }
}

/**
 * 计算两个版本正文的段落级 diff。
 *
 * @param fromContent 源版本正文
 * @param toContent 目标版本正文
 * @returns segments + stats（不含 fromVersionId/toVersionId/fromSequence/toSequence，由调用方填充）
 */
export function diffChapterVersions(
  fromContent: string,
  toContent: string,
): ChapterVersionDiffStats {
  const from = splitParagraphs(fromContent)
  const to = splitParagraphs(toContent)

  // 完全相同：直接返回全 unchanged
  if (fromContent === toContent) {
    const segments: ChapterVersionDiffSegment[] = from.map((content, idx) => ({
      type: 'unchanged' as const,
      content,
      fromIndex: idx,
      toIndex: idx,
    }))
    return {
      segments,
      stats: {
        added: 0,
        removed: 0,
        modified: 0,
        unchanged: segments.length,
        wordCountDelta: 0,
      },
    }
  }

  const dp = buildLcsTable(from, to)
  const ops = backtrackLcs(from, to, dp)
  const segments = mergeModified(ops)

  let added = 0
  let removed = 0
  let modified = 0
  let unchanged = 0
  for (const seg of segments) {
    if (seg.type === 'added') added++
    else if (seg.type === 'removed') removed++
    else if (seg.type === 'modified') modified++
    else unchanged++
  }

  const fromWords = fromContent.replace(/\s+/g, '').length
  const toWords = toContent.replace(/\s+/g, '').length

  return {
    segments,
    stats: {
      added,
      removed,
      modified,
      unchanged,
      wordCountDelta: toWords - fromWords,
    },
  }
}
