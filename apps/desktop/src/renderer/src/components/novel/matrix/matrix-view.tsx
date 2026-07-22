/**
 * MatrixView：章节-实体矩阵主组件（2026-07-22 重设计）
 *
 * 设计文档：docs/novel/2026-07-22-matrix-redesign-spec.md
 *
 * 与旧版的差异：
 * - 数据：buildGroups 上移至 MatrixWorkspace（单次计算），本组件纯渲染；
 *   子轨道数据来自共享的 matrix-aggregation 单请求（aggregationChanges），
 *   不再每个展开实体各发一次全量请求
 * - 视觉：统一编码语言（色带/曲线/徽标/圆点 + 网格背景 + 播放头列），
 *   行高/常量全部来自 MATRIX_LAYOUT
 * - 交互：悬浮信息统一走 MatrixHoverCard（data-hc-*）；Ctrl+滚轮连续缩放；
 *   垂直虚拟化（行模型 matrix-model.buildRowSpecs），关系叠加层 Y 坐标
 *   由行偏移驱动，修复展开子轨道时连线偏移
 *
 * DOM 结构：单个滚动容器内 [sticky 标尺 + (钩子行) + 行窗口(上下占位)]，
 * 每行内含 [sticky 实体名列 + 章节单元格区]，分组行与实体行同构。
 */

