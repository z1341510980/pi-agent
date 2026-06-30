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

/**
 * 吸附后对 newStart/newEnd 做最终边界校验，防止吸附位移导致越界。
 * - move：按 orig 时长反推 start 上界，保证 [1, maxChapter] 内完整区间
 * - resize-left：start ∈ [1, origEnd]
 * - resize-right：end ∈ [origStart, maxChapter]
 */
export function finalClampAfterSnap(
  type: 'move' | 'resize-left' | 'resize-right',
  newStart: number,
  newEnd: number,
  origStart: number,
  origEnd: number,
  maxChapter: number,
): { start: number; end: number } {
  if (type === 'move') {
    const duration = origEnd - origStart
    const start = Math.max(1, Math.min(newStart, maxChapter - duration))
    return { start, end: start + duration }
  }
  if (type === 'resize-left') {
    const start = Math.max(1, Math.min(newStart, origEnd))
    return { start, end: newEnd }
  }
  // resize-right
  const end = Math.max(origStart, Math.min(newEnd, maxChapter))
  return { start: newStart, end }
}

// ── 关系层连线构建 ──

const RELATION_COLOR: Record<string, string> = {
  family: 'rgba(239, 68, 68, 0.7)',
  friendship: 'rgba(59, 130, 246, 0.7)',
  romance: 'rgba(236, 72, 153, 0.7)',
  rivalry: 'rgba(30, 41, 59, 0.7)',
  mentor: 'rgba(168, 85, 247, 0.7)',
  ally: 'rgba(16, 185, 129, 0.7)',
  leader: 'rgba(217, 119, 6, 0.85)',
}

const RELATION_LABEL: Record<string, string> = {
  family: '亲情',
  friendship: '友情',
  romance: '爱情',
  rivalry: '敌对',
  mentor: '师徒',
  ally: '盟友',
  leader: '领袖',
}

export interface LineSegment {
  id: string
  x1: number
  y1: number
  x2: number
  y2: number
  color: string
  label: string
  relationType: string
}

interface RelClip { id: string; startChapter: number; endChapter: number; entityId: string }
interface RelTrack { id: string; kind: string; clips: RelClip[] }
interface RelRelationship { id: string; characterA: string; characterB: string; relationType?: string }
interface RelFaction { id: string; leaderId: string | null; allies: string[] | null; enemies: string[] | null }

/** 构建关系连线（纯函数，从 timeline-relation-layer.tsx 抽取） */
export function buildRelationLines(
  tracks: RelTrack[],
  relationships: RelRelationship[],
  factions: RelFaction[],
  chapterWidth: number,
  trackHeight: number,
): LineSegment[] {
  const trackClipRangeMap = new Map<string, { start: number; end: number; midX: number; midY: number }>()
  tracks.forEach((track, idx) => {
    if ((track.kind === 'character' || track.kind === 'faction') && track.clips.length > 0) {
      const clip = track.clips[0]
      const midCh = (clip.startChapter + clip.endChapter) / 2
      trackClipRangeMap.set(clip.entityId, {
        start: clip.startChapter,
        end: clip.endChapter,
        midX: (midCh - 0.5) * chapterWidth,
        midY: idx * trackHeight + trackHeight / 2,
      })
    }
  })

  const lines: LineSegment[] = []

  for (const rel of relationships) {
    const a = trackClipRangeMap.get(rel.characterA)
    const b = trackClipRangeMap.get(rel.characterB)
    if (!a || !b) continue
    if (a.end < b.start || b.end < a.start) continue
    const relationType = rel.relationType ?? 'ally'
    const color = RELATION_COLOR[relationType] ?? 'rgba(100, 100, 100, 0.5)'
    const label = RELATION_LABEL[relationType] ?? relationType
    lines.push({ id: rel.id, x1: a.midX, y1: a.midY, x2: b.midX, y2: b.midY, color, label, relationType })
  }

  const factionPairSeen = new Set<string>()
  for (const f of factions) {
    const fRange = trackClipRangeMap.get(f.id)
    if (!fRange) continue
    for (const allyId of f.allies ?? []) {
      const allyRange = trackClipRangeMap.get(allyId)
      if (!allyRange) continue
      const key = `${[f.id, allyId].sort().join('|')}|ally`
      if (factionPairSeen.has(key)) continue
      factionPairSeen.add(key)
      if (fRange.end < allyRange.start || allyRange.end < fRange.start) continue
      lines.push({ id: `faction-ally-${key}`, x1: fRange.midX, y1: fRange.midY, x2: allyRange.midX, y2: allyRange.midY, color: RELATION_COLOR.ally, label: '同盟', relationType: 'ally' })
    }
    for (const enemyId of f.enemies ?? []) {
      const enemyRange = trackClipRangeMap.get(enemyId)
      if (!enemyRange) continue
      const key = `${[f.id, enemyId].sort().join('|')}|enemy`
      if (factionPairSeen.has(key)) continue
      factionPairSeen.add(key)
      if (fRange.end < enemyRange.start || enemyRange.end < fRange.start) continue
      lines.push({ id: `faction-enemy-${key}`, x1: fRange.midX, y1: fRange.midY, x2: enemyRange.midX, y2: enemyRange.midY, color: RELATION_COLOR.rivalry, label: '敌对', relationType: 'rivalry' })
    }
  }

  for (const f of factions) {
    if (!f.leaderId) continue
    const fRange = trackClipRangeMap.get(f.id)
    if (!fRange) continue
    const leaderRange = trackClipRangeMap.get(f.leaderId)
    if (!leaderRange) continue
    if (fRange.end < leaderRange.start || leaderRange.end < fRange.start) continue
    lines.push({ id: `faction-leader-${f.id}-${f.leaderId}`, x1: fRange.midX, y1: fRange.midY, x2: leaderRange.midX, y2: leaderRange.midY, color: RELATION_COLOR.leader, label: '领袖', relationType: 'leader' })
  }

  return lines
}

