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
import { useDroppable, useDndMonitor } from '@dnd-kit/core'
import { useDrag } from '@use-gesture/react'
import { ChevronLeft, ChevronRight, LocateFixed } from 'lucide-react'
import type {
  NovelChapter,
  NovelRelationship,
  NovelMarker,
  NovelChangeRecord,
} from '@/api/novel-client'
import { listHooks, listCharacterArcs } from '@/api/novel-client'
import { cn } from '@/lib/utils'
import { computeVisibleChapters, getChapterNavigationTarget } from '@/lib/matrix-viewport'
import { runtimePerformance } from '@/config/performance'
import { useNovelDataStore } from '@/stores/novel-data-store'
import { useNovelUiStore } from '@/stores/novel-ui-store'
import {
  tensionToLabel,
  shiftChapterSpan,
  isMajorGridline,
  isMinorGridline,
  type MatrixData,
  type MatrixEntityKind,
  type MatrixEntity,
  type MatrixDragData,
  type SpanDragData,
} from './matrix-logic'
import {
  MATRIX_LAYOUT,
  buildRowSpecs,
  computeRowOffsets,
  computeVisibleRowWindow,
  buildSubtracksForEntity,
  type SubtrackDef,
} from './matrix-model'
import { MatrixSubtracks } from './matrix-subtracks'
import {
  hc,
  HookTrackRow,
  MatrixEmptyState,
  GroupRow,
  EntityRow,
} from './matrix-row'
import { RelationshipOverlay } from './matrix-overlay-svg'

const { rulerHeight: RULER_H, hookRowHeight: HOOK_H, sidebarWidth: SIDEBAR_DEFAULT } = MATRIX_LAYOUT

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
  /** T02-6 事件参与派生边（同事件实体两两成对，关系叠加层浅色边） */
  aggregationEventEdges?: Array<{ eventId: string; chapterNumber: number; from: string; to: string }>
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
  onMoveSpan?: (entityId: string, entityType: 'conflict' | 'faction' | 'item' | 'narrative', spanIndex: number, startChapter: number, endChapter: number) => void
  onMoveCell?: (entityId: string, entityType: MatrixEntityKind, fromChapter: number, toChapter: number) => void
  onTogglePresent?: (entity: MatrixEntity, chapter: number) => void

  expandedEntityIds?: string[]
  showRelationshipOverlay?: boolean
  /** 实体名称搜索（图例展开态输入，过滤可见行） */
  searchQuery?: string
}