import { useMemo, useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useDroppable, useDndMonitor, useDraggable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { useDrag } from '@use-gesture/react'
import { ChevronRight, GripVertical, LayoutGrid, LocateFixed } from 'lucide-react'
import type {
  NovelChapter,
  NovelRelationship,
  NovelMarker,
  ChapterEndingHookType,
  NovelHook,
  NovelCharacterArc,
  NovelChangeRecord,
} from '@/api/novel-client'
import { listHooks, listCharacterArcs } from '@/api/novel-client'
import { cn } from '@/lib/utils'
import { computeVisibleChapters, getChapterNavigationTarget } from '@/lib/matrix-viewport'
import { useNovelDataStore } from '@/stores/novel-data-store'
import { useNovelUiStore } from '@/stores/novel-ui-store'
import {
  GROUP_META,
  tensionToLabel,
  shiftChapterSpan,
  isMajorGridline,
  isMinorGridline,
  computeCellSymbol,
  type MatrixData,
  type MatrixEntityKind,
  type MatrixEntity,
  type MatrixGroup,
  type MatrixDragData,
  type SpanDragData,
  type CellDragData,
} from './matrix-logic'
import {
  MATRIX_LAYOUT,
  gridlineBackgroundImage,
  buildRowSpecs,
  computeRowOffsets,
  computeVisibleRowWindow,
  buildSubtracksForEntity,
  isSubtrackSupported,
  type SubtrackDef,
} from './matrix-model'
import { MatrixSubtracks } from './matrix-subtracks'

const { rulerHeight: RULER_H, hookRowHeight: HOOK_H, groupHeight: GROUP_H, entityHeight: ROW_H, sidebarWidth: SIDEBAR_DEFAULT } = MATRIX_LAYOUT

// ── hover 卡属性构造（data-hc-* → MatrixHoverCard）──
function hc(dim: string, ch: string | number, opts?: { before?: string; after?: string; desc?: string; color?: string }): Record<string, string> {
  return {
    'data-hc-dim': dim,
    'data-hc-ch': String(ch),
    'data-hc-before': opts?.before ?? '',
    'data-hc-after': opts?.after ?? '',
    'data-hc-desc': opts?.desc ?? '',
    'data-hc-color': opts?.color ?? '',
  }
}

/** 章节张力（1-10）→ 热力条颜色 */
function tensionColor(tension: number): string {
  const t = tension / 10
  if (t < 0.4) return '#22c55e'
  if (t < 0.7) return '#f59e0b'
  return '#e8463a'
}

// 标记颜色映射（marker.color → 十六进制，避免 Tailwind 动态类名）
const MARKER_COLOR_HEX: Record<string, string> = {
  blue: '#3b82f6',
  yellow: '#eab308',
  green: '#22c55e',
  red: '#ef4444',
  purple: '#a855f7',
}

export interface MatrixViewProps {
  /** 矩阵数据（Workspace 单次 buildGroups 结果） */
  matrixData: MatrixData
  chapters: NovelChapter[]
  markers: NovelMarker[]
  relationships: NovelRelationship[]
  /** 共享账本投影（matrix-aggregation 单请求），子轨道数据源 */
  aggregationChanges: NovelChangeRecord[]
  playheadChapter: number
  cellWidth: number
  collapsedGroups: Set<MatrixEntityKind>
  activeFilter: MatrixEntityKind | null
  selectedNodeId?: string | null
  selectedMatrixEntityIds?: string[]
  showMarkers?: boolean

  onSelectEntity: (entityType: MatrixEntityKind, entityId: string, opts?: { multi?: boolean }) => void
  onToggleCollapse: (kind: MatrixEntityKind) => void
  onPlayheadChange: (chapter: number) => void
  onToggleEntityExpand?: (entityId: string) => void
  /** Ctrl+滚轮连续缩放 */
  onCellWidthChange?: (next: number) => void
  onContextMenuChapter: (chapterNumber: number, x: number, y: number) => void
  onContextMenuCell?: (entityId: string, entityName: string, entityType: MatrixEntityKind, chapter: number, x: number, y: number) => void
  onContextMenuGroupEmpty?: (kind: MatrixEntityKind) => void
  onEditEntity?: (entity: MatrixEntity) => void
  onEditSpan?: (entity: MatrixEntity) => void
  onDropEntity?: (entityId: string, entityType: MatrixEntityKind, chapter: number) => void
  onMoveEndpoint?: (entityId: string, entityType: MatrixEntityKind, spanIndex: number, end: 'start' | 'end', chapter: number) => void
  onMoveSpan?: (entityId: string, entityType: 'conflict' | 'faction' | 'item', spanIndex: number, startChapter: number, endChapter: number) => void
  onMoveCell?: (entityId: string, entityType: MatrixEntityKind, fromChapter: number, toChapter: number) => void
  onTogglePresent?: (entity: MatrixEntity, chapter: number) => void

  expandedEntityIds?: string[]
  showRelationshipOverlay?: boolean
}

export function MatrixView({
  matrixData, chapters, markers, relationships, aggregationChanges,
  playheadChapter, cellWidth, collapsedGroups, activeFilter,
  selectedNodeId, selectedMatrixEntityIds = [], showMarkers = true,
  onSelectEntity, onToggleCollapse, onPlayheadChange, onToggleEntityExpand, onCellWidthChange,
  onContextMenuChapter, onContextMenuCell, onContextMenuGroupEmpty, onEditEntity, onEditSpan,
  onDropEntity, onMoveEndpoint, onMoveSpan, onMoveCell, onTogglePresent,
  expandedEntityIds = [], showRelationshipOverlay = false,
}: MatrixViewProps): ReactElement {
  const { groups, maxChapter } = matrixData
  const titleMap = useMemo(() => {
    const m = new Map<number, string>()
    for (const c of chapters) m.set(c.chapterNumber, c.title)
    return m
  }, [chapters])
  const chapterByNumber = useMemo(() => {
    const m = new Map<number, NovelChapter>()
    for (const c of chapters) m.set(c.chapterNumber, c)
    return m
  }, [chapters])

  const scrollContainerRef = useRef<HTMLDivElement>(null)

  // ── 左侧列宽拖拽 ──
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT)
  const [isResizing, setIsResizing] = useState(false)
  const resizeStartRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const bindResize = useDrag(({ down, movement: [mx], first, event }) => {
    const evt = event as PointerEvent
    if (first) {
      resizeStartRef.current = { startX: evt.clientX, startWidth: sidebarWidth }
      setIsResizing(true)
    }
    if (down && resizeStartRef.current) {
      setSidebarWidth(Math.max(120, Math.min(400, resizeStartRef.current.startWidth + mx)))
    } else {
      setIsResizing(false)
      resizeStartRef.current = null
    }
  }, { filterTaps: true, threshold: 2, pointer: { buttons: 1 } })

  // ── 水平虚拟化 ──
  const [visibleRange, setVisibleRange] = useState<{ start: number; end: number }>(() => ({
    start: 1,
    end: Math.max(1, Math.min(maxChapter, 20)),
  }))
  const recomputeVisibleRange = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const range = computeVisibleChapters({
      scrollLeft: el.scrollLeft,
      viewportWidth: el.clientWidth,
      sidebarWidth,
      cellWidth,
      maxChapter,
      overscan: 3,
    })
    setVisibleRange((prev) => (prev.start === range.start && prev.end === range.end ? prev : range))
  }, [cellWidth, maxChapter, sidebarWidth])

  // ── 章尾钩子 / 角色弧光（独立实体查询，保留旧行为）──
  const currentProjectId = useNovelDataStore((s) => s.currentProjectId)
  const { data: hooks = [] } = useQuery({
    queryKey: ['novel', 'hooks', currentProjectId],
    queryFn: () => listHooks(currentProjectId!),
    enabled: !!currentProjectId,
    retry: false,
    placeholderData: [],
  })
  const { data: characterArcs = [] } = useQuery({
    queryKey: ['novel', 'character-arcs', currentProjectId],
    queryFn: () => listCharacterArcs(currentProjectId!),
    enabled: !!currentProjectId,
    retry: false,
    placeholderData: [],
  })
  const hookRowVisible = hooks.length > 0
  const rowsTop = RULER_H + (hookRowVisible ? HOOK_H : 0)

  // ── 展开实体的子轨道（共享 aggregation，一次性投影）──
  const expandedTracks = useMemo(() => {
    const m = new Map<string, SubtrackDef[]>()
    if (expandedEntityIds.length === 0) return m
    for (const g of groups) {
      for (const e of g.entities) {
        if (expandedEntityIds.includes(e.entityId)) {
          m.set(e.entityId, buildSubtracksForEntity(aggregationChanges, e))
        }
      }
    }
    return m
  }, [groups, expandedEntityIds, aggregationChanges])

  // ── 行模型（垂直虚拟化）──
  const rows = useMemo(
    () => buildRowSpecs({
      groups,
      collapsedGroups,
      activeFilter,
      expandedTrackCounts: new Map([...expandedTracks].map(([id, t]) => [id, t.length])),
    }),
    [groups, collapsedGroups, activeFilter, expandedTracks],
  )
  const offsets = useMemo(() => computeRowOffsets(rows), [rows])
  const totalRowsHeight = rows.length === 0 ? 0 : offsets[rows.length - 1] + rows[rows.length - 1].height

  const [vWindow, setVWindow] = useState<{ start: number; end: number }>({ start: 0, end: 40 })
  const recomputeWindow = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const w = computeVisibleRowWindow({
      offsets,
      rows,
      scrollTop: Math.max(0, el.scrollTop - rowsTop),
      viewportHeight: el.clientHeight,
      overscan: 6,
    })
    setVWindow((prev) => (prev.start === w.start && prev.end === w.end ? prev : w))
  }, [offsets, rows, rowsTop])

  useEffect(() => {
    recomputeVisibleRange()
    recomputeWindow()
  }, [recomputeVisibleRange, recomputeWindow])

  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      recomputeVisibleRange()
      recomputeWindow()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [recomputeVisibleRange, recomputeWindow])

  const visibleChapterColumns = useMemo(() => {
    if (visibleRange.start > visibleRange.end) return []
    const cols: number[] = []
    for (let i = visibleRange.start; i <= Math.min(visibleRange.end, maxChapter); i++) cols.push(i)
    return cols
  }, [visibleRange, maxChapter])

  const markersByChapter = useMemo(() => {
    const m = new Map<number, NovelMarker[]>()
    if (!showMarkers) return m
    for (const marker of markers) {
      if (marker.type === 'clip-note') continue
      const arr = m.get(marker.chapter) ?? []
      arr.push(marker)
      m.set(marker.chapter, arr)
    }
    return m
  }, [markers, showMarkers])

  // ── 播放头定位 ──
  const focusChapter = useCallback((chapter: number, behavior: ScrollBehavior = 'smooth') => {
    const el = scrollContainerRef.current
    if (!el) return
    const clamped = Math.min(maxChapter, Math.max(1, chapter))
    const targetLeft = sidebarWidth + (clamped - 1) * cellWidth
    const scrollTo = Math.max(0, targetLeft - el.clientWidth / 2 + cellWidth / 2)
    el.scrollTo({ left: scrollTo, behavior })
  }, [cellWidth, maxChapter, sidebarWidth])

  const matrixScrollTarget = useNovelUiStore((s) => s.matrixScrollTarget)
  useEffect(() => {
    if (!matrixScrollTarget) return
    focusChapter(matrixScrollTarget.chapter)
  }, [matrixScrollTarget, focusChapter])

  const handleLocatePlayhead = useCallback(() => {
    focusChapter(playheadChapter)
  }, [focusChapter, playheadChapter])

  const handleRulerKeyDown = useCallback((event: React.KeyboardEvent) => {
    const target = getChapterNavigationTarget(event.key, playheadChapter, maxChapter)
    if (target == null) return
    event.preventDefault()
    onPlayheadChange(target)
    focusChapter(target)
  }, [focusChapter, maxChapter, onPlayheadChange, playheadChapter])

  // ── Ctrl+滚轮缩放（native listener，React onWheel 是 passive）──
  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el || !onCellWidthChange) return
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const next = Math.max(MATRIX_LAYOUT.minCellWidth, Math.min(MATRIX_LAYOUT.maxCellWidth, cellWidth + (e.deltaY < 0 ? 4 : -4)))
      onCellWidthChange(next)
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [cellWidth, onCellWidthChange])

  // ── 拖拽（dnd-kit，与旧版一致的 id/data 契约）──
  const [dragOverChapter, setDragOverChapter] = useState<number | null>(null)
  const [dragOverRange, setDragOverRange] = useState<{ start: number; end: number } | null>(null)
  const [flashChapter, setFlashChapter] = useState<number | null>(null)
  const [flashRange, setFlashRange] = useState<{ start: number; end: number } | null>(null)

  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: 'matrix-grid' })

  const computeChapterFromRect = useCallback((rect: { left: number; width: number } | null | undefined): number | null => {
    const el = scrollContainerRef.current
    if (!el || !rect) return null
    const containerRect = el.getBoundingClientRect()
    const contentX = rect.left + rect.width / 2 - containerRect.left + el.scrollLeft
    const colX = contentX - sidebarWidth
    if (colX < 0) return null
    const ch = Math.floor(colX / cellWidth) + 1
    if (ch < 1 || ch > maxChapter) return null
    return ch
  }, [cellWidth, maxChapter, sidebarWidth])

  const computeSpanDropRange = useCallback((
    data: SpanDragData,
    initial: { left: number } | null | undefined,
    translated: { left: number } | null | undefined,
  ): { start: number; end: number } => {
    if (!initial || !translated) return { start: data.startChapter, end: data.endChapter }
    const deltaChapters = Math.round((translated.left - initial.left) / cellWidth)
    const [start, end] = shiftChapterSpan([data.startChapter, data.endChapter], deltaChapters, maxChapter)
    return { start, end }
  }, [cellWidth, maxChapter])

  useDndMonitor({
    onDragMove: ({ active }) => {
      const data = active.data.current as MatrixDragData | undefined
      if (!data) return
      if (data.source === 'span') {
        const range = computeSpanDropRange(data, active.rect.current.initial, active.rect.current.translated)
        setDragOverChapter(null)
        setDragOverRange((prev) => (prev?.start === range.start && prev.end === range.end ? prev : range))
        return
      }
      const ch = computeChapterFromRect(active.rect.current.translated)
      setDragOverChapter((prev) => (prev === ch ? prev : ch))
      setDragOverRange(null)
    },
    onDragEnd: ({ active, over }) => {
      setDragOverChapter(null)
      setDragOverRange(null)
      if (!over || over.id !== 'matrix-grid') return
      const data = active.data.current as MatrixDragData | undefined
      if (!data) return
      if (data.source === 'span') {
        const range = computeSpanDropRange(data, active.rect.current.initial, active.rect.current.translated)
        onMoveSpan?.(data.entityId, data.entityType, data.spanIndex, range.start, range.end)
        setFlashChapter(null)
        setFlashRange(range)
        window.setTimeout(() => setFlashRange(null), 800)
        return
      }
      const ch = computeChapterFromRect(active.rect.current.translated)
      if (ch == null) return
      switch (data.source) {
        case 'sidebar':
          onDropEntity?.(data.entityId, data.entityType, ch)
          break
        case 'endpoint':
          onMoveEndpoint?.(data.entityId, data.entityType, data.spanIndex, data.end, ch)
          break
        case 'cell':
          if (data.chapter !== ch) onMoveCell?.(data.entityId, data.entityType, data.chapter, ch)
          break
      }
      setFlashRange(null)
      setFlashChapter(ch)
      window.setTimeout(() => setFlashChapter(null), 800)
    },
    onDragCancel: () => {
      setDragOverChapter(null)
      setDragOverRange(null)
    },
  })

  // ── 鼠标按住平移滚动 ──
  const [isPanning, setIsPanning] = useState(false)
  const panStartRef = useRef<{ startX: number; startScrollLeft: number } | null>(null)
  const bindPan = useDrag(({ down, movement: [mx], first, cancel, event }) => {
    const evt = event as PointerEvent
    if (first) {
      const target = evt.target as HTMLElement
      if (
        target.closest('[aria-roledescription="draggable"]') ||
        target.closest('button, a, input, select, textarea, [role="button"]') ||
        target.closest('[data-hc-dim],[data-hc-after],[data-hc-desc]')
      ) {
        cancel()
        return
      }
      const el = scrollContainerRef.current
      if (!el) { cancel(); return }
      panStartRef.current = { startX: evt.clientX, startScrollLeft: el.scrollLeft }
    }
    if (down && panStartRef.current) {
      setIsPanning(true)
      const el = scrollContainerRef.current
      if (el) el.scrollLeft = panStartRef.current.startScrollLeft - mx
    } else {
      setIsPanning(false)
      panStartRef.current = null
    }
  }, { filterTaps: true, threshold: 6, pointer: { buttons: 1 } })

  // ── 关系叠加层 Y 坐标（行模型驱动，修复子轨道展开偏移）──
  const entityRowY = useMemo(() => {
    const map = new Map<string, number>()
    if (!showRelationshipOverlay) return map
    rows.forEach((row, i) => {
      if (row.type === 'entity') {
        map.set(row.entity.entityId, rowsTop + offsets[i] + row.height / 2)
      }
    })
    return map
  }, [showRelationshipOverlay, rows, offsets, rowsTop])

  const chapterColumnX = useCallback(
    (chapter: number): number => sidebarWidth + (chapter - 1) * cellWidth + cellWidth / 2,
    [sidebarWidth, cellWidth],
  )

  const hasAnyEntity = groups.some((g) => g.entities.length > 0)
  const totalWidth = sidebarWidth + maxChapter * cellWidth
  const highlightLeft = sidebarWidth + (playheadChapter - 1) * cellWidth
  const isPlayheadVisible = playheadChapter >= visibleRange.start && playheadChapter <= visibleRange.end

  const windowRows = rows.slice(vWindow.start, vWindow.end)
  const topSpacerH = vWindow.start > 0 ? offsets[vWindow.start] : 0
  const bottomSpacerH = vWindow.end < rows.length ? totalRowsHeight - (offsets[vWindow.end - 1] + rows[vWindow.end - 1].height) : 0

  return (
    <div
      ref={(el) => {
        scrollContainerRef.current = el
        setDropRef(el)
      }}
      className={cn(
        'relative overflow-auto h-full isolate touch-none focus:outline-none bg-surface-1',
        isPanning ? 'cursor-grabbing select-none' : 'cursor-default',
      )}
      role="region"
      aria-label="章节实体矩阵"
      {...bindPan()}
      onScroll={(e) => {
        const el = e.currentTarget
        const range = computeVisibleChapters({
          scrollLeft: el.scrollLeft,
          viewportWidth: el.clientWidth,
          sidebarWidth,
          cellWidth,
          maxChapter,
          overscan: 3,
        })
        setVisibleRange((prev) => (prev.start === range.start && prev.end === range.end ? prev : range))
        recomputeWindow()
      }}
    >
      <div className="relative" style={{ width: totalWidth, height: rowsTop + totalRowsHeight }}>
        {/* ── 播放头整列高亮 ── */}
        <div
          className="absolute bottom-0 pointer-events-none z-[4]"
          style={{
            top: RULER_H,
            left: highlightLeft,
            width: cellWidth,
            background: 'rgba(245,158,11,0.07)',
            borderLeft: '2px solid rgba(245,158,11,0.85)',
          }}
          aria-hidden="true"
        />

        {/* ── 拖放预览 ── */}
        {isOver && dragOverChapter != null && (
          <>
            <div
              className="absolute bottom-0 pointer-events-none z-[7] border-x border-blue-500/60"
              style={{ top: RULER_H, left: sidebarWidth + (dragOverChapter - 1) * cellWidth, width: cellWidth, background: 'rgba(59,130,246,0.16)' }}
              aria-hidden="true"
            />
            <div
              className="absolute z-[9] pointer-events-none -translate-x-1/2 rounded-md bg-blue-600 px-2 py-1 text-[10px] font-medium text-white shadow-lg whitespace-nowrap"
              style={{ top: RULER_H + 6, left: sidebarWidth + (dragOverChapter - 0.5) * cellWidth }}
              aria-hidden="true"
            >
              第 {dragOverChapter} 章{titleMap.get(dragOverChapter) ? ` · ${titleMap.get(dragOverChapter)}` : ''}
            </div>
          </>
        )}
        {isOver && dragOverRange != null && (
          <>
            <div
              className="absolute bottom-0 pointer-events-none z-[7] rounded-sm border-x border-sky-500/70 bg-sky-500/12"
              style={{ top: RULER_H, left: sidebarWidth + (dragOverRange.start - 1) * cellWidth, width: (dragOverRange.end - dragOverRange.start + 1) * cellWidth }}
              aria-hidden="true"
            />
            <div
              className="absolute z-[9] pointer-events-none -translate-x-1/2 rounded-md bg-sky-600 px-2 py-1 text-[10px] font-medium text-white shadow-lg whitespace-nowrap tabular-nums"
              style={{ top: RULER_H + 6, left: sidebarWidth + ((dragOverRange.start + dragOverRange.end) / 2 - 0.5) * cellWidth }}
              aria-hidden="true"
            >
              第 {dragOverRange.start}-{dragOverRange.end} 章
            </div>
          </>
        )}

        {/* 释放后闪烁反馈 */}
        {flashChapter != null && (
          <div
            className="absolute bottom-0 pointer-events-none z-[8] border-2 border-blue-500 rounded-sm animate-pulse"
            style={{ top: RULER_H, left: sidebarWidth + (flashChapter - 1) * cellWidth, width: cellWidth, background: 'rgba(59,130,246,0.22)' }}
            aria-hidden="true"
          />
        )}
        {flashRange != null && (
          <div
            className="absolute bottom-0 pointer-events-none z-[8] rounded-sm border-2 border-sky-500 animate-pulse"
            style={{ top: RULER_H, left: sidebarWidth + (flashRange.start - 1) * cellWidth, width: (flashRange.end - flashRange.start + 1) * cellWidth, background: 'rgba(14,165,233,0.14)' }}
            aria-hidden="true"
          />
        )}

        {/* ── 标尺行（sticky）── */}
        <div className="sticky top-0 z-40 flex border-b border-border-strong bg-surface-1" style={{ height: RULER_H }}>
          {/* 左侧 sticky 角 */}
          <div className="sticky left-0 z-30 bg-surface-1 flex items-center justify-between gap-2 px-2 border-r border-border-strong shrink-0" style={{ width: sidebarWidth }}>
            <span className="text-[10px] text-hint tracking-wider whitespace-nowrap pl-1">实体 ＼ 章节</span>
            <button
              type="button"
              onClick={handleLocatePlayhead}
              className={cn(
                'inline-flex h-7 items-center gap-1 rounded-md px-2 font-mono text-[10px] tabular-nums transition-colors active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50',
                isPlayheadVisible
                  ? 'text-muted-foreground hover:bg-muted hover:text-text'
                  : 'bg-amber-500/12 text-amber-500 hover:bg-amber-500/18',
              )}
              {...hc('定位播放头', playheadChapter, { after: `滚动到第 ${playheadChapter} 章` })}
              aria-label={`定位到当前第 ${playheadChapter} 章`}
            >
              <LocateFixed className="size-3.5" aria-hidden="true" />
              {String(playheadChapter).padStart(2, '0')}
            </button>
            {/* 列宽拖拽手柄 */}
            <div
              {...bindResize()}
              className={cn(
                'absolute top-0 bottom-0 z-[35] w-1.5 cursor-col-resize -right-0.5',
                'bg-transparent hover:bg-primary/30 active:bg-primary/50 transition-colors',
                isResizing && 'bg-primary/40',
              )}
              aria-hidden="true"
            />
          </div>
          {/* 章节列 */}
          <div className="flex">
            {visibleRange.start > 1 && <div style={{ width: (visibleRange.start - 1) * cellWidth }} aria-hidden="true" />}
            {visibleChapterColumns.map((ch) => {
              const isCurrent = ch === playheadChapter
              const title = titleMap.get(ch) ?? ''
              const ms = markersByChapter.get(ch) ?? []
              const chapter = chapterByNumber.get(ch)
              const tension = chapter?.tension ?? null
              const major = isMajorGridline(ch)
              const minor = isMinorGridline(ch)
              return (
                <button
                  key={ch}
                  type="button"
                  className={cn(
                    'relative h-full shrink-0 flex flex-col items-center justify-end pb-1 cursor-pointer transition-colors hover:bg-muted/40 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60',
                    major ? 'border-r border-border-strong' : 'border-r border-border/30',
                    isCurrent && 'bg-amber-500/[0.07]',
                  )}
                  style={{ width: cellWidth }}
                  onClick={() => onPlayheadChange(ch)}
                  onKeyDown={handleRulerKeyDown}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    onContextMenuChapter(ch, e.clientX, e.clientY)
                  }}
                  {...hc(`第 ${ch} 章`, ch, {
                    after: title || undefined,
                    desc: tension != null ? `张力 ${tension}（${tensionToLabel(tension)}）` : undefined,
                  })}
                  aria-label={`第 ${ch} 章${title ? ` ${title}` : ''}`}
                  aria-current={isCurrent ? 'step' : undefined}
                >
                  {ms.length > 0 && (
                    <span className="flex gap-0.5 absolute top-1 left-1/2 -translate-x-1/2">
                      {ms.map((m) => (
                        <span
                          key={m.id}
                          className="w-1.5 h-1.5 rounded-full border border-white/60"
                          style={{ background: MARKER_COLOR_HEX[m.color] ?? '#737373' }}
                          {...hc(m.title, ch, { desc: m.note || undefined })}
                        />
                      ))}
                    </span>
                  )}
                  <span
                    className={cn(
                      'font-mono tracking-wide text-[11px] leading-none mb-1 tabular-nums',
                      isCurrent ? 'text-amber-500 font-bold' : major ? 'text-text font-semibold' : minor ? 'text-subtle' : 'text-hint',
                    )}
                  >
                    {String(ch).padStart(2, '0')}
                  </span>
                  {/* 张力热力条 */}
                  <span
                    className="rounded-sm"
                    style={{
                      height: 4,
                      width: Math.max(8, cellWidth - 14),
                      background: tension != null ? tensionColor(tension) : 'transparent',
                      opacity: tension != null ? 0.45 + (tension / 10) * 0.5 : 0,
                    }}
                    aria-hidden="true"
                  />
                </button>
              )
            })}
            {visibleRange.end < maxChapter && <div style={{ width: (maxChapter - visibleRange.end) * cellWidth }} aria-hidden="true" />}
          </div>
        </div>

        {/* ── 章尾钩子轨道行 ── */}
        {hookRowVisible && (
          <HookTrackRow
            hooks={hooks}
            visibleChapterColumns={visibleChapterColumns}
            visibleRange={visibleRange}
            maxChapter={maxChapter}
            cellWidth={cellWidth}
            sidebarWidth={sidebarWidth}
            playheadChapter={playheadChapter}
          />
        )}

        {/* ── 实体行窗口（垂直虚拟化）── */}
        {!hasAnyEntity ? (
          <MatrixEmptyState />
        ) : (
          <>
            {topSpacerH > 0 && <div style={{ height: topSpacerH }} aria-hidden="true" />}
            {windowRows.map((row) => {
              if (row.type === 'group') {
                return (
                  <GroupRow
                    key={row.key}
                    group={row.group}
                    collapsed={collapsedGroups.has(row.group.id)}
                    cellWidth={cellWidth}
                    sidebarWidth={sidebarWidth}
                    onToggleCollapse={() => onToggleCollapse(row.group.id)}
                    onContextMenuGroupEmpty={onContextMenuGroupEmpty}
                  />
                )
              }
              if (row.type === 'subtracks') {
                const tracks = expandedTracks.get(row.entity.entityId) ?? []
                return (
                  <MatrixSubtracks
                    key={row.key}
                    tracks={tracks}
                    cellWidth={cellWidth}
                    sidebarWidth={sidebarWidth}
                    playheadChapter={playheadChapter}
                  />
                )
              }
              const entity = row.entity
              return (
                <EntityRow
                  key={row.key}
                  entity={entity}
                  visibleChapterColumns={visibleChapterColumns}
                  maxChapter={maxChapter}
                  cellWidth={cellWidth}
                  sidebarWidth={sidebarWidth}
                  playheadChapter={playheadChapter}
                  isSelected={selectedNodeId === entity.entityId}
                  isMatrixSelected={selectedMatrixEntityIds.includes(entity.entityId)}
                  isExpanded={expandedEntityIds.includes(entity.entityId)}
                  characterArcs={characterArcs}
                  onClick={(opts) => onSelectEntity(entity.entityType, entity.entityId, opts)}
                  onContextMenuCell={onContextMenuCell}
                  onEditEntity={onEditEntity}
                  onEditSpan={onEditSpan}
                  onTogglePresent={onTogglePresent}
                  onPlayheadChange={onPlayheadChange}
                  onToggleExpand={onToggleEntityExpand}
                />
              )
            })}
            {bottomSpacerH > 0 && <div style={{ height: bottomSpacerH }} aria-hidden="true" />}
          </>
        )}

        {/* ── 关系叠加层 ── */}
        {showRelationshipOverlay && relationships.length > 0 && (
          <RelationshipOverlay
            relationships={relationships}
            entityRowY={entityRowY}
            chapterColumnX={chapterColumnX}
            visibleRange={visibleRange}
            cellWidth={cellWidth}
            sidebarWidth={sidebarWidth}
          />
        )}
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────
// 章尾钩子轨道行
// ────────────────────────────────────────────────────────────