// ── 小地图视口框 ──

/** 计算小地图视口框的 left/width（px），用于独立 DOM 元素定位 */
export function computeMinimapViewportFrame(
  viewportStartChapter: number,
  viewportVisibleChapters: number,
  maxChapter: number,
  containerWidth: number,
): { left: number; width: number } {
  if (maxChapter <= 0) return { left: 0, width: 8 }
  const chapterW = containerWidth / maxChapter
  const left = (viewportStartChapter - 1) * chapterW
  const width = Math.max(8, viewportVisibleChapters * chapterW)
  return { left, width }
}

// ── 撤销/重做编辑动作 ──

export type EditActionType = 'move' | 'resize' | 'delete' | 'paste' | 'cut'

export interface EditAction {
  type: EditActionType
  clip: {
    id: string
    startChapter: number
    endChapter: number
    entityType: 'character' | 'conflict' | 'foreshadow' | 'faction' | 'location' | 'world_element'
    entityId: string
  }
  before: { start: number; end: number }
  after: { start: number; end: number }
}

/** 撤销时根据 action.before 还是 after 恢复区间：撤销应用 before，重做应用 after */
export function rangeToRestore(action: EditAction, direction: 'undo' | 'redo'): { start: number; end: number } {
  return direction === 'undo' ? action.before : action.after
}

// ── 剃刀切分（A1）──

/** 将章节号数组按连续相邻分组为 [start,end] 跨度 */
export function groupContiguousSpans(chapters: number[]): Array<{ start: number; end: number }> {
  if (chapters.length === 0) return []
  const sorted = Array.from(new Set(chapters)).sort((a, b) => a - b)
  const spans: Array<{ start: number; end: number }> = []
  let cur = { start: sorted[0], end: sorted[0] }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === cur.end + 1) cur.end = sorted[i]
    else { spans.push(cur); cur = { start: sorted[i], end: sorted[i] } }
  }
  spans.push(cur)
  return spans
}

/** 规划切分：返回原 clip 的前半段 [start, atChapter-1] 与后半段 [atChapter, end] */
export function planClipSplit(
  origStart: number,
  origEnd: number,
  atChapter: number,
): { first: { start: number; end: number }; second: { start: number; end: number } | null } | null {
  if (atChapter <= origStart) return null
  if (atChapter > origEnd) return { first: { start: origStart, end: origEnd }, second: null }
  return {
    first: { start: origStart, end: atChapter - 1 },
    second: { start: atChapter, end: origEnd },
  }
}

/** Solo/Mute 互斥：solo 激活时仅 solo 轨道可闻；否则按 mute 判定 */
export function isTrackAudible(
  trackId: string,
  soloedTrack: string | null,
  mutedTracks: Set<string>,
): boolean {
  if (soloedTrack) return trackId === soloedTrack
  return !mutedTracks.has(trackId)
}

/** 多片段成组移动：对每个选中 clip 应用相同 delta，各自独立 clamp */
export function applyGroupMove(
  clips: Array<{ id: string; startChapter: number; endChapter: number }>,
  selectedIds: Set<string>,
  deltaChapters: number,
  maxChapter: number,
): Map<string, { start: number; end: number }> {
  const result = new Map<string, { start: number; end: number }>()
  for (const clip of clips) {
    if (!selectedIds.has(clip.id)) continue
    result.set(clip.id, clampMoveRange(clip.startChapter, clip.endChapter, deltaChapters, maxChapter))
  }
  return result
}

// ── 轨道高度（B4 折叠）──

export type TrackHeightLevel = 'compact' | 'standard' | 'spacious'

/** 计算轨道高度：折叠态固定 8px，否则按 level */
export function computeTrackHeight(level: TrackHeightLevel, collapsed: boolean): number {
  if (collapsed) return 8
  return level === 'compact' ? 28 : level === 'spacious' ? 56 : 36
}

// ── 涟漪删除（B1）──

/** 涟漪删除：计算同轨道被删 clip 之后的所有 clip 前移后的新区间 */
export function computeRippleShifts(
  sameTrackClips: Array<{ id: string; startChapter: number; endChapter: number }>,
  deletedClipId: string,
): Map<string, { start: number; end: number }> {
  const deleted = sameTrackClips.find((c) => c.id === deletedClipId)
  if (!deleted) return new Map()
  const duration = deleted.endChapter - deleted.startChapter + 1
  const result = new Map<string, { start: number; end: number }>()
  for (const clip of sameTrackClips) {
    if (clip.id === deletedClipId) continue
    if (clip.startChapter > deleted.endChapter) {
      result.set(clip.id, {
        start: clip.startChapter - duration,
        end: clip.endChapter - duration,
      })
    }
  }
  return result
}

/** 截断摘要：超长加省略号（省略号占 3 字符宽，总宽度不超过 maxLen） */
export function truncateSummary(text: string, maxLen: number): string {
  if (!text) return ''
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 3) + '…'
}

// ── 播放循环（B2 In/Out 标记）──

/** 计算播放循环边界：in/out 都存在且 in<=out 时返回 [in,out]，否则 null */
export function computeLoopBounds(
  inChapter: number | null,
  outChapter: number | null,
  maxChapter: number,
): { start: number; end: number } | null {
  if (inChapter == null || outChapter == null) return null
  if (inChapter > outChapter) return null
  return { start: inChapter, end: Math.min(outChapter, maxChapter) }
}