export function MatrixView({
  matrixData, chapters, markers, relationships, aggregationChanges, aggregationEventEdges = [],
  playheadChapter, cellWidth, collapsedGroups, activeFilter,
  selectedNodeId, selectedMatrixEntityIds = [], showMarkers = true,
  onSelectEntity, onToggleCollapse, onPlayheadChange, onToggleEntityExpand, onCellWidthChange,
  onContextMenuChapter, onContextMenuCell, onContextMenuGroupEmpty, onEditEntity, onEditSpan,
  onDropEntity, onMoveEndpoint, onMoveSpan, onMoveCell, onTogglePresent,
  expandedEntityIds = [], showRelationshipOverlay = false,
  searchQuery = '',
}: MatrixViewProps): ReactElement {
  const { groups: rawGroups, maxChapter } = matrixData
  // ── 实体名称搜索：过滤分组内的实体（保留分组壳，空分组仍显示）──
  const groups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return rawGroups
    return rawGroups.map((g) => ({
      ...g,
      entities: g.entities.filter((e) => e.name.toLowerCase().includes(q)),
    }))
  }, [rawGroups, searchQuery])
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

  // ── 左侧 sticky 列收缩状态（持久化在 novel-ui-store，跨会话保留）──
  const matrixSidebarCollapsed = useNovelUiStore((s) => s.matrixSidebarCollapsed)
  const toggleMatrixSidebar = useNovelUiStore((s) => s.toggleMatrixSidebar)
  const SIDEBAR_COLLAPSED_W = 28

  // ── 左侧列宽拖拽（仅展开状态可用）──
  const [expandedSidebarWidth, setExpandedSidebarWidth] = useState<number>(SIDEBAR_DEFAULT)
  const sidebarWidth = matrixSidebarCollapsed ? SIDEBAR_COLLAPSED_W : expandedSidebarWidth
  const [isResizing, setIsResizing] = useState(false)
  const resizeStartRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const bindResize = useDrag(({ down, movement: [mx], first, event }) => {
    const evt = event as PointerEvent
    if (first) {
      resizeStartRef.current = { startX: evt.clientX, startWidth: expandedSidebarWidth }
      setIsResizing(true)
    }
    if (down && resizeStartRef.current) {
      setExpandedSidebarWidth(Math.max(120, Math.min(400, resizeStartRef.current.startWidth + mx)))
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
      overscan: runtimePerformance.matrix.overscanColumns,
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
      overscan: runtimePerformance.matrix.overscanRows,
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
    const handler = (e: WheelEvent): void => {
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
          overscan: runtimePerformance.matrix.overscanColumns,
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
              className="absolute z-[9] pointer-events-none -translate-x-1/2 rounded-md bg-blue-600 px-2 py-1 text-nano font-medium text-white shadow-lg whitespace-nowrap"
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
              className="absolute z-[9] pointer-events-none -translate-x-1/2 rounded-md bg-sky-600 px-2 py-1 text-nano font-medium text-white shadow-lg whitespace-nowrap tabular-nums"
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
        <div className="sticky top-0 z-40 flex border-b border-border/60 bg-surface-1" style={{ height: RULER_H }}>
          {/* 左侧 sticky 角 */}
          <div
            className={cn(
              'sticky left-0 z-30 bg-surface-1 flex items-center border-r border-border/60 shrink-0',
              matrixSidebarCollapsed ? 'justify-center px-0' : 'justify-between gap-2 px-2',
            )}
            style={{ width: sidebarWidth }}
          >
            {matrixSidebarCollapsed ? (
              <button
                type="button"
                onClick={toggleMatrixSidebar}
                className="inline-flex size-6 items-center justify-center rounded-md text-hint hover:bg-muted hover:text-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                aria-label="展开侧边栏"
                title="展开侧边栏"
              >
                <ChevronRight className="size-3.5" aria-hidden="true" />
              </button>
            ) : (
              <>
                <span className="text-nano text-hint tracking-wider whitespace-nowrap truncate">实体 ＼ 章节</span>
                <div className="flex items-center gap-0.5 shrink-0">
                  <button
                    type="button"
                    onClick={handleLocatePlayhead}
                    className={cn(
                      'inline-flex h-6 items-center gap-1 rounded-md px-1.5 font-mono text-nano tabular-nums transition-colors active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50',
                      isPlayheadVisible
                        ? 'text-muted-foreground hover:bg-muted hover:text-text'
                        : 'bg-amber-500/12 text-amber-500 hover:bg-amber-500/18',
                    )}
                    {...hc('定位播放头', playheadChapter, { after: `滚动到第 ${playheadChapter} 章` })}
                    aria-label={`定位到当前第 ${playheadChapter} 章`}
                  >
                    <LocateFixed className="size-3" aria-hidden="true" />
                    {String(playheadChapter).padStart(2, '0')}
                  </button>
                  <button
                    type="button"
                    onClick={toggleMatrixSidebar}
                    className="inline-flex size-6 items-center justify-center rounded-md text-hint hover:bg-muted hover:text-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    aria-label="收起侧边栏"
                    title="收起侧边栏"
                  >
                    <ChevronLeft className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
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
              </>
            )}
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
                    major ? 'border-r border-border/50' : 'border-r border-border/30',
                    isCurrent && 'bg-amber-500/[0.07]',
                  )}
                  style={{ width: cellWidth }}
                  onClick={(e) => { e.stopPropagation(); onPlayheadChange(ch); }}
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
                      'font-mono tracking-wide text-micro leading-none mb-1 tabular-nums',
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
            cellWidth={cellWidth}
            sidebarWidth={sidebarWidth}
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
                    visibleRange={visibleRange}
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

        {/* ── 关系叠加层（结构化关系 + 事件参与派生边）── */}
        {showRelationshipOverlay && (relationships.length > 0 || aggregationEventEdges.length > 0) && (
          <RelationshipOverlay
            relationships={relationships}
            eventEdges={aggregationEventEdges}
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