const HOOK_META: Record<ChapterEndingHookType, { color: string; char: string; label: string }> = {
  suspense: { color: '#a855f7', char: '悬', label: '悬念' },
  reversal: { color: '#e8463a', char: '反', label: '反转' },
  emotional: { color: '#ec4899', char: '情', label: '情感' },
  action: { color: '#f97316', char: '动', label: '动作' },
  none: { color: '#6b7280', char: '', label: '无' },
}

interface HookTrackRowProps {
  hooks: NovelHook[]
  visibleChapterColumns: number[]
  visibleRange: { start: number; end: number }
  maxChapter: number
  cellWidth: number
  sidebarWidth: number
  playheadChapter: number
}

function HookTrackRow({
  hooks, visibleChapterColumns, visibleRange, maxChapter, cellWidth, sidebarWidth, playheadChapter,
}: HookTrackRowProps): ReactElement {
  const hooksByChapter = useMemo(() => {
    const m = new Map<number, NovelHook[]>()
    for (const h of hooks) {
      const arr = m.get(h.chapterNumber) ?? []
      arr.push(h)
      m.set(h.chapterNumber, arr)
    }
    return m
  }, [hooks])

  return (
    <div className="relative flex border-b border-border/10" style={{ height: HOOK_H }}>
      <div
        className="sticky left-0 z-30 flex items-center justify-end pr-2 border-r border-border/40 shrink-0 bg-surface-1"
        style={{ width: sidebarWidth }}
      >
        <span className="text-[10px] text-hint tracking-wider">章尾钩子</span>
      </div>
      <div className="relative flex-1" style={{ backgroundImage: gridlineBackgroundImage(cellWidth) }}>
        {visibleChapterColumns.map((ch) => {
          const chapterHooks = hooksByChapter.get(ch) ?? []
          const primary = chapterHooks[0]
          const meta = primary ? HOOK_META[primary.hookType] : null
          const statusLabel = primary
            ? primary.status === 'fulfilled' ? '已兑现' : primary.status === 'thrown' ? '已抛出' : '已放弃'
            : ''
          return (
            <div
              key={ch}
              className="absolute top-0 bottom-0 flex items-center justify-center"
              style={{ left: (ch - 1) * cellWidth, width: cellWidth }}
              {...(primary && primary.hookType !== 'none'
                ? hc(`${meta!.label}钩子`, ch, { after: statusLabel, desc: primary.description || undefined, color: meta!.color })
                : {})}
            >
              {chapterHooks.length === 1 && primary && primary.hookType !== 'none' && meta && (
                <span
                  className="flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-bold leading-none"
                  style={{
                    color: primary.status === 'fulfilled' ? '#fff' : meta.color,
                    background: primary.status === 'fulfilled' ? meta.color : undefined,
                    border: `1px ${primary.status === 'fulfilled' ? 'solid' : 'dashed'} ${meta.color}`,
                    opacity: primary.status === 'abandoned' ? 0.35 : primary.status === 'thrown' ? 0.8 : 1,
                  }}
                >
                  {meta.char}
                </span>
              )}
              {chapterHooks.length > 1 && (
                <span className="flex items-center gap-0.5">
                  {chapterHooks.slice(0, 4).map((h) => {
                    const hm = HOOK_META[h.hookType]
                    if (h.hookType === 'none') return null
                    return (
                      <span
                        key={h.id}
                        className="rounded-full"
                        style={{
                          width: 5,
                          height: 5,
                          background: h.status === 'fulfilled' ? hm.color : 'transparent',
                          border: `1px ${h.status === 'fulfilled' ? 'solid' : 'dashed'} ${hm.color}`,
                          opacity: h.status === 'abandoned' ? 0.35 : 1,
                        }}
                      />
                    )
                  })}
                </span>
              )}
            </div>
          )
        })}
        {/* 播放头列高亮 */}
        <div
          aria-hidden="true"
          className="absolute top-0 bottom-0 pointer-events-none bg-amber-500/[0.06]"
          style={{ left: (playheadChapter - 1) * cellWidth, width: cellWidth }}
        />
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────
// 空状态
// ────────────────────────────────────────────────────────────

function MatrixEmptyState(): ReactElement {
  return (
    <div className="flex items-center justify-center px-6 py-16">
      <div className="text-center max-w-sm">
        <div className="mx-auto mb-3 w-12 h-12 rounded-full bg-muted/40 flex items-center justify-center text-hint">
          <LayoutGrid className="size-5" />
        </div>
        <p className="text-sm font-medium text-text mb-1.5">暂无实体出场记录</p>
        <p className="text-xs text-muted-foreground leading-relaxed">
          请点击上方「补全历史」让 AI 自动补全角色起始章节，
          或从左侧 NovelSidebar 新建实体后，左键双击空单元格标记出场，右键单元格更多操作。
        </p>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────
// 分组行
// ────────────────────────────────────────────────────────────

interface GroupRowProps {
  group: MatrixGroup
  collapsed: boolean
  cellWidth: number
  sidebarWidth: number
  onToggleCollapse: () => void
  onContextMenuGroupEmpty?: (kind: MatrixEntityKind) => void
}

function GroupRow({ group, collapsed, cellWidth, sidebarWidth, onToggleCollapse, onContextMenuGroupEmpty }: GroupRowProps): ReactElement {
  return (
    <div className="relative flex border-b border-border/10 bg-surface-2/70" style={{ height: GROUP_H }}>
      <div
        className="sticky left-0 z-30 flex items-center gap-1.5 px-2 pl-2.5 border-r border-border/40 shrink-0 bg-surface-2 cursor-pointer select-none hover:bg-surface-3 transition-colors"
        style={{ width: sidebarWidth }}
        onClick={onToggleCollapse}
        {...hc(collapsed ? `展开${group.name}` : `折叠${group.name}`, '', {})}
      >
        <span className={cn('inline-flex items-center justify-center w-3.5 h-3.5 text-subtle transition-transform', collapsed && '-rotate-90')}>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m6 9 6 6 6-6" /></svg>
        </span>
        <span className="w-1.5 h-1.5 rounded-sm shrink-0" style={{ background: group.color }} />
        <span className="text-[11px] font-bold text-text-secondary tracking-wide truncate flex-1">{group.name}</span>
        <span className="font-mono text-[10px] text-hint tabular-nums shrink-0">{group.entities.length}</span>
      </div>
      <div
        className="relative flex-1"
        style={{ backgroundImage: gridlineBackgroundImage(cellWidth) }}
        onContextMenu={(e) => {
          if (!onContextMenuGroupEmpty || group.entities.length > 0) return
          e.preventDefault()
          onContextMenuGroupEmpty(group.id)
        }}
      />
    </div>
  )
}

// ────────────────────────────────────────────────────────────
// 实体行
// ────────────────────────────────────────────────────────────

interface EntityRowProps {
  entity: MatrixEntity
  visibleChapterColumns: number[]
  maxChapter: number
  cellWidth: number
  sidebarWidth: number
  playheadChapter: number
  isSelected: boolean
  isMatrixSelected: boolean
  isExpanded: boolean
  characterArcs: NovelCharacterArc[]
  onClick: (opts?: { multi?: boolean }) => void
  onContextMenuCell?: (entityId: string, entityName: string, entityType: MatrixEntityKind, chapter: number, x: number, y: number) => void
  onEditEntity?: (entity: MatrixEntity) => void
  onEditSpan?: (entity: MatrixEntity) => void
  onTogglePresent?: (entity: MatrixEntity, chapter: number) => void
  onPlayheadChange?: (chapter: number) => void
  onToggleExpand?: (entityId: string) => void
}

function EntityRow(props: EntityRowProps): ReactElement {
  const {
    entity, visibleChapterColumns, maxChapter, cellWidth, sidebarWidth, playheadChapter,
    isSelected, isMatrixSelected, isExpanded, characterArcs, onClick,
    onContextMenuCell, onEditEntity, onEditSpan, onTogglePresent, onPlayheadChange, onToggleExpand,
  } = props
  const meta = GROUP_META[entity.kind]
  const selected = isSelected || isMatrixSelected
  const expandable = isSubtrackSupported(entity.kind)

  // 角色弧光标记（保留旧行为）
  const arcMarkers = useMemo(() => {
    if (entity.kind !== 'character' || characterArcs.length === 0) return []
    const arc = characterArcs.find((a) => a.characterId === entity.entityId)
    if (!arc || arc.stageHistory.length === 0) return []
    const am = ARC_TYPE_META[arc.arcType] ?? ARC_TYPE_META.growth
    return arc.stageHistory.map((entry) => ({
      chapter: entry.chapterNumber,
      label: am.label,
      color: am.color,
      bg: am.bg,
      stage: entry.stage,
      triggerEvent: entry.triggerEvent,
    }))
  }, [entity, characterArcs])

  return (
    <div
      className={cn(
        'relative flex border-b border-border/10 transition-colors',
        selected ? 'bg-primary/[0.07]' : isExpanded ? 'bg-primary/[0.03]' : 'hover:bg-primary/[0.03]',
      )}
      style={{ height: ROW_H }}
    >
      {/* 左侧 sticky 列 */}
      <div
        className={cn(
          'sticky left-0 z-30 flex items-center gap-1.5 pr-2 pl-2 border-r border-border/40 shrink-0 cursor-pointer select-none transition-colors',
          selected ? 'bg-primary/[0.08]' : 'bg-surface-1',
        )}
        style={{ width: sidebarWidth }}
        onClick={(e) => onClick({ multi: e.ctrlKey || e.metaKey })}
      >
        {selected && <span className="absolute left-0 top-0 bottom-0 w-0.5" style={{ background: meta.color }} aria-hidden="true" />}
        <button
          type="button"
          className={cn(
            'size-4 inline-flex items-center justify-center rounded shrink-0 hover:bg-muted/60 transition-all text-hint',
            isExpanded && 'rotate-90 text-text-secondary',
            !expandable && 'invisible',
          )}
          onClick={(e) => {
            e.stopPropagation()
            onToggleExpand?.(entity.entityId)
          }}
          {...hc(isExpanded ? '收起子轨道' : '展开子轨道', '', {})}
          aria-label={isExpanded ? '收起子轨道' : '展开子轨道'}
          aria-expanded={isExpanded}
          tabIndex={expandable ? 0 : -1}
        >
          <ChevronRight className="size-3" />
        </button>
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: meta.color }} />
        <span className={cn('truncate flex-1 text-xs', selected ? 'text-text font-semibold' : 'text-text-secondary')}>
          {entity.name}
        </span>
        {entity.isProtagonist && (
          <span className="text-[9px] text-amber-600 font-bold shrink-0 border border-amber-500/40 rounded px-0.5 leading-3">主</span>
        )}
        {entity.subLabel && (
          <span className="text-[9px] text-subtle border border-border-strong rounded px-1 leading-3.5 shrink-0 max-w-[72px] truncate">
            {entity.subLabel}
          </span>
        )}
        {entity.note && (
          <span
            className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"
            {...hc('批注', '', { desc: entity.note })}
          />
        )}
      </div>

      {/* 右侧单元格区 */}
      <div className="relative flex-1" style={{ backgroundImage: gridlineBackgroundImage(cellWidth) }}>
        {/* 播放头列高亮 */}
        <div
          aria-hidden="true"
          className="absolute top-0 bottom-0 pointer-events-none bg-amber-500/[0.06]"
          style={{ left: (playheadChapter - 1) * cellWidth, width: cellWidth }}
        />

        {/* 命中层（仅可见列） */}
        {visibleChapterColumns.map((ch) => (
          <HitCell
            key={ch}
            entity={entity}
            chapter={ch}
            cellWidth={cellWidth}
            onTogglePresent={onTogglePresent}
            onPlayheadChange={onPlayheadChange}
            onSelectEntity={onClick}
            onContextMenu={(e) => {
              if (!onContextMenuCell) return
              e.preventDefault()
              onContextMenuCell(entity.entityId, entity.name, entity.kind, ch, e.clientX, e.clientY)
            }}
          />
        ))}

        {/* 主编码层（跨度色带/连线/圆点） */}
        <EntityMainEncoding
          entity={entity}
          maxChapter={maxChapter}
          cellWidth={cellWidth}
          isSelected={selected}
          onEntityClick={onClick}
          onEditEntity={onEditEntity}
          onEditSpan={onEditSpan}
          onContextMenuCell={onContextMenuCell}
        />

        {/* 弧光标记 */}
        {arcMarkers.map((m, i) => (
          <span
            key={`arc-${i}`}
            className="absolute top-0.5 z-[9] inline-flex items-center justify-center w-3.5 h-3.5 rounded-sm text-[8px] font-bold leading-none pointer-events-none ring-1 ring-surface-1"
            style={{ left: (m.chapter - 1) * cellWidth + 1, color: m.color, background: m.bg }}
            title={`${m.label}弧光 → ${m.stage}：${m.triggerEvent}`}
          >
            {m.label[0]}
          </span>
        ))}
      </div>
    </div>
  )
}

const ARC_TYPE_META: Record<string, { label: string; color: string; bg: string }> = {
  growth: { label: '成长', color: '#15a877', bg: 'rgba(21,168,119,0.15)' },
  fall: { label: '堕落', color: '#e8463a', bg: 'rgba(232,70,58,0.15)' },
  redemption: { label: '救赎', color: '#a855f7', bg: 'rgba(168,85,247,0.15)' },
  shift: { label: '转变', color: '#3b82f6', bg: 'rgba(59,130,246,0.15)' },
}

// ────────────────────────────────────────────────────────────
// 命中层单元格（交互；视觉编码在 EntityMainEncoding）
// ────────────────────────────────────────────────────────────

interface HitCellProps {
  entity: MatrixEntity
  chapter: number
  cellWidth: number
  onTogglePresent?: (entity: MatrixEntity, chapter: number) => void
  onSelectEntity?: (opts?: { multi?: boolean }) => void
  onContextMenu?: (e: React.MouseEvent) => void
  onPlayheadChange?: (chapter: number) => void
}

function HitCell({ entity, chapter, cellWidth, onTogglePresent, onSelectEntity, onContextMenu, onPlayheadChange }: HitCellProps): ReactElement {
  const symbol = computeCellSymbol(entity, chapter)
  const meta = GROUP_META[entity.kind]

  // 单击：设置播放头；双击空格：切换出场
  const handleActivate = useCallback((e: React.SyntheticEvent) => {
    e.stopPropagation()
    onPlayheadChange?.(chapter)
  }, [onPlayheadChange, chapter])
  const handleToggle = useCallback((e: React.SyntheticEvent) => {
    e.stopPropagation()
    onTogglePresent?.(entity, chapter)
  }, [onTogglePresent, entity, chapter])
  const handleSelect = useCallback((e: React.SyntheticEvent) => {
    e.stopPropagation()
    onSelectEntity?.({ multi: (e as React.MouseEvent).ctrlKey || (e as React.MouseEvent).metaKey })
  }, [onSelectEntity])

  const left = (chapter - 1) * cellWidth

  if (symbol.type === 'empty') {
    return (
      <button
        type="button"
        className="group/cell absolute top-0 bottom-0 flex items-center justify-center cursor-pointer hover:bg-primary/[0.06] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60"
        style={{ left, width: cellWidth }}
        {...hc(entity.name, chapter, { after: emptyCellHint(entity.kind), color: meta.color })}
        onClick={handleActivate}
        onDoubleClick={handleToggle}
        onContextMenu={onContextMenu}
        aria-label={`第 ${chapter} 章 ${entity.name} 空单元格`}
      >
        <span className="text-primary/60 text-sm font-light opacity-0 group-hover/cell:opacity-70 transition-opacity pointer-events-none select-none leading-none">+</span>
      </button>
    )
  }

  // character/location 已出场：可拖拽换章
  if (entity.kind === 'character' || entity.kind === 'location') {
    return (
      <DraggablePresentCell
        entity={entity}
        chapter={chapter}
        cellWidth={cellWidth}
        left={left}
        isProtagonist={symbol.type === 'present' ? symbol.protagonist : false}
        onContextMenu={onContextMenu}
      />
    )
  }

  // 其余类型已出场：点击选中，双击定位播放头
  return (
    <div
      className="absolute top-0 bottom-0 cursor-pointer focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60"
      style={{ left, width: cellWidth }}
      role="button"
      tabIndex={0}
      {...hc(entity.name, chapter, { after: presentCellHint(entity.kind, symbol.type), color: meta.color })}
      onClick={handleSelect}
      onDoubleClick={handleActivate}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        handleSelect(e)
      }}
      onContextMenu={onContextMenu}
      aria-label={`第 ${chapter} 章 ${entity.name}`}
    />
  )
}

