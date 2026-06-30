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

// ── 吸附系统 ──

export const SNAP_PX = 8

export interface SnapResult {
  chapter: number
  type: 'playhead' | 'clip-end' | 'chapter'
  priority: number
  distance: number
}

interface SnapClip {
  id: string
  startChapter: number
  endChapter: number
}
interface SnapTrack {
  id: string
  clips: SnapClip[]
}

/**
 * 吸附判定：threshold = SNAP_PX / chapterWidth（不再 Math.max 兜底）。
 * 接受浮点 currentStart/currentEnd，使吸附在子章节精度生效。
 */
export function findSnapPoint(
  currentStart: number,
  currentEnd: number,
  chapterWidth: number,
  excludeClipId: string,
  tracks: SnapTrack[],
  playheadChapter: number,
  maxChapter: number,
): SnapResult | null {
  const threshold = SNAP_PX / chapterWidth
  const candidates: Array<{ chapter: number; type: SnapResult['type']; priority: number }> = []

  candidates.push({ chapter: playheadChapter, type: 'playhead', priority: 100 })

  // 被拖拽片段的原位章节不应作为吸附目标（否则未移动时也会出现吸附辅助线）
  let excludedStart = NaN
  let excludedEndPlus1 = NaN
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.id === excludeClipId) {
        excludedStart = clip.startChapter
        excludedEndPlus1 = clip.endChapter + 1
        continue
      }
      candidates.push({ chapter: clip.startChapter, type: 'clip-end', priority: 85 })
      candidates.push({ chapter: clip.endChapter + 1, type: 'clip-end', priority: 85 })
    }
  }

  for (let ch = 1; ch <= maxChapter; ch++) {
    if (ch === excludedStart || ch === excludedEndPlus1) continue
    candidates.push({ chapter: ch, type: 'chapter', priority: 70 })
  }

  let best: SnapResult | null = null
  for (const endpoint of [currentStart, currentEnd + 1]) {
    for (const c of candidates) {
      const dist = Math.abs(c.chapter - endpoint)
      if (dist > threshold) continue
      if (!best || dist < best.distance ||
          (dist === best.distance && c.priority > best.priority)) {
        best = { chapter: c.chapter, type: c.type, priority: c.priority, distance: dist }
      }
    }
  }
  return best
}
