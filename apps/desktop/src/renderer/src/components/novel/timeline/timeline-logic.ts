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

export type EditActionType = 'move' | 'delete' | 'paste' | 'cut'

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

/** 截断摘要：超长加省略号（省略号占 3 字符宽，总宽度不超过 maxLen） */
export function truncateSummary(text: string, maxLen: number): string {
  if (!text) return ''
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 3) + '…'
}