function emptyCellHint(kind: MatrixEntityKind): string {
  switch (kind) {
    case 'character':
    case 'location':
      return '双击标记出场'
    case 'conflict':
    case 'faction':
      return '双击扩展到本章'
    case 'clue':
      return '双击标记发现/推进'
    case 'foreshadow':
      return '双击快速添加伏笔节点'
    default:
      return ''
  }
}

function presentCellHint(kind: MatrixEntityKind, symbolType: string): string {
  if (symbolType === 'conflict-climax') return '冲突高潮'
  switch (kind) {
    case 'clue':
      return '线索发现/推进'
    case 'foreshadow':
      return '伏笔节点'
    case 'world_element':
      return '常驻世界要素'
    default:
      return ''
  }
}

// ── 可拖拽的已出场单元格（character/location）──

interface DraggablePresentCellProps {
  entity: MatrixEntity
  chapter: number
  cellWidth: number
  left: number
  isProtagonist: boolean
  onContextMenu?: (e: React.MouseEvent) => void
}

function DraggablePresentCell({ entity, chapter, cellWidth, left, isProtagonist, onContextMenu }: DraggablePresentCellProps): ReactElement {
  const meta = GROUP_META[entity.kind]
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `cell:${entity.entityId}:${chapter}`,
    data: {
      source: 'cell',
      entityType: entity.kind,
      entityId: entity.entityId,
      chapter,
    } satisfies CellDragData,
  })
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onContextMenu={onContextMenu}
      {...hc(entity.name, chapter, { after: entity.kind === 'character' ? '出场（可拖动换章）' : '出场（可拖动换章）', color: meta.color })}
      aria-label={`第 ${chapter} 章 ${entity.name} 出场，可拖动到其他章节`}
      className={cn(
        'group/cell absolute top-0 bottom-0 flex items-center justify-center cursor-grab active:cursor-grabbing focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60',
        isDragging && 'opacity-30',
      )}
      style={{
        left,
        width: cellWidth,
        transform: transform ? CSS.Translate.toString(transform) : undefined,
        touchAction: 'none',
      }}
    >
      {/* 视觉：实体色圆点（location 专用；character 的色带在编码层） */}
      {entity.kind === 'location' && (
        <span
          className="rounded-full transition-transform group-hover/cell:scale-150"
          style={{ width: 6, height: 6, background: meta.color }}
        />
      )}
      {entity.kind === 'character' && isProtagonist && (
        <span
          className="rounded-full transition-transform group-hover/cell:scale-150"
          style={{ width: 5, height: 5, background: '#fff', boxShadow: `0 0 0 1px ${meta.color}` }}
        />
      )}
      <GripVertical
        className="absolute left-0.5 top-1/2 -translate-y-1/2 size-2.5 text-foreground/30 opacity-0 group-hover/cell:opacity-100 transition-opacity pointer-events-none"
        aria-hidden
      />
    </div>
  )
}

