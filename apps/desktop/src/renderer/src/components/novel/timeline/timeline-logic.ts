/**
 * 时间轴纯逻辑：所有可测的章节区间计算集中于此。
 * 不依赖 React，便于 TDD。
 */

/** move 拖拽：保证 newStart>=1 且 newEnd<=maxChapter（按原时长反推 newStart 上界） */
export function clampMoveRange(
  origStart: number,
  origEnd: number,
  deltaChapters: number,
  maxChapter: number,
): { start: number; end: number } {
  const duration = origEnd - origStart
  const rawStart = origStart + deltaChapters
  const startUpper = maxChapter - duration
  const start = Math.max(1, Math.min(rawStart, startUpper))
  const end = Math.min(start + duration, maxChapter)
  return { start, end }
}

/** resize-right 拖拽：newEnd ∈ [origStart, maxChapter] */
export function clampResizeRightRange(
  origStart: number,
  origEnd: number,
  deltaChapters: number,
  maxChapter: number,
): number {
  const raw = origEnd + deltaChapters
  return Math.max(origStart, Math.min(maxChapter, raw))
}
