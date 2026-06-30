/**
 * TimelineEditor：自研剪辑编辑器风格时间轴核心组件
 *
 * 核心交互：
 * - 框选多选：空白拖拽矩形 + 相交命中
 * - 滚轮缩放：Ctrl/Cmd + 滚轮，以鼠标为中心
 * - Solo/Mute：轨道独显/静音
 * - 性能虚拟化：仅渲染视口内章节
 * - 标记层 / 字数条 / 小地图 / 关系连线
 * - 悬停气泡 / 冲突热力图 / 弧光分段 / 伏笔回收链
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react'
import {
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Users,
  Swords,
  Lightbulb,
  Flag,
  MapPin,
  Globe,
  Layers,
  Volume2,
  VolumeX,
  type LucideIcon,
} from 'lucide-react'
import type { NovelChapter, NovelConflict, NovelRelationship, NovelFaction } from '@/api/novel-client'
import type { TimelineClip, TimelineTrack } from './use-timeline-data'
import { TimelineMarkers, type TimelineMarker } from './timeline-markers'
import { TimelineMinimap } from './timeline-minimap'
import { TimelineWordCountBar } from './timeline-word-count-bar'
import { TimelineRelationLayer } from './timeline-relation-layer'
import { applyGroupMove, clampMoveRange, computeTrackHeight, isTrackAudible, truncateSummary, type TrackHeightLevel } from './timeline-logic'

// ── 常量 ──

const HEADER_WIDTH = 180
const RULER_HEIGHT = 40
const CLIP_PADDING_Y = 4
const CLIP_GAP = 2
const DRAG_THRESHOLD = 3

const TRACK_ICON: Record<TimelineTrack['kind'], LucideIcon> = {
  character: Users,
  conflict: Swords,
  foreshadow: Lightbulb,
  faction: Flag,
  location: MapPin,
  world_element: Globe,
}

const TRACK_COLOR: Record<TimelineTrack['kind'], string> = {
  character: '#3b82f6',
  conflict: '#ef4444',
  foreshadow: '#f59e0b',
  faction: '#a855f7',
  location: '#06b6d4',
  world_element: '#6366f1',
}

// ── 工具函数 ──

function chapterToX(chapter: number, chapterWidth: number): number {
  return (chapter - 1) * chapterWidth
}

function xToChapter(x: number, chapterWidth: number): number {
  return Math.max(1, Math.floor(x / chapterWidth) + 1)
}

function assignSubRows(clips: TimelineClip[]): Map<string, number> {
  const sorted = [...clips].sort((a, b) => a.startChapter - b.startChapter)
  const subRowEnds: number[] = []
  const result = new Map<string, number>()
  for (const clip of sorted) {
    let assigned = false
    for (let i = 0; i < subRowEnds.length; i++) {
      if (subRowEnds[i] < clip.startChapter) {
        subRowEnds[i] = clip.endChapter
        result.set(clip.id, i)
        assigned = true
        break
      }
    }
    if (!assigned) {
      subRowEnds.push(clip.endChapter)
      result.set(clip.id, subRowEnds.length - 1)
    }
  }
  return result
}

// ── 拖拽状态 ──

interface DragState {
  type: 'move'
  clipId: string
  startMouseX: number
  origStart: number
  origEnd: number
  started: boolean
}

interface PlayheadDragState {
  startMouseX: number
  origChapter: number
}

interface MarqueeState {
  startX: number
  startY: number
  currentX: number
  currentY: number
  additive: boolean
}

/** 悬停气泡数据 */
interface HoverBubble {
  clip: TimelineClip
  x: number
  y: number
}

// ── Props ──

export interface TimelineEditorProps {
  tracks: TimelineTrack[]
  chapters: NovelChapter[]
  relationships?: NovelRelationship[]
  conflicts?: NovelConflict[]
  factions?: NovelFaction[]
  markers?: TimelineMarker[]
  playheadChapter: number
  chapterWidth: number
  maxChapter: number
  creatingChapter?: number
  selectedClipIds?: Set<string>
  showPlayhead?: boolean
  dropIndicatorChapter?: number | null
  trackHeightLevel?: TrackHeightLevel
  /** 显示小说特化可视化 */
  showWordCount?: boolean
  showMinimap?: boolean
  showRelations?: boolean
  showMarkers?: boolean
  onSelectEntity?: (entityType: TimelineClip['entityType'], entityId: string) => void
  onPlayheadChange?: (chapter: number) => void
  onClipMove?: (clip: TimelineClip, newStart: number, newEnd: number) => void
  onClipDelete?: (clipId: string) => void
  onContextMenuChapter?: (chapter: number, x: number, y: number) => void
  onContextMenuClip?: (clip: TimelineClip, x: number, y: number) => void
  onContextMenuTrack?: (track: TimelineTrack, x: number, y: number) => void
  onContextMenuEmpty?: (x: number, y: number) => void
  onContextMenuMarker?: (marker: TimelineMarker, x: number, y: number) => void
  onMarkerMove?: (marker: TimelineMarker, newChapter: number) => void
  onMarkerCreate?: (chapter: number, x: number, y: number) => void
  onMarkerEdit?: (marker: TimelineMarker) => void
  onClipDoubleClick?: (clip: TimelineClip, x: number, y: number) => void
  onSelectClipsChange?: (clipIds: Set<string>) => void
  onChapterWidthChange?: (width: number) => void
  /** 轨道可见性集合（受控；不传则使用组件内部 state） */
  hiddenTracks?: Set<string>
  /** 轨道锁定集合（受控；不传则使用组件内部 state） */
  lockedTracks?: Set<string>
  /** 独显轨道 ID（受控；不传则使用组件内部 state） */
  soloedTrack?: string | null
  /** 静音轨道集合（受控；不传则使用组件内部 state） */
  mutedTracks?: Set<string>
  /** 折叠轨道集合（受控；不传则使用组件内部 state）。折叠态高度=8px，仅显示色条占位 */
  collapsedTracks?: Set<string>
  onToggleTrackVisible?: (trackId: string) => void
  onToggleTrackLock?: (trackId: string) => void
  onToggleTrackMute?: (trackId: string) => void
  onToggleTrackSolo?: (trackId: string) => void
  onToggleTrackCollapse?: (trackId: string) => void
}