// ────────────────────────────────────────────────────────────
// 主编码层：按实体类型分发的视觉编码
// ────────────────────────────────────────────────────────────

interface EntityMainEncodingProps {
  entity: MatrixEntity
  maxChapter: number
  cellWidth: number
  isSelected: boolean
  onEntityClick: (opts?: { multi?: boolean }) => void
  onEditEntity?: (entity: MatrixEntity) => void
  onEditSpan?: (entity: MatrixEntity) => void
  onContextMenuCell?: (entityId: string, entityName: string, entityType: MatrixEntityKind, chapter: number, x: number, y: number) => void
}

function EntityMainEncoding({
  entity, maxChapter, cellWidth, isSelected, onEntityClick, onEditEntity, onEditSpan, onContextMenuCell,
}: EntityMainEncodingProps): ReactElement | null {
  const meta = GROUP_META[entity.kind]

  switch (entity.kind) {
    case 'character': {
      // 出场连续段色带（视觉层，交互在命中层）
      const spans = entity.characterSpans ?? []
      return (
        <>
          {spans.map((span, i) => (
            <div
              key={`cspan-${i}`}
              aria-hidden="true"
              className="absolute pointer-events-none rounded"
              style={{
                top: 7,
                height: ROW_H - 14,
                left: (span.start - 1) * cellWidth + 1,
                width: (span.end - span.start + 1) * cellWidth - 2,
                background: `rgba(${meta.colorRgb}, 0.20)`,
                border: `1px solid rgba(${meta.colorRgb}, 0.40)`,
              }}
            />
          ))}
        </>
      )
    }

    case 'conflict':
    case 'faction':
    case 'item': {
      const spans = entity.chapterSpans ?? []
      return (
        <>
          {spans.map((span, idx) => (
            <SpanBand
              key={`span-${idx}`}
              entity={entity}
              spanIndex={idx}
              startChapter={span[0]}
              endChapter={span[1]}
              cellWidth={cellWidth}
              isSelected={isSelected}
              onEntityClick={onEntityClick}
              onEditEntity={onEditEntity}
              onEditSpan={onEditSpan}
              onContextMenuCell={onContextMenuCell}
            />
          ))}
          {/* 冲突高潮菱形标记 */}
          {entity.kind === 'conflict' && entity.climaxChapter != null && (
            <span
              className="absolute z-[9] cursor-pointer"
              style={{
                left: (entity.climaxChapter - 0.5) * cellWidth,
                top: ROW_H / 2,
                width: 9,
                height: 9,
                transform: 'translate(-50%, -50%) rotate(45deg)',
                background: '#f59e0b',
                borderRadius: 2,
                boxShadow: '0 0 0 2px rgba(245,158,11,0.30), 0 0 8px rgba(245,158,11,0.5)',
              }}
              {...hc(entity.name, entity.climaxChapter, { after: '预计爆发（高潮）', color: '#f59e0b' })}
            />
          )}
        </>
      )
    }

    case 'clue': {
      const spans = entity.chapterSpans ?? []
      return (
        <>
          {spans.map((span, i) => (
            <div
              key={`clue-${i}`}
              aria-hidden="true"
              className="absolute pointer-events-none rounded"
              style={{
                top: 7,
                height: ROW_H - 14,
                left: (span[0] - 1) * cellWidth + 1,
                width: (span[1] - span[0] + 1) * cellWidth - 2,
                background: `rgba(${meta.colorRgb}, 0.20)`,
                border: `1px solid rgba(${meta.colorRgb}, 0.40)`,
              }}
            />
          ))}
        </>
      )
    }

    case 'foreshadow':
      return (
        <ForeshadowEncoding
          entity={entity}
          cellWidth={cellWidth}
          onEntityClick={onEntityClick}
          onContextMenuCell={onContextMenuCell}
        />
      )

    case 'world_element': {
      const start = entity.alwaysStart ?? 1
      const end = entity.alwaysEnd ?? maxChapter
      return (
        <div
          aria-hidden="true"
          className="absolute pointer-events-none rounded"
          style={{
            top: ROW_H / 2 - 6,
            height: 12,
            left: (start - 1) * cellWidth,
            width: (end - start + 1) * cellWidth,
            background: `linear-gradient(90deg, rgba(${meta.colorRgb}, 0.04) 0%, rgba(${meta.colorRgb}, 0.20) 50%, rgba(${meta.colorRgb}, 0.04) 100%)`,
            border: `1px solid rgba(${meta.colorRgb}, 0.18)`,
          }}
        />
      )
    }

    default:
      return null
  }
}

// ── 跨度色带（conflict/faction/item，可拖拽）──

interface SpanBandProps {
  entity: MatrixEntity
  spanIndex: number
  startChapter: number
  endChapter: number
  cellWidth: number
  isSelected?: boolean
  onEntityClick: (opts?: { multi?: boolean }) => void
  onEditEntity?: (entity: MatrixEntity) => void
  onEditSpan?: (entity: MatrixEntity) => void
  onContextMenuCell?: (entityId: string, entityName: string, entityType: MatrixEntityKind, chapter: number, x: number, y: number) => void
}

function SpanBand({
  entity, spanIndex, startChapter, endChapter, cellWidth, isSelected, onEntityClick, onEditEntity, onEditSpan, onContextMenuCell,
}: SpanBandProps): ReactElement {
  const meta = GROUP_META[entity.kind]
  const entityType = entity.kind as 'conflict' | 'faction' | 'item'
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } = useDraggable({
    id: `span:${entity.entityId}:${spanIndex}`,
    data: {
      source: 'span',
      entityType,
      entityId: entity.entityId,
      spanIndex,
      startChapter,
      endChapter,
    } satisfies SpanDragData,
  })
  const width = (endChapter - startChapter + 1) * cellWidth
  const left = (startChapter - 1) * cellWidth

  const handleContextMenu = (event: React.MouseEvent): void => {
    if (!onContextMenuCell) return
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    const offset = Math.floor((event.clientX - rect.left) / cellWidth)
    const chapter = Math.min(endChapter, Math.max(startChapter, startChapter + offset))
    onContextMenuCell(entity.entityId, entity.name, entityType, chapter, event.clientX, event.clientY)
  }

  return (
    <div
      className="group/band absolute z-[8] rounded"
      style={{ left, width, top: 7, height: ROW_H - 14 }}
    >
      <div
        ref={setNodeRef}
        className={cn(
          'relative h-full w-full rounded transition-[filter,opacity] hover:brightness-[1.03]',
          isDragging && 'opacity-35',
          isSelected && 'ring-2 ring-primary ring-offset-1 ring-offset-surface-1',
        )}
        style={{
          background: `rgba(${meta.colorRgb}, 0.22)`,
          border: `1px solid rgba(${meta.colorRgb}, 0.45)`,
          transform: transform ? `translate3d(${transform.x}px, 0, 0)` : undefined,
        }}
      >
        <div
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          className="absolute inset-0 z-[1] cursor-grab active:cursor-grabbing"
          {...hc(entity.name, `${startChapter} – ${endChapter}`, { after: '拖动平移 · 两端裁剪 · 双击编辑', color: meta.color })}
          onClick={(e) => {
            e.stopPropagation()
            onEntityClick({ multi: e.ctrlKey || e.metaKey })
          }}
          onDoubleClick={(e) => {
            e.stopPropagation()
            if (onEditEntity) onEditEntity(entity)
            else onEditSpan?.(entity)
          }}
          onContextMenu={handleContextMenu}
          aria-label={`${entity.name} 跨度，第 ${startChapter} 至 ${endChapter} 章`}
        />
        <EndpointHandle
          entityId={entity.entityId}
          entityType={entityType}
          spanIndex={spanIndex}
          end="start"
          origChapter={startChapter}
          side="left"
          color={meta.color}
          onContextMenu={onContextMenuCell
            ? (event) => onContextMenuCell(entity.entityId, entity.name, entityType, startChapter, event.clientX, event.clientY)
            : undefined}
        />
        <EndpointHandle
          entityId={entity.entityId}
          entityType={entityType}
          spanIndex={spanIndex}
          end="end"
          origChapter={endChapter}
          side="right"
          color={meta.color}
          onContextMenu={onContextMenuCell
            ? (event) => onContextMenuCell(entity.entityId, entity.name, entityType, endChapter, event.clientX, event.clientY)
            : undefined}
        />
      </div>
    </div>
  )
}