// ── 主组件 ──

export function TimelineEditor({
  tracks,
  chapters,
  relationships = [],
  conflicts = [],
  factions = [],
  markers = [],
  playheadChapter,
  chapterWidth,
  maxChapter,
  creatingChapter,
  selectedClipIds,
  showPlayhead = true,
  dropIndicatorChapter,
  trackHeightLevel = 'standard',
  showWordCount = true,
  showMinimap = true,
  showRelations = false,
  showMarkers = true,
  onSelectEntity,
  onPlayheadChange,
  onClipMove,
  onContextMenuChapter,
  onContextMenuClip,
  onContextMenuTrack,
  onContextMenuEmpty,
  onContextMenuMarker,
  onMarkerMove,
  onMarkerCreate,
  onMarkerEdit,
  onClipDoubleClick,
  onSelectClipsChange,
  onChapterWidthChange,
  hiddenTracks: propHiddenTracks,
  lockedTracks: propLockedTracks,
  soloedTrack: propSoloedTrack,
  mutedTracks: propMutedTracks,
  collapsedTracks: propCollapsedTracks,
  onToggleTrackVisible,
  onToggleTrackLock,
  onToggleTrackMute,
  onToggleTrackSolo,
  onToggleTrackCollapse,
}: TimelineEditorProps): ReactElement {
  const rulerViewportRef = useRef<HTMLDivElement | null>(null)
  const markersViewportRef = useRef<HTMLDivElement | null>(null)
  const wordCountViewportRef = useRef<HTMLDivElement | null>(null)
  const trackViewportRef = useRef<HTMLDivElement | null>(null)
  const headerColumnRef = useRef<HTMLDivElement | null>(null)
  const [dragState, setDragState] = useState<DragState | null>(null)
  const [playheadDrag, setPlayheadDrag] = useState<PlayheadDragState | null>(null)
  const [marquee, setMarquee] = useState<MarqueeState | null>(null)
  // 轨道状态：受控/非受控兼容。父组件传 prop 时优先使用 prop；否则回退到内部 state。
  const [internalHidden, setInternalHidden] = useState<Set<string>>(new Set())
  const [internalLocked, setInternalLocked] = useState<Set<string>>(new Set())
  const [internalSoloed, setInternalSoloed] = useState<string | null>(null)
  const [internalMuted, setInternalMuted] = useState<Set<string>>(new Set())
  const [internalCollapsed, setInternalCollapsed] = useState<Set<string>>(new Set())
  const hiddenTracks = propHiddenTracks ?? internalHidden
  const lockedTracks = propLockedTracks ?? internalLocked
  const soloedTrack = propSoloedTrack ?? internalSoloed
  const mutedTracks = propMutedTracks ?? internalMuted
  const collapsedTracks = propCollapsedTracks ?? internalCollapsed
  const [hoveredClipId, setHoveredClipId] = useState<string | null>(null)
  const [hoverBubble, setHoverBubble] = useState<HoverBubble | null>(null)
  const [viewportState, setViewportState] = useState({ scrollLeft: 0, clientWidth: 0 })

  const pendingClipUpdateRef = useRef<{ clipId: string; start: number; end: number } | null>(null)
  const [pendingClipUpdate, setPendingClipUpdate] = useState<{ clipId: string; start: number; end: number } | null>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [internalSelected, setInternalSelected] = useState<Set<string>>(new Set())
  const selectedSet = selectedClipIds ?? internalSelected

  // 轨道高度：折叠态 8px，否则按 level。baseTrackHeight 用于与单轨道无关的全局度量（如关系层定位）。
  const baseTrackHeight = computeTrackHeight(trackHeightLevel, false)
  const getTrackHeight = useCallback((trackId: string): number => {
    return collapsedTracks.has(trackId) ? 8 : baseTrackHeight
  }, [collapsedTracks, baseTrackHeight])

  const updateSelection = useCallback((ids: Set<string>) => {
    if (onSelectClipsChange) onSelectClipsChange(ids)
    else setInternalSelected(ids)
  }, [onSelectClipsChange])

  const chapterTitleMap = useMemo(() => {
    const map = new Map<number, string>()
    for (const c of chapters) map.set(c.chapterNumber, c.title)
    return map
  }, [chapters])

  const subRowMaps = useMemo(() => {
    const maps = new Map<string, Map<string, number>>()
    for (const track of tracks) maps.set(track.id, assignSubRows(track.clips))
    return maps
  }, [tracks])

  const subRowCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const track of tracks) {
      const subRows = subRowMaps.get(track.id)
      let max = 0
      if (subRows) for (const idx of subRows.values()) if (idx + 1 > max) max = idx + 1
      counts.set(track.id, Math.max(1, max))
    }
    return counts
  }, [tracks, subRowMaps])

  const totalWidth = Math.max(maxChapter * chapterWidth, 200)
  const totalContentHeight = tracks.reduce((sum, t) => sum + getTrackHeight(t.id), 0)

  const allClips = useMemo(() => tracks.flatMap((t) => t.clips), [tracks])

  // ── 性能虚拟化：仅渲染视口内章节 ──
  const visibleChapterRange = useMemo(() => {
    const scrollLeft = viewportState.scrollLeft
    const clientWidth = viewportState.clientWidth || 800
    const start = Math.max(1, Math.floor(scrollLeft / chapterWidth) - 2)
    const end = Math.min(maxChapter, Math.ceil((scrollLeft + clientWidth) / chapterWidth) + 2)
    return { start, end }
  }, [viewportState, chapterWidth, maxChapter])

  // ── 坐标转换 ──
  const getRelativeX = useCallback((clientX: number): number => {
    const el = trackViewportRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    return clientX - rect.left + el.scrollLeft
  }, [])

  // ── 播放头拖动 ──
  const handlePlayheadMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setPlayheadDrag({ startMouseX: e.clientX, origChapter: playheadChapter })
  }, [playheadChapter])

  const handleRulerClick = useCallback((e: React.MouseEvent) => {
    const relX = getRelativeX(e.clientX)
    const chapter = xToChapter(relX, chapterWidth)
    onPlayheadChange?.(chapter)
  }, [getRelativeX, chapterWidth, onPlayheadChange])

  const handleRulerContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const relX = getRelativeX(e.clientX)
    const chapter = xToChapter(relX, chapterWidth)
    onContextMenuChapter?.(chapter, e.clientX, e.clientY)
  }, [getRelativeX, chapterWidth, onContextMenuChapter])

  // 双击标尺：创建标记
  const handleRulerDoubleClick = useCallback((e: React.MouseEvent) => {
    if (!onMarkerCreate) return
    e.preventDefault()
    e.stopPropagation()
    const relX = getRelativeX(e.clientX)
    const chapter = xToChapter(relX, chapterWidth)
    onMarkerCreate(chapter, e.clientX, e.clientY)
  }, [getRelativeX, chapterWidth, onMarkerCreate])

  // ── 命中测试 ──
  const findClipAtPos = useCallback((clientX: number, clientY: number): TimelineClip | null => {
    const el = trackViewportRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const relX = clientX - rect.left + el.scrollLeft
    const relY = clientY - rect.top + el.scrollTop
    // 轨道高度可变（折叠态 8px），需累计高度定位轨道
    let trackTop = 0
    let track: TimelineTrack | null = null
    for (const t of tracks) {
      const h = getTrackHeight(t.id)
      if (relY >= trackTop && relY < trackTop + h) {
        track = t
        break
      }
      trackTop += h
    }
    if (!track) return null
    // 折叠轨道无 clip 渲染，命中返回 null
    if (collapsedTracks.has(track.id)) return null
    const trackHeightForTrack = getTrackHeight(track.id)
    const subRowMap = subRowMaps.get(track.id)
    const subRows = subRowCounts.get(track.id) ?? 1
    const availableHeight = trackHeightForTrack - CLIP_PADDING_Y * 2
    const clipHeight = subRows > 1
      ? Math.floor((availableHeight - (subRows - 1) * CLIP_GAP) / subRows)
      : availableHeight
    const yInTrack = relY - trackTop
    for (const clip of track.clips) {
      const subRow = subRowMap?.get(clip.id) ?? 0
      const clipTop = CLIP_PADDING_Y + subRow * (clipHeight + CLIP_GAP)
      const clipLeft = chapterToX(clip.startChapter, chapterWidth)
      const clipWidth = Math.max(chapterWidth, (clip.endChapter - clip.startChapter + 1) * chapterWidth)
      if (relX >= clipLeft && relX <= clipLeft + clipWidth &&
          yInTrack >= clipTop && yInTrack <= clipTop + clipHeight) {
        return clip
      }
    }
    return null
  }, [tracks, subRowMaps, subRowCounts, chapterWidth, getTrackHeight, collapsedTracks])

  // ── 片段拖拽 ──
  const handleClipMouseDown = useCallback((
    e: React.MouseEvent,
    clip: TimelineClip,
    type: 'move',
  ) => {
    const track = tracks.find((t) => t.clips.some((c) => c.id === clip.id))
    if (track && lockedTracks.has(track.id)) return

    e.preventDefault()
    e.stopPropagation()

    if (!e.ctrlKey && !e.metaKey && !selectedSet.has(clip.id)) {
      updateSelection(new Set([clip.id]))
    }
    onSelectEntity?.(clip.entityType, clip.entityId)

    setDragState({
      type,
      clipId: clip.id,
      startMouseX: e.clientX,
      origStart: clip.startChapter,
      origEnd: clip.endChapter,
      started: false,
    })
  }, [tracks, lockedTracks, selectedSet, updateSelection, onSelectEntity])

  // ── 空白区域 mousedown ──
  const handleTrackAreaMouseDown = useCallback((e: React.MouseEvent) => {
    const clip = findClipAtPos(e.clientX, e.clientY)
    if (clip) return

    e.preventDefault()
    const vp = trackViewportRef.current
    if (!vp) return
    const rect = vp.getBoundingClientRect()
    const relX = e.clientX - rect.left + vp.scrollLeft
    const relY = e.clientY - rect.top + vp.scrollTop
    setMarquee({
      startX: relX,
      startY: relY,
      currentX: relX,
      currentY: relY,
      additive: e.shiftKey,
    })
    if (!e.shiftKey) updateSelection(new Set())
  }, [findClipAtPos, updateSelection])

  // ── 全局鼠标事件 ──
  useEffect(() => {
    if (!dragState && !playheadDrag && !marquee) return

    const handleMouseMove = (e: MouseEvent): void => {
      if (marquee) {
        const vp = trackViewportRef.current
        if (!vp) return
        const rect = vp.getBoundingClientRect()
        const relX = e.clientX - rect.left + vp.scrollLeft
        const relY = e.clientY - rect.top + vp.scrollTop
        setMarquee({ ...marquee, currentX: relX, currentY: relY })
        const minX = Math.min(marquee.startX, relX)
        const maxX = Math.max(marquee.startX, relX)
        const minY = Math.min(marquee.startY, relY)
        const maxY = Math.max(marquee.startY, relY)
        const hitIds = new Set<string>(marquee.additive ? selectedSet : [])
        let trackTopAcc = 0
        tracks.forEach((track) => {
          const h = getTrackHeight(track.id)
          const trackTop = trackTopAcc
          const trackBottom = trackTop + h
          trackTopAcc = trackBottom
          if (trackBottom < minY || trackTop > maxY) return
          // 折叠轨道无 clip 渲染，跳过
          if (collapsedTracks.has(track.id)) return
          for (const clip of track.clips) {
            const clipLeft = chapterToX(clip.startChapter, chapterWidth)
            const clipRight = chapterToX(clip.endChapter, chapterWidth) + chapterWidth
            if (clipRight >= minX && clipLeft <= maxX) {
              hitIds.add(clip.id)
            }
          }
        })
        updateSelection(hitIds)
        return
      }

      if (playheadDrag) {
        const deltaX = e.clientX - playheadDrag.startMouseX
        const deltaChapters = Math.round(deltaX / chapterWidth)
        const newChapter = Math.max(1, Math.min(maxChapter, playheadDrag.origChapter + deltaChapters))
        onPlayheadChange?.(newChapter)
        return
      }

      if (!dragState) return
      const clip = allClips.find((c) => c.id === dragState.clipId)
      if (!clip) return

      if (!dragState.started) {
        const totalDelta = Math.abs(e.clientX - dragState.startMouseX)
        if (totalDelta < DRAG_THRESHOLD) return
        setDragState({ ...dragState, started: true })
      }

      const deltaX = e.clientX - dragState.startMouseX
      const deltaChapters = Math.round(deltaX / chapterWidth)

      const r = clampMoveRange(dragState.origStart, dragState.origEnd, deltaChapters, maxChapter)
      const newStart = r.start
      const newEnd = r.end

      const update = { clipId: clip.id, start: newStart, end: newEnd }
      pendingClipUpdateRef.current = update
      setPendingClipUpdate(update)
    }

    const handleMouseUp = (): void => {
      if (marquee) { setMarquee(null); return }
      if (playheadDrag) { setPlayheadDrag(null); return }
      if (dragState) {
        const clip = allClips.find((c) => c.id === dragState.clipId)
        const pending = pendingClipUpdateRef.current
        if (clip && pending && dragState.started) {
          // 多片段成组移动（B3）：松开时对组内其他 clip 一次性应用 delta，避免拖动中频繁写库
          if (selectedSet.size > 1 && selectedSet.has(clip.id)) {
            const delta = pending.start - dragState.origStart
            const group = applyGroupMove(allClips, selectedSet, delta, maxChapter)
            group.forEach((range, id) => {
              const c = allClips.find((x) => x.id === id)
              if (c) onClipMove?.(c, range.start, range.end)
            })
          } else {
            onClipMove?.(clip, pending.start, pending.end)
          }
        }
        pendingClipUpdateRef.current = null
        setDragState(null)
        setPendingClipUpdate(null)
      }
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [dragState, playheadDrag, marquee, tracks, allClips, chapterWidth, getTrackHeight, collapsedTracks, maxChapter, onPlayheadChange, onClipMove, updateSelection, selectedSet])

  const getClipDisplayRange = useCallback((clip: TimelineClip): { start: number; end: number } => {
    if (pendingClipUpdate && pendingClipUpdate.clipId === clip.id) {
      return { start: pendingClipUpdate.start, end: pendingClipUpdate.end }
    }
    return { start: clip.startChapter, end: clip.endChapter }
  }, [pendingClipUpdate])

  // ── 轨道头部控件 ──
  // 受控/非受控兼容：父组件传入回调时优先调用，由父组件维护状态；否则回退到内部 state。
  const toggleTrackVisible = useCallback((trackId: string) => {
    if (onToggleTrackVisible) { onToggleTrackVisible(trackId); return }
    setInternalHidden((prev) => {
      const next = new Set(prev)
      if (next.has(trackId)) next.delete(trackId)
      else next.add(trackId)
      return next
    })
  }, [onToggleTrackVisible])

  const toggleTrackLock = useCallback((trackId: string) => {
    if (onToggleTrackLock) { onToggleTrackLock(trackId); return }
    setInternalLocked((prev) => {
      const next = new Set(prev)
      if (next.has(trackId)) next.delete(trackId)
      else next.add(trackId)
      return next
    })
  }, [onToggleTrackLock])

  const toggleTrackMute = useCallback((trackId: string) => {
    if (onToggleTrackMute) { onToggleTrackMute(trackId); return }
    setInternalMuted((prev) => {
      const next = new Set(prev)
      if (next.has(trackId)) next.delete(trackId)
      else next.add(trackId)
      return next
    })
  }, [onToggleTrackMute])

  const toggleTrackSolo = useCallback((trackId: string) => {
    if (onToggleTrackSolo) { onToggleTrackSolo(trackId); return }
    setInternalSoloed((prev) => (prev === trackId ? null : trackId))
  }, [onToggleTrackSolo])

  const toggleTrackCollapse = useCallback((trackId: string) => {
    if (onToggleTrackCollapse) { onToggleTrackCollapse(trackId); return }
    setInternalCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(trackId)) next.delete(trackId)
      else next.add(trackId)
      return next
    })
  }, [onToggleTrackCollapse])

  // ── 滚动同步 ──
  const handleTrackScroll = useCallback((e: React.UIEvent<HTMLDivElement>): void => {
    const target = e.currentTarget
    const ruler = rulerViewportRef.current
    if (ruler) ruler.scrollLeft = target.scrollLeft
    const markers = markersViewportRef.current
    if (markers) markers.scrollLeft = target.scrollLeft
    const wc = wordCountViewportRef.current
    if (wc) wc.scrollLeft = target.scrollLeft
    const header = headerColumnRef.current
    if (header) header.scrollTop = target.scrollTop
    setViewportState({ scrollLeft: target.scrollLeft, clientWidth: target.clientWidth })
  }, [])

  // 初始化 viewportState
  useEffect(() => {
    const vp = trackViewportRef.current
    if (vp) {
      setViewportState({ scrollLeft: vp.scrollLeft, clientWidth: vp.clientWidth })
    }
  }, [])

  // ── 滚轮缩放 ──
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return
    if (!onChapterWidthChange) return
    e.preventDefault()
    const vp = trackViewportRef.current
    if (!vp) return
    const rect = vp.getBoundingClientRect()
    const mouseX = e.clientX - rect.left
    const mouseChapter = (mouseX + vp.scrollLeft) / chapterWidth
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    const newWidth = Math.max(30, Math.min(400, Math.round(chapterWidth * delta)))
    if (newWidth === chapterWidth) return
    onChapterWidthChange(newWidth)
    requestAnimationFrame(() => {
      const newScrollLeft = mouseChapter * newWidth - mouseX
      vp.scrollLeft = Math.max(0, newScrollLeft)
    })
  }, [chapterWidth, onChapterWidthChange])

  // ── 悬停气泡（延迟 500ms）──
  const handleClipMouseEnter = useCallback((clip: TimelineClip, e: React.MouseEvent) => {
    setHoveredClipId(clip.id)
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = setTimeout(() => {
      setHoverBubble({ clip, x: e.clientX, y: e.clientY })
    }, 500)
  }, [])

  const handleClipMouseLeave = useCallback(() => {
    setHoveredClipId(null)
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
    setHoverBubble(null)
  }, [])

  // 卸载时清理悬停定时器（A8）：避免组件卸载后 setTimeout 仍触发 setState 导致内存泄漏与告警
  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current)
        hoverTimerRef.current = null
      }
    }
  }, [])

  const playheadX = chapterToX(playheadChapter, chapterWidth) + chapterWidth / 2
  const dropIndicatorX = dropIndicatorChapter != null
    ? chapterToX(dropIndicatorChapter, chapterWidth) + chapterWidth / 2
    : null

  const isEmpty = tracks.length === 0

  // 计算小地图视口参数
  const viewportVisibleChapters = Math.max(1, Math.ceil((viewportState.clientWidth || 800) / chapterWidth))
  const viewportStartChapter = Math.max(1, Math.floor(viewportState.scrollLeft / chapterWidth) + 1)

  // 判断轨道是否因 solo 而淡化
  const isTrackDimmed = useCallback((trackId: string): boolean => {
    return !isTrackAudible(trackId, soloedTrack, mutedTracks)
  }, [soloedTrack, mutedTracks])

  // 获取冲突强度（从 conflicts 数据中查找）
  const getConflictIntensity = useCallback((clip: TimelineClip): number => {
    const conflict = conflicts.find((c) => c.id === clip.entityId)
    if (!conflict) return 0
    const intensity = Number(conflict.intensity)
    return Number.isFinite(intensity) ? Math.max(0, Math.min(10, intensity)) : 5
  }, [conflicts])

  return (
    <div className="tl-editor-root">
      {/* ── 顶部：标尺 ── */}
      <div className="tl-header-row" style={{ height: RULER_HEIGHT }}>
        <div className="tl-header-corner" style={{ width: HEADER_WIDTH, minWidth: HEADER_WIDTH }}>
          <span className="tl-header-corner-text">轨道</span>
        </div>
        <div
          className="tl-ruler-viewport"
          ref={rulerViewportRef}
          onScroll={(e) => {
            const trackScroll = trackViewportRef.current
            if (trackScroll) trackScroll.scrollLeft = e.currentTarget.scrollLeft
          }}
        >
          <div
            className="tl-ruler-content"
            style={{ width: totalWidth, minWidth: '100%' }}
            onClick={handleRulerClick}
            onDoubleClick={handleRulerDoubleClick}
            onContextMenu={handleRulerContextMenu}
          >
            {Array.from({ length: maxChapter }, (_, i) => i + 1)
              .filter((ch) => ch >= visibleChapterRange.start && ch <= visibleChapterRange.end)
              .map((ch) => {
                const title = chapterTitleMap.get(ch)
                const isCreating = creatingChapter === ch
                const isCurrent = playheadChapter === ch && showPlayhead
                const summary = chapterWidth >= 280 && title ? truncateSummary(title, 20) : ''
                return (
                  <div
                    key={ch}
                    className={`tl-ruler-tick ${isCreating ? 'is-creating' : ''} ${isCurrent ? 'is-current' : ''}`}
                    style={{ width: chapterWidth, minWidth: chapterWidth }}
                    title={title ? `第 ${ch} 章 · ${title}` : `第 ${ch} 章`}
                  >
                    <span className="tl-ruler-tick-num">{ch}</span>
                    {chapterWidth >= 120 && title && (
                      <span className="tl-ruler-tick-title">{title}</span>
                    )}
                    {summary && (
                      <span className="tl-ruler-tick-summary">{summary}</span>
                    )}
                  </div>
                )
              })}
            {showPlayhead && (
              <div
                className={`tl-playhead-handle ${playheadDrag ? 'is-dragging' : ''}`}
                style={{ left: playheadX }}
                onMouseDown={handlePlayheadMouseDown}
                title={`第 ${playheadChapter} 章`}
              >
                <div className="tl-playhead-triangle" />
                {playheadDrag && (
                  <div className="tl-playhead-tooltip">第 {playheadChapter} 章</div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── 标记层 ── */}
      {showMarkers && (
        <div className="tl-markers-row" style={{ marginLeft: HEADER_WIDTH }}>
          <div className="tl-markers-viewport" ref={markersViewportRef}>
            <TimelineMarkers
              markers={markers}
              chapterWidth={chapterWidth}
              maxChapter={maxChapter}
              playheadChapter={playheadChapter}
              totalWidth={totalWidth}
              onMarkerClick={(m) => onPlayheadChange?.(m.chapter)}
              onMarkerMove={onMarkerMove}
              onMarkerContextMenu={onContextMenuMarker}
              onMarkerDoubleClick={onMarkerEdit}
            />
          </div>
        </div>
      )}

      {/* ── 主体 ── */}
      <div className="tl-body">
        {/* 左侧头部列 */}
        <div
          className="tl-header-column"
          ref={headerColumnRef}
          style={{ width: HEADER_WIDTH, minWidth: HEADER_WIDTH }}
        >
          {tracks.map((track) => {
            const Icon = TRACK_ICON[track.kind]
            const color = TRACK_COLOR[track.kind]
            const isHidden = hiddenTracks.has(track.id)
            const isLocked = lockedTracks.has(track.id)
            const isMuted = mutedTracks.has(track.id)
            const isSoloed = soloedTrack === track.id
            const isCollapsed = collapsedTracks.has(track.id)
            const subRows = subRowCounts.get(track.id) ?? 1
            const isEmptyTrack = track.clips.length === 0
            const isDimmed = isTrackDimmed(track.id)
            return (
              <div
                key={track.id}
                className={`tl-track-header ${isHidden ? 'is-hidden' : ''} ${isEmptyTrack ? 'is-empty-track' : ''} ${isDimmed ? 'is-dimmed' : ''} ${isSoloed ? 'is-soloed' : ''} ${isCollapsed ? 'is-collapsed' : ''}`}
                style={{ height: getTrackHeight(track.id) }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onContextMenuTrack?.(track, e.clientX, e.clientY)
                }}
              >
                <Icon className="tl-track-header-icon" size={14} style={{ color }} />
                <div className="tl-track-header-label">
                  <span className="tl-track-header-name">{track.label}</span>
                  {track.subLabel && (
                    <span className="tl-track-header-sub">{track.subLabel}</span>
                  )}
                </div>
                {subRows > 1 && (
                  <span className="tl-track-header-badge" title={`${subRows} 个重叠片段`}>
                    <Layers size={10} />
                  </span>
                )}
                <div className="tl-track-header-actions">
                  <button
                    type="button"
                    className={`tl-track-header-btn ${isSoloed ? 'is-active' : ''}`}
                    onClick={() => toggleTrackSolo(track.id)}
                    title={isSoloed ? '取消独显' : '独显此轨道'}
                  >
                    <Volume2 size={12} />
                  </button>
                  <button
                    type="button"
                    className={`tl-track-header-btn ${isMuted ? 'is-active' : ''}`}
                    onClick={() => toggleTrackMute(track.id)}
                    title={isMuted ? '取消静音' : '静音此轨道'}
                  >
                    {isMuted ? <VolumeX size={12} /> : <Volume2 size={12} />}
                  </button>
                  <button
                    type="button"
                    className="tl-track-header-btn"
                    onClick={() => toggleTrackVisible(track.id)}
                    title={isHidden ? '显示轨道' : '隐藏轨道'}
                  >
                    {isHidden ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                  <button
                    type="button"
                    className="tl-track-header-btn"
                    onClick={() => toggleTrackLock(track.id)}
                    title={isLocked ? '解锁轨道' : '锁定轨道'}
                  >
                    {isLocked ? <Lock size={12} /> : <Unlock size={12} />}
                  </button>
                  <button
                    type="button"
                    className="tl-track-header-btn"
                    onClick={() => toggleTrackCollapse(track.id)}
                    title={isCollapsed ? '展开轨道' : '折叠轨道'}
                  >
                    {isCollapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
                  </button>
                </div>
              </div>
            )
          })}
          {tracks.length === 0 && <div className="tl-header-empty">暂无轨道</div>}
        </div>

        {/* 右侧轨道区域 */}
        <div
          className="tl-tracks-viewport"
          ref={trackViewportRef}
          onScroll={handleTrackScroll}
          onWheel={handleWheel}
          onMouseDown={handleTrackAreaMouseDown}
          onContextMenu={(e) => {
            const clip = findClipAtPos(e.clientX, e.clientY)
            if (!clip) {
              e.preventDefault()
              onContextMenuEmpty?.(e.clientX, e.clientY)
            }
          }}
        >
          <div
            className="tl-tracks-content"
            style={{ width: totalWidth, minWidth: '100%', position: 'relative', minHeight: '100%' }}
          >
            {isEmpty ? (
              <div className="tl-empty-state">
                <Layers size={32} className="tl-empty-icon" />
                <div className="tl-empty-title">暂无轨道数据</div>
                <div className="tl-empty-desc">
                  从左侧元素池拖入角色、冲突、伏笔等元素到时间轴
                </div>
              </div>
            ) : (
              <>
                {tracks.map((track, idx) => {
                  const isHidden = hiddenTracks.has(track.id)
                  const isMuted = mutedTracks.has(track.id)
                  const isDimmed = isTrackDimmed(track.id)
                  const isCollapsed = collapsedTracks.has(track.id)
                  const trackHeightForTrack = getTrackHeight(track.id)
                  const subRows = subRowCounts.get(track.id) ?? 1
                  const subRowMap = subRowMaps.get(track.id)
                  const availableHeight = trackHeightForTrack - CLIP_PADDING_Y * 2
                  const clipHeight = subRows > 1
                    ? Math.floor((availableHeight - (subRows - 1) * CLIP_GAP) / subRows)
                    : availableHeight
                  return (
                    <div
                      key={track.id}
                      className={`tl-track-row ${isHidden ? 'is-hidden' : ''} ${isMuted ? 'is-muted' : ''} ${isDimmed ? 'is-dimmed' : ''} ${isCollapsed ? 'is-collapsed' : ''}`}
                      style={{
                        height: trackHeightForTrack,
                        borderBottom: idx < tracks.length - 1 ? '1px solid var(--tl-border)' : 'none',
                      }}
                    >
                      {/* 网格线（仅视口内）*/}
                      {Array.from({ length: maxChapter + 1 }, (_, i) => i)
                        .filter((ch) => ch === 0 || (ch >= visibleChapterRange.start && ch <= visibleChapterRange.end + 1))
                        .map((ch) => (
                          <div
                            key={ch}
                            className={`tl-grid-line ${playheadChapter === ch && ch > 0 ? 'is-current' : ''}`}
                            style={{ left: ch * chapterWidth }}
                          />
                        ))}
                      {!isHidden && !isCollapsed && track.clips
                        .filter((clip) => {
                          // 虚拟化：仅渲染视口内 clip
                          const range = getClipDisplayRange(clip)
                          return range.end >= visibleChapterRange.start && range.start <= visibleChapterRange.end
                        })
                        .map((clip) => {
                        const range = getClipDisplayRange(clip)
                        const left = chapterToX(range.start, chapterWidth) + 2
                        const width = Math.max(chapterWidth - 4, (range.end - range.start + 1) * chapterWidth - 4)
                        const isSelected = selectedSet.has(clip.id)
                        const isHovered = hoveredClipId === clip.id
                        const isDragging = dragState?.clipId === clip.id && dragState.started
                        const isCompact = width < 60
                        const subRow = subRowMap?.get(clip.id) ?? 0
                        const top = CLIP_PADDING_Y + subRow * (clipHeight + CLIP_GAP)
                        // 冲突热力图：按强度调整透明度
                        const intensity = clip.entityType === 'conflict' ? getConflictIntensity(clip) : 0
                        const heatOpacity = intensity > 0 ? 0.3 + (intensity / 10) * 0.6 : 1
                        // 伏笔回收链：端点标记
                        const isForeshadowResolved = clip.effectId === 'foreshadow-resolved'
                        const isForeshadowPending = clip.effectId === 'foreshadow-pending'
                        return (
                          <div
                            key={clip.id}
                            className={`tl-clip tl-clip-${clip.effectId} ${isSelected ? 'is-selected' : ''} ${isHovered ? 'is-hovered' : ''} ${isDragging ? 'is-dragging' : ''} ${isCompact ? 'is-compact' : ''}`}
                            style={{ left, width, top, height: clipHeight, opacity: heatOpacity }}
                            onMouseDown={(e) => handleClipMouseDown(e, clip, 'move')}
                            onClick={(e) => {
                              e.stopPropagation()
                              if (e.ctrlKey || e.metaKey) {
                                const next = new Set(selectedSet)
                                if (next.has(clip.id)) next.delete(clip.id)
                                else next.add(clip.id)
                                updateSelection(next)
                              } else if (!selectedSet.has(clip.id)) {
                                updateSelection(new Set([clip.id]))
                              }
                              onSelectEntity?.(clip.entityType, clip.entityId)
                            }}
                            onDoubleClick={(e) => {
                              e.stopPropagation()
                              onClipDoubleClick?.(clip, e.clientX, e.clientY)
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              if (!selectedSet.has(clip.id)) {
                                updateSelection(new Set([clip.id]))
                              }
                              onContextMenuClip?.(clip, e.clientX, e.clientY)
                            }}
                            onMouseEnter={(e) => handleClipMouseEnter(clip, e)}
                            onMouseLeave={handleClipMouseLeave}
                            title={`${clip.label}（第 ${range.start}-${range.end} 章）`}
                          >
                            {/* 伏笔埋下锚点 */}
                            {isForeshadowPending && (
                              <div className="tl-clip-anchor tl-clip-anchor-left" title="埋下" />
                            )}
                            {isForeshadowResolved && (
                              <div className="tl-clip-anchor tl-clip-anchor-right" title="已回收" />
                            )}
                            <div className="tl-clip-content">
                              <span className="tl-clip-label">{clip.label}</span>
                              {clip.tag && !isCompact && (
                                <span className="tl-clip-tag">{clip.tag}</span>
                              )}
                              {/* 冲突强度显示 */}
                              {clip.entityType === 'conflict' && intensity > 0 && !isCompact && (
                                <span className="tl-clip-intensity">{intensity}/10</span>
                              )}
                              {/* 片段批注角标 */}
                              {clip.note && (
                                <span className="tl-clip-note-badge" title={clip.note}>
                                  批注
                                </span>
                              )}
                            </div>
                          </div>
                        )
                      })}
                      {/* 折叠态：仅显示头部色条占位，不渲染 clip */}
                      {isCollapsed && (
                        <div
                          className="tl-track-collapse-bar"
                          style={{ background: TRACK_COLOR[track.kind], height: 2, position: 'absolute', left: 0, right: 0, top: 3 }}
                        />
                      )}
                    </div>
                  )
                })}

                {/* 播放头竖线 */}
                {showPlayhead && (
                  <div
                    className={`tl-playhead-line ${playheadDrag ? 'is-dragging' : ''} ${creatingChapter != null ? 'is-creating' : ''}`}
                    style={{ left: playheadX, height: totalContentHeight, top: 0 }}
                  />
                )}

                {/* 关系连线层（覆盖整个 tracks-content） */}
                {showRelations && (
                  <TimelineRelationLayer
                    tracks={tracks}
                    relationships={relationships}
                    factions={factions}
                    chapterWidth={chapterWidth}
                    trackHeight={baseTrackHeight}
                    maxChapter={maxChapter}
                  />
                )}

                {/* 拖入指示线 */}
                {dropIndicatorX != null && (
                  <div className="tl-drop-indicator" style={{ left: dropIndicatorX, height: totalContentHeight }}>
                    <div className="tl-drop-indicator-label">第 {dropIndicatorChapter} 章</div>
                  </div>
                )}

                {/* 框选矩形 */}
                {marquee && (
                  <div
                    className="tl-marquee"
                    style={{
                      left: Math.min(marquee.startX, marquee.currentX),
                      top: Math.min(marquee.startY, marquee.currentY),
                      width: Math.abs(marquee.currentX - marquee.startX),
                      height: Math.abs(marquee.currentY - marquee.startY),
                    }}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── 字数条形图 ── */}
      {showWordCount && chapters.length > 0 && (
        <div className="tl-word-count-row" style={{ marginLeft: HEADER_WIDTH }}>
          <div className="tl-word-count-viewport" ref={wordCountViewportRef}>
            <TimelineWordCountBar
              chapters={chapters}
              chapterWidth={chapterWidth}
              maxChapter={maxChapter}
              playheadChapter={playheadChapter}
              totalWidth={totalWidth}
              onChapterClick={onPlayheadChange}
            />
          </div>
        </div>
      )}

      {/* ── 小地图 ── */}
      {showMinimap && (
        <div className="tl-minimap-row" style={{ marginLeft: HEADER_WIDTH }}>
          <TimelineMinimap
            tracks={tracks}
            maxChapter={maxChapter}
            chapterWidth={chapterWidth}
            viewportStartChapter={viewportStartChapter}
            viewportVisibleChapters={viewportVisibleChapters}
            onViewportChange={(startCh) => {
              const vp = trackViewportRef.current
              if (vp) vp.scrollLeft = (startCh - 1) * chapterWidth
            }}
          />
        </div>
      )}

      {/* ── 悬停气泡 ── */}
      {hoverBubble && (
        <div
          className="tl-hover-bubble"
          style={{
            left: hoverBubble.x + 12,
            top: hoverBubble.y + 12,
          }}
        >
          <div className="tl-hover-bubble-title">{hoverBubble.clip.label}</div>
          <div className="tl-hover-bubble-range">
            第 {hoverBubble.clip.startChapter}-{hoverBubble.clip.endChapter} 章
          </div>
          {hoverBubble.clip.tag && (
            <div className="tl-hover-bubble-tag">{hoverBubble.clip.tag}</div>
          )}
        </div>
      )}
    </div>
  )
}