// ── 跨度端点拖拽手柄（hover 色带时浮现）──

interface EndpointHandleProps {
  entityId: string
  entityType: MatrixEntityKind
  spanIndex: number
  end: 'start' | 'end'
  origChapter: number
  side: 'left' | 'right'
  color: string
  onContextMenu?: (event: React.MouseEvent) => void
}

function EndpointHandle({ entityId, entityType, spanIndex, end, origChapter, side, color, onContextMenu }: EndpointHandleProps): ReactElement {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `endpoint:${entityId}:${spanIndex}:${end}`,
    data: {
      source: 'endpoint',
      entityType,
      entityId,
      spanIndex,
      end,
      origChapter,
    },
  })
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={onContextMenu ? (event) => {
        event.preventDefault()
        event.stopPropagation()
        onContextMenu(event)
      } : undefined}
      {...hc(end === 'start' ? '拖动调整起点' : '拖动调整终点', origChapter, {})}
      className={cn(
        'absolute top-1/2 -translate-y-1/2 z-[5] w-2.5 h-full flex items-center justify-center cursor-ew-resize',
        'opacity-0 group-hover/band:opacity-100 transition-opacity',
        side === 'left' ? 'left-0' : 'right-0',
        isDragging && 'opacity-0',
      )}
      style={{ touchAction: 'none' }}
    >
      <span className="w-[3px] h-3 rounded-full" style={{ background: color }} />
    </div>
  )
}

// ── 伏笔编码：连线 + beats 节点 ──

interface ForeshadowEncodingProps {
  entity: MatrixEntity
  cellWidth: number
  onEntityClick: (opts?: { multi?: boolean }) => void
  onContextMenuCell?: (entityId: string, entityName: string, entityType: MatrixEntityKind, chapter: number, x: number, y: number) => void
}

function ForeshadowEncoding({ entity, cellWidth, onEntityClick, onContextMenuCell }: ForeshadowEncodingProps): ReactElement | null {
  const meta = GROUP_META.foreshadow
  const plant = entity.plantChapter
  const payoff = entity.payoffChapter
  if (plant == null) return null
  const beats = entity.foreshadowBeats ?? []
  const lineEnd = beats.length > 1 ? beats[beats.length - 1].chapter : plant
  const recovered = payoff != null
  const lineLeft = (plant - 0.5) * cellWidth
  const lineWidth = Math.max(0, (lineEnd - plant) * cellWidth)

  const beatLabel = (t: string): string =>
    t === 'plant' ? '埋设' : t === 'reinforce' ? '强化' : t === 'reveal' ? '揭示' : '回收'

  return (
    <>
      {lineWidth > 0 && (
        <div
          aria-hidden="true"
          className="absolute top-1/2 -translate-y-1/2 pointer-events-none z-[2]"
          style={{
            left: lineLeft,
            width: lineWidth,
            borderTop: `2px ${recovered ? 'solid' : 'dashed'} rgba(${meta.colorRgb}, ${recovered ? 0.55 : 0.45})`,
          }}
        />
      )}
      {beats.map((beat) => {
        const x = (beat.chapter - 0.5) * cellWidth
        const isPlant = beat.type === 'plant'
        const isPayoff = beat.type === 'payoff'
        return (
          <span key={`beat-${beat.chapter}-${beat.type}`}>
            <span
              className="absolute z-[6] rounded-full cursor-pointer transition-transform hover:scale-125"
              style={{
                left: x,
                top: ROW_H / 2,
                width: 10,
                height: 10,
                transform: 'translate(-50%, -50%)',
                border: `2px solid ${meta.color}`,
                background: isPayoff ? meta.color : isPlant ? 'var(--color-surface-1)' : `rgba(${meta.colorRgb}, 0.45)`,
                boxShadow: beat.note ? '0 0 0 2px rgba(245,158,11,0.55)' : undefined,
              }}
              {...hc(entity.name, beat.chapter, { after: beatLabel(beat.type), desc: beat.note || undefined, color: meta.color })}
              onClick={(e) => {
                e.stopPropagation()
                onEntityClick()
              }}
              onContextMenu={(e) => {
                if (!onContextMenuCell) return
                e.preventDefault()
                e.stopPropagation()
                onContextMenuCell(entity.entityId, entity.name, entity.kind, beat.chapter, e.clientX, e.clientY)
              }}
            />
            {/* plant/payoff 端点拖拽手柄（覆盖在节点上的透明热区） */}
            {(isPlant || isPayoff) && (
              <ForeshadowEndpointHandle
                entityId={entity.entityId}
                end={isPlant ? 'start' : 'end'}
                origChapter={beat.chapter}
                left={x}
              />
            )}
          </span>
        )
      })}
    </>
  )
}

// 伏笔端点拖拽手柄（透明热区，视觉用 beat 节点）
function ForeshadowEndpointHandle({ entityId, end, origChapter, left }: {
  entityId: string
  end: 'start' | 'end'
  origChapter: number
  left: number
}): ReactElement {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `endpoint:${entityId}:0:${end}`,
    data: {
      source: 'endpoint',
      entityType: 'foreshadow',
      entityId,
      spanIndex: 0,
      end,
      origChapter,
    },
  })
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onDoubleClick={(e) => e.stopPropagation()}
      {...hc(end === 'start' ? '拖动调整埋设点' : '拖动调整回收点', origChapter, {})}
      className={cn('absolute z-[7] cursor-ew-resize', isDragging && 'opacity-0')}
      style={{ left: left - 8, top: ROW_H / 2 - 8, width: 16, height: 16, touchAction: 'none' }}
    />
  )
}

// ────────────────────────────────────────────────────────────
// 关系叠加层
// ────────────────────────────────────────────────────────────

function relationshipColor(alignment: string): string {
  switch (alignment) {
    case 'ally':
    case 'temporary_ally':
      return 'rgba(34,197,94,0.45)'
    case 'opponent':
    case 'temporary_opponent':
      return 'rgba(239,68,68,0.45)'
    case 'neutral':
      return 'rgba(115,115,115,0.35)'
    default:
      return 'rgba(59,130,246,0.35)'
  }
}

interface RelationshipOverlayProps {
  relationships: NovelRelationship[]
  entityRowY: Map<string, number>
  chapterColumnX: (chapter: number) => number
  visibleRange: { start: number; end: number }
  cellWidth: number
  sidebarWidth: number
}

function RelationshipOverlay({
  relationships, entityRowY, chapterColumnX, visibleRange, cellWidth, sidebarWidth,
}: RelationshipOverlayProps): ReactElement | null {
  const visibleRelations = useMemo(() => {
    const out: Array<{ rel: NovelRelationship; x: number; y1: number; y2: number; color: string }> = []
    for (const rel of relationships) {
      const y1 = entityRowY.get(rel.characterA)
      const y2 = entityRowY.get(rel.characterB)
      if (y1 == null || y2 == null) continue
      const chapter = rel.lastUpdatedChapter ?? Math.floor((visibleRange.start + visibleRange.end) / 2)
      if (chapter < visibleRange.start || chapter > visibleRange.end) continue
      const x = chapterColumnX(chapter)
      out.push({ rel, x, y1, y2, color: relationshipColor(rel.alignment) })
      if (out.length >= 50) break
    }
    return out
  }, [relationships, entityRowY, chapterColumnX, visibleRange])

  if (visibleRelations.length === 0) return null

  const svgLeft = sidebarWidth + (visibleRange.start - 1) * cellWidth
  const svgWidth = (visibleRange.end - visibleRange.start + 1) * cellWidth

  return (
    <svg
      className="absolute pointer-events-none z-[15]"
      style={{ left: svgLeft, top: 0, width: svgWidth, height: '100%' }}
      aria-hidden="true"
    >
      {visibleRelations.map(({ rel, x, y1, y2, color }) => {
        const innerX = x - svgLeft
        const midY = (y1 + y2) / 2
        const path = `M ${innerX},${y1} C ${innerX + 50},${y1} ${innerX - 50},${y2} ${innerX},${y2}`
        return (
          <g key={rel.id}>
            <path d={path} fill="none" stroke={color} strokeWidth={1.5} />
            {rel.relationType && (
              <text
                x={innerX}
                y={midY}
                fill={color.replace(/[\d.]+\)$/, '0.85)')}
                fontSize={10}
                textAnchor="middle"
                dominantBaseline="middle"
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >
                {rel.relationType}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}
