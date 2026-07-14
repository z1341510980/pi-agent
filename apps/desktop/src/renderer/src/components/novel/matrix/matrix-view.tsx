/**
 * MatrixView：章节-实体矩阵主组件
 *
 * DOM 结构（关键）：每一行内含 [sticky 实体名列 + 章节单元格们]，
 * 整体一个水平滚动容器。这样实体名与单元格天然高度对齐，
 * 不再用"sidebar + view 两个独立容器 + sticky spacer 占位"的 hack。
 *
 * 布局：
 * - 横轴：章节（标尺：章节号 + 竖排标题）
 * - 纵轴：实体（按类型分组：角色/冲突/伏笔/势力/地点/世界要素）
 * - 左侧固定列：实体名（sticky left-0）
 * - 当前章节列：整列琥珀色高亮
 */

import { useMemo, useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useDroppable, useDndMonitor, useDraggable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { useDrag } from '@use-gesture/react'
import { Plus, ChevronRight, GripVertical } from 'lucide-react'
import type { NovelChapter, NovelRelationship, NovelConflict, NovelFaction, NovelMarker, ChapterEndingHookType, NovelHook, NovelCharacterArc } from '@/api/novel-client'
import { listHooks, listCharacterArcs } from '@/api/novel-client'
import { cn } from '@/lib/utils'
import { computeVisibleChapters } from '@/lib/matrix-viewport'
import { useNovelDataStore } from '@/stores/novel-data-store'
import { useNovelUiStore } from '@/stores/novel-ui-store'
import {
  buildGroups,
  computeCellSymbol,
  GROUP_META,
  GROUP_ORDER,
  tensionToBgClass,
  tensionToLabel,
  type MatrixEntityKind,
  type MatrixEntity,
  type MatrixGroup,
  type MatrixDragData,
  type EndpointDragData,
  type CellDragData,
} from './matrix-logic'

// 左侧固定实体名列宽度
const SIDEBAR_W = 200

export interface MatrixViewProps {
  chapters: NovelChapter[]
  characters: Parameters<typeof buildGroups>[0]['characters']
  conflicts: NovelConflict[]
  foreshadows: Parameters<typeof buildGroups>[0]['foreshadows']
  factions: NovelFaction[]
  locations: Parameters<typeof buildGroups>[0]['locations']
  worldElements: Parameters<typeof buildGroups>[0]['worldElements']
  characterHistory: Parameters<typeof buildGroups>[0]['characterHistory']
  relationships: NovelRelationship[]
  markers: NovelMarker[]
  /** 当前播放头章节（高亮整列） */
  playheadChapter: number
  /** 缩放：单元格宽度 px */
  cellWidth: number
  /** 折叠的分组 ID 集合 */
  collapsedGroups: Set<MatrixEntityKind>
  /** 过滤：只显示对应分组（null 表示全部） */
  activeFilter: MatrixEntityKind | null
  /** 当前选中的实体 ID（画布联动高亮） */
  selectedNodeId?: string | null
  /** 标记显示开关 */
  showMarkers?: boolean

  onSelectEntity: (entityType: MatrixEntityKind, entityId: string) => void
  onToggleCollapse: (kind: MatrixEntityKind) => void
  onPlayheadChange: (chapter: number) => void
  onContextMenuChapter: (chapterNumber: number, x: number, y: number) => void
  /** 右键单元格：标记/删除出场/修改批注 */
  onContextMenuCell?: (entityId: string, entityName: string, entityType: MatrixEntityKind, chapter: number, x: number, y: number) => void
  /** 右键分组空白：新建实体 */
  onContextMenuGroupEmpty?: (kind: MatrixEntityKind) => void
  /** 双击冲突/势力色带：编辑跨度 */
  onEditSpan?: (entity: MatrixEntity) => void
  /** 从 NovelSidebar 拖入实体到某章节列：标记出场 */
  onDropEntity?: (entityId: string, entityType: MatrixEntityKind, chapter: number) => void
  /** 拖动跨度端点（▲起点/▼终点）到新章节：调整 conflict/faction/foreshadow 起止
   *  spanIndex 标识 conflict/faction 多段跨度中的段索引（foreshadow 恒为 0） */
  onMoveEndpoint?: (entityId: string, entityType: MatrixEntityKind, spanIndex: number, end: 'start' | 'end', chapter: number) => void
  /** 拖动已出场单元格到新章节：移动 character/location 出场位置 */
  onMoveCell?: (entityId: string, entityType: MatrixEntityKind, fromChapter: number, toChapter: number) => void
  /** 左键单击单元格：智能切换出场状态（实体类型自适应） */
  onTogglePresent?: (entity: MatrixEntity, chapter: number) => void
}

// 标记颜色映射（marker.color → Tailwind bg class）
const MARKER_COLOR_CLASS: Record<string, string> = {
  blue: 'bg-blue-500',
  yellow: 'bg-yellow-500',
  green: 'bg-green-500',
  red: 'bg-red-500',
  purple: 'bg-purple-500',
}

function buildChapterTitleMap(chapters: NovelChapter[]): Map<number, string> {
  const m = new Map<number, string>()
  for (const c of chapters) m.set(c.chapterNumber, c.title)
  return m
}

function buildChapterByNumberMap(chapters: NovelChapter[]): Map<number, NovelChapter> {
  const m = new Map<number, NovelChapter>()
  for (const c of chapters) m.set(c.chapterNumber, c)
  return m
}

export function MatrixView({
  chapters, characters, conflicts, foreshadows, factions, locations, worldElements,
  characterHistory, markers, playheadChapter, cellWidth, collapsedGroups, activeFilter,
  selectedNodeId, showMarkers = true,
  onSelectEntity, onToggleCollapse, onPlayheadChange, onContextMenuChapter,
  onContextMenuCell, onContextMenuGroupEmpty, onEditSpan, onDropEntity, onMoveEndpoint, onMoveCell, onTogglePresent,
}: MatrixViewProps): ReactElement {
  const titleMap = useMemo(() => buildChapterTitleMap(chapters), [chapters])
  const chapterByNumber = useMemo(() => buildChapterByNumberMap(chapters), [chapters])

  const { groups, maxChapter } = useMemo(
    () => {
      const result = buildGroups({
        chapters, characters, conflicts, foreshadows, factions, locations, worldElements,
        characterHistory, markers,
      })
      return result
    },
    [chapters, characters, conflicts, foreshadows, factions, locations, worldElements, characterHistory, markers],
  )

  const chapterColumns = useMemo(() => {
    const cols: number[] = []
    for (let i = 1; i <= maxChapter; i++) cols.push(i)
    return cols
  }, [maxChapter])

  // 滚动容器 ref（提前定义，供 visibleRange 相关 hook 和滚动逻辑共用）
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  // 水平虚拟化：仅渲染可见章节列 + 缓冲列，DOM 从 O(N*M) 降为 O(N*visibleM)
  const [visibleRange, setVisibleRange] = useState<{ start: number; end: number }>(() => {
    // 初始值：保证 end >= start，避免空标尺
    const end = Math.max(1, Math.min(maxChapter, 20))
    return { start: 1, end }
  })

  // 视口重算逻辑（抽成函数，供 effect 和 ResizeObserver 复用）
  const recomputeVisibleRange = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) {
      return
    }
    const range = computeVisibleChapters({
      scrollLeft: el.scrollLeft,
      viewportWidth: el.clientWidth,
      sidebarWidth: SIDEBAR_W,
      cellWidth,
      maxChapter,
      overscan: 3,
    })
    setVisibleRange((prev) => {
      if (prev.start === range.start && prev.end === range.end) return prev
      return { start: range.start, end: range.end }
    })
  }, [cellWidth, maxChapter])

  // maxChapter 或 cellWidth 变化时，按当前 scrollLeft 重新计算视口（不重置到第 1 章）
  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) {
      // 容器还未挂载，clamp 既有 range 到新 maxChapter，保证 end >= 1
      setVisibleRange((prev) => {
        const next = { start: 1, end: Math.max(1, Math.min(prev.end, maxChapter)) }
        return next
      })
      return
    }
    recomputeVisibleRange()
  }, [maxChapter, cellWidth, recomputeVisibleRange])

  // ResizeObserver：容器尺寸变化时重算视口
  // 解决：tab 切换/窗口 resize/侧边栏拖宽后容器 clientWidth 从 0 变为实际值，
  // 但无 scroll 事件触发，导致 visibleRange 保持初始错误值，章节轴不显示。
  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      recomputeVisibleRange()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [recomputeVisibleRange])

  const visibleChapterColumns = useMemo(() => {
    if (visibleRange.start > visibleRange.end) {
      return []
    }
    const result = chapterColumns.slice(visibleRange.start - 1, visibleRange.end)
    return result
  }, [chapterColumns, visibleRange])

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

  // ── v0.2：章尾钩子实体（从 chapter.chapterEndingHook 字段迁移为独立实体）──
  // 钩子轨道行数据源切换：不再依赖 chapter.chapterEndingHook，改为从 hooks 实体查询。
  const currentProjectId = useNovelDataStore((s) => s.currentProjectId)
  const { data: hooks = [] } = useQuery({
    queryKey: ['novel', 'hooks', currentProjectId],
    queryFn: () => listHooks(currentProjectId!),
    enabled: !!currentProjectId,
    // 路由不存在（404）时不重试，避免拖累主矩阵渲染；占位空数组保证渲染期间有默认值
    retry: false,
    placeholderData: [],
  })

  // ── v0.2：角色弧光（独立实体，追踪角色成长/堕落/救赎/转变轨迹）──
  const { data: characterArcs = [] } = useQuery({
    queryKey: ['novel', 'character-arcs', currentProjectId],
    queryFn: () => listCharacterArcs(currentProjectId!),
    enabled: !!currentProjectId,
    // 路由不存在（404）时不重试，避免拖累主矩阵渲染；占位空数组保证渲染期间有默认值
    retry: false,
    placeholderData: [],
  })

  // ── C-3c 滚动到指定章节列（监听 store 的 matrixScrollTarget）──
  const matrixScrollTarget = useNovelUiStore((s) => s.matrixScrollTarget)
  useEffect(() => {
    if (!matrixScrollTarget) return
    const el = scrollContainerRef.current
    if (!el) return
    const targetLeft = SIDEBAR_W + (matrixScrollTarget.chapter - 1) * cellWidth
    // 居中显示：减去视口宽度的一半
    const scrollTo = Math.max(0, targetLeft - el.clientWidth / 2 + cellWidth / 2)
    el.scrollTo({ left: scrollTo, behavior: 'smooth' })
  }, [matrixScrollTarget, cellWidth])

  const handleRulerClick = useCallback((chapter: number) => {
    onPlayheadChange(chapter)
  }, [onPlayheadChange])

  const handleRulerContextMenu = useCallback((e: React.MouseEvent, chapter: number) => {
    e.preventDefault()
    onContextMenuChapter(chapter, e.clientX, e.clientY)
  }, [onContextMenuChapter])

  const handleEntityClick = useCallback((entity: MatrixEntity) => {
    onSelectEntity(entity.entityType, entity.entityId)
  }, [onSelectEntity])

  // ── 拖入实体到章节列：@dnd-kit 放置区 + 坐标计算章节号 ──
  const [dragOverChapter, setDragOverChapter] = useState<number | null>(null)
  const [flashChapter, setFlashChapter] = useState<number | null>(null)

  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: 'matrix-grid' })

  // 从拖拽元素的实时 translated rect 计算其中心所在章节列。
  // 使用 active.rect.current.translated（@dnd-kit 在拖动期间持续更新），
  // 相对滚动容器做坐标换算，与原 native 实现 computeChapterFromEvent 语义一致。
  const computeChapterFromRect = useCallback((rect: { left: number; width: number } | null | undefined): number | null => {
    const el = scrollContainerRef.current
    if (!el || !rect) return null
    const containerRect = el.getBoundingClientRect()
    const contentX = rect.left + rect.width / 2 - containerRect.left + el.scrollLeft
    const colX = contentX - SIDEBAR_W
    if (colX < 0) return null
    const ch = Math.floor(colX / cellWidth) + 1
    if (ch < 1 || ch > maxChapter) return null
    return ch
  }, [cellWidth, maxChapter])

  // useDndMonitor：监听 DndContext 内所有拖拽事件，MatrixView 自包含高亮 + 放置分发。
  // onDragMove 仅在章节变化时 setState，避免高频 re-render。
  useDndMonitor({
    onDragMove: ({ active }) => {
      const ch = computeChapterFromRect(active.rect.current.translated)
      setDragOverChapter((prev) => (prev === ch ? prev : ch))
    },
    onDragEnd: ({ active, over }) => {
      setDragOverChapter(null)
      if (!over || over.id !== 'matrix-grid') return
      const ch = computeChapterFromRect(active.rect.current.translated)
      if (ch == null) return
      const data = active.data.current as MatrixDragData | undefined
      if (!data) return
      switch (data.source) {
        case 'sidebar':
          onDropEntity?.(data.entityId, data.entityType, ch)
          break
        case 'endpoint':
          onMoveEndpoint?.(data.entityId, data.entityType, data.spanIndex, data.end, ch)
          break
        case 'cell':
          // 同章拖动视为无操作（避免误触删除后再添加）
          if (data.chapter !== ch) {
            onMoveCell?.(data.entityId, data.entityType, data.chapter, ch)
          }
          break
      }
      // 触发闪烁反馈
      setFlashChapter(ch)
      window.setTimeout(() => setFlashChapter(null), 800)
    },
    onDragCancel: () => {
      setDragOverChapter(null)
    },
  })

  // ── 鼠标按住拖动滚动（pan-to-scroll）──
  // 用 @use-gesture/react 的 useDrag 实现，替代手写 mousedown/mousemove。
  // - filterTaps:true + threshold:6 → 位移 <6px 视为 tap（不吞 click），≥6px 才进入 pan
  //   与 @dnd-kit PointerSensor activationConstraint.distance 对齐，消除 1px 空窗
  // - pointer:{ buttons:1 } → 仅左键启动
  // - mousedown 时 target 过滤：在 draggable / 表单控件 / 带 data-tip 的单元格上不启动，
  //   让 @dnd-kit 和 click 各司其职
  const [isPanning, setIsPanning] = useState(false)
  const panStartRef = useRef<{ startX: number; startScrollLeft: number } | null>(null)

  const bindPan = useDrag(({ down, movement: [mx], first, cancel, event }) => {
    const evt = event as PointerEvent
    // 首次触发时校验 target：交互元素上 cancel 整个手势
    if (first) {
      const target = evt.target as HTMLElement
      if (
        target.closest('[aria-roledescription="draggable"]') ||
        target.closest('button, a, input, select, textarea, [role="button"]') ||
        target.closest('[data-tip]')
      ) {
        cancel()
        return
      }
      const el = scrollContainerRef.current
      if (!el) {
        cancel()
        return
      }
      panStartRef.current = { startX: evt.clientX, startScrollLeft: el.scrollLeft }
    }

    // down=true 表示手势进行中；一旦超过 threshold 进入 panning 状态
    if (down && panStartRef.current) {
      setIsPanning(true)
      const el = scrollContainerRef.current
      if (el) {
        el.scrollLeft = panStartRef.current.startScrollLeft - mx
      }
    } else {
      // up：结束 pan，清理状态
      setIsPanning(false)
      panStartRef.current = null
    }
  }, {
    filterTaps: true,
    threshold: 6,
    pointer: { buttons: 1 },
  })

  // 整体内容宽度
  const totalWidth = SIDEBAR_W + maxChapter * cellWidth
  // 当前章节列高亮 left（在内容容器内）
  const highlightLeft = SIDEBAR_W + (playheadChapter - 1) * cellWidth

  // ── C-1 空状态判定 ──
  const hasAnyEntity = groups.some((g) => g.entities.length > 0)

  return (
    <div
      ref={(el) => {
        scrollContainerRef.current = el
        setDropRef(el)
      }}
      className={cn(
        'relative overflow-x-auto overflow-y-auto h-full isolate touch-none',
        isPanning ? 'cursor-grabbing select-none' : 'cursor-default',
      )}
      {...bindPan()}
      onScroll={(e) => {
        const el = e.currentTarget
        const x = el.scrollLeft
        // 水平虚拟化视口计算
        const range = computeVisibleChapters({
          scrollLeft: x,
          viewportWidth: el.clientWidth,
          sidebarWidth: SIDEBAR_W,
          cellWidth,
          maxChapter,
          overscan: 3,
        })
        setVisibleRange((prev) => {
          if (prev.start === range.start && prev.end === range.end) return prev
          return { start: range.start, end: range.end }
        })
      }}
    >
      <div style={{ width: `${totalWidth}px` }}>
        {/* 当前章节列高亮带（跨整列，从标尺下方开始避免被 sticky 标尺遮挡） */}
        <div
          className="absolute top-[44px] bottom-0 pointer-events-none z-[5] border-x border-amber-500/30"
          style={{ left: `${highlightLeft}px`, width: `${cellWidth}px`, background: 'rgba(245, 158, 11, 0.07)' }}
          aria-hidden="true"
        />

        {/* 拖入反馈：高亮目标章节列（仅在拖拽元素悬停于矩阵上时显示） */}
        {isOver && dragOverChapter != null && (
          <div
            className="absolute top-[44px] bottom-0 pointer-events-none z-[7] border-x border-blue-500/60 rounded-sm"
            style={{
              left: `${SIDEBAR_W + (dragOverChapter - 1) * cellWidth}px`,
              width: `${cellWidth}px`,
              background: 'rgba(59, 130, 246, 0.18)',
            }}
            aria-hidden="true"
          />
        )}

          {/* 释放后闪烁反馈：蓝色脉冲 */}
          {flashChapter != null && (
            <div
              className="absolute top-[44px] bottom-0 pointer-events-none z-[8] border-2 border-blue-500 rounded-sm animate-pulse"
              style={{
                left: `${SIDEBAR_W + (flashChapter - 1) * cellWidth}px`,
                width: `${cellWidth}px`,
                background: 'rgba(59, 130, 246, 0.25)',
                boxShadow: '0 0 12px rgba(59, 130, 246, 0.6)',
              }}
              aria-hidden="true"
            />
          )}

          {/* 标尺行（sticky top，垂直滚动时固定） */}
          <div className="sticky top-0 z-40 flex h-[44px] border-b border-border bg-surface-1">
            {/* 当前章节列在标尺内的高亮（top-0 到 44px） */}
            <div
              className="absolute top-0 h-full pointer-events-none z-[1] border-x border-amber-500/30"
              style={{ left: `${highlightLeft}px`, width: `${cellWidth}px`, background: 'rgba(245, 158, 11, 0.07)' }}
              aria-hidden="true"
            >
              <div
                className="absolute top-0 -left-px -right-px h-0.5"
                style={{
                  background: 'linear-gradient(90deg, transparent, rgb(245 158 11), transparent)',
                  boxShadow: '0 0 6px rgba(245, 158, 11, 0.6)',
                }}
              />
            </div>
            {/* 左侧 sticky 列：实体＼章节 */}
            <div className="sticky left-0 z-30 bg-surface-1 flex items-center justify-end pr-3 border-r border-border shrink-0" style={{ width: `${SIDEBAR_W}px` }}>
              <span className="font-serif text-[11px] text-hint tracking-wider">实体 ＼ 章节</span>
            </div>
            {/* 章节标尺单元格（仅渲染可见列） */}
            <div className="flex">
              {/* 左侧占位：撑开滚动条到第一个可见章节的位置 */}
              {visibleRange.start > 1 && (
                <div style={{ width: `${(visibleRange.start - 1) * cellWidth}px` }} aria-hidden="true" />
              )}
              {visibleChapterColumns.map((ch) => {
                const isCurrent = ch === playheadChapter
                const title = titleMap.get(ch) ?? ''
                const ms = markersByChapter.get(ch) ?? []
                const chapter = chapterByNumber.get(ch)
                const tensionBg = chapter?.tension ? tensionToBgClass(chapter.tension) : ''
                const tensionLabel = chapter?.tension ? tensionToLabel(chapter.tension) : ''
                const tip = `第 ${ch} 章${title ? ' · ' + title : ''}${chapter?.tension ? ` · 张力 ${chapter.tension} (${tensionLabel})` : ''}${isCurrent ? '（当前章节）' : ''}`
                return (
                  <div
                    key={ch}
                    className={`relative h-full shrink-0 flex flex-col justify-center items-center gap-1 border-r border-border/40 cursor-pointer transition-colors hover:bg-muted/40 ${tensionBg}`}
                    style={{ width: `${cellWidth}px` }}
                    onClick={() => handleRulerClick(ch)}
                    onContextMenu={(e) => handleRulerContextMenu(e, ch)}
                    data-tip={tip}
                  >
                    {ms.length > 0 && (
                      <div className="flex gap-0.5 absolute top-1 left-1/2 -translate-x-1/2">
                        {ms.map((m) => (
                          <span
                            key={m.id}
                            className={`w-1.5 h-1.5 rounded-full border border-white/30 ${MARKER_COLOR_CLASS[m.color] ?? 'bg-muted-foreground'}`}
                            data-tip={`${m.title}${m.note ? '：' + m.note : ''}`}
                          />
                        ))}
                      </div>
                    )}
                    <span className={`font-mono text-[11px] tracking-wide ${isCurrent ? 'text-amber-500 font-semibold' : 'text-hint'}`}>
                      {String(ch).padStart(2, '0')}
                    </span>
                    {tensionLabel && (
                      <span className="text-[9px] text-hint/70 mt-0.5">{tensionLabel}</span>
                    )}
                  </div>
                )
              })}
              {/* 右侧占位：撑开滚动条到最后一个可见章节之后的位置 */}
              {visibleRange.end < maxChapter && (
                <div style={{ width: `${(maxChapter - visibleRange.end) * cellWidth}px` }} aria-hidden="true" />
              )}
            </div>
          </div>

          {/* 章尾钩子轨道行（仅当存在任何已设定钩子的章节时显示） */}
          <HookTrackRow
            hooks={hooks}
            visibleChapterColumns={visibleChapterColumns}
            visibleRange={visibleRange}
            maxChapter={maxChapter}
            cellWidth={cellWidth}
            playheadChapter={playheadChapter}
          />

          {/* 分组 + 实体行：统一用 MatrixRow 渲染（分组行是 type='group' 的变体） */}
          {hasAnyEntity ? (
            groups.flatMap((group) => {
              if (activeFilter != null && group.id !== activeFilter) return []
              const meta = GROUP_META[group.id]
              const collapsed = collapsedGroups.has(group.id)
              const rows: ReactElement[] = []
              // 分组分隔行（与实体行用同一个 MatrixRow 组件，type='group'）
              rows.push(
                <MatrixRow
                  key={`divider-${group.id}`}
                  type="group"
                  group={group}
                  collapsed={collapsed}
                  visibleChapterColumns={visibleChapterColumns}
                  visibleRange={visibleRange}
                  maxChapter={maxChapter}
                  cellWidth={cellWidth}
                  color={meta.color}
                  colorRgb={meta.colorRgb}
                  icon={meta.icon}
                  onToggleCollapse={() => onToggleCollapse(group.id)}
                  onContextMenuGroupEmpty={onContextMenuGroupEmpty}
                />
              )
              if (!collapsed) {
                for (const entity of group.entities) {
                  rows.push(
                    <MatrixRow
                      key={entity.id}
                      type="entity"
                      entity={entity}
                      visibleChapterColumns={visibleChapterColumns}
                      visibleRange={visibleRange}
                      titleMap={titleMap}
                      maxChapter={maxChapter}
                      cellWidth={cellWidth}
                      isSelected={selectedNodeId === entity.entityId}
                      characterArcs={characterArcs}
                      onClick={() => handleEntityClick(entity)}
                      onContextMenuCell={onContextMenuCell}
                      onEditSpan={onEditSpan}
                      onTogglePresent={onTogglePresent}
                    />
                  )
                }
                if (group.entities.length === 0) {
                  rows.push(
                    <div
                      key={`empty-${group.id}`}
                      className="h-10 border-b border-border/20"
                      onContextMenu={(e) => {
                        if (!onContextMenuGroupEmpty) return
                        e.preventDefault()
                        onContextMenuGroupEmpty(group.id)
                      }}
                    />
                  )
                }
              }
              return rows
            })
          ) : (
            <MatrixEmptyState />
          )}
        </div>
      </div>
  )
}

// ── 章尾钩子轨道行 ──

/** 钩子类型 → 显示元数据（颜色/图标/标签） */
const HOOK_META: Record<ChapterEndingHookType, { color: string; bg: string; icon: string; label: string }> = {
  suspense:  { color: '#a855f7', bg: 'rgba(168, 85, 247, 0.22)', icon: '?', label: '悬念' },
  reversal:  { color: '#ef4444', bg: 'rgba(239, 68, 68, 0.22)',  icon: '!', label: '反转' },
  emotional: { color: '#ec4899', bg: 'rgba(236, 72, 153, 0.22)', icon: '♥', label: '情感' },
  action:    { color: '#f97316', bg: 'rgba(249, 115, 22, 0.22)', icon: '⚡', label: '动作' },
  none:      { color: '#6b7280', bg: 'transparent',              icon: '',  label: '无'   },
}

interface HookTrackRowProps {
  hooks: NovelHook[]
  visibleChapterColumns: number[]
  visibleRange: { start: number; end: number }
  maxChapter: number
  cellWidth: number
  playheadChapter: number
}

function HookTrackRow({
  hooks, visibleChapterColumns, visibleRange, maxChapter, cellWidth, playheadChapter,
}: HookTrackRowProps): ReactElement | null {
  // 按 chapterNumber 分组 hooks（一章可能有多个钩子，通常只有一个）
  const hooksByChapter = useMemo(() => {
    const m = new Map<number, NovelHook[]>()
    for (const h of hooks) {
      const arr = m.get(h.chapterNumber) ?? []
      arr.push(h)
      m.set(h.chapterNumber, arr)
    }
    return m
  }, [hooks])

  // 仅当存在任何钩子时显示该轨道行
  if (hooks.length === 0) return null

  return (
    <div className="relative z-[1] flex h-7 border-b border-border/20 hover:bg-muted/30 transition-colors">
      {/* 左侧 sticky 列：轨道标签 */}
      <div
        className="sticky left-0 z-30 flex items-center justify-end pr-2 border-r border-border shrink-0"
        style={{ width: `${SIDEBAR_W}px`, backgroundColor: 'var(--color-surface-1)' }}
      >
        <span className="font-serif text-[10px] text-hint tracking-wider">章尾钩子</span>
      </div>
      {/* 钩子单元格（仅渲染可见列） */}
      <div className="flex relative">
        {/* 左侧占位 */}
        {visibleRange.start > 1 && (
          <div style={{ width: `${(visibleRange.start - 1) * cellWidth}px` }} aria-hidden="true" />
        )}
        {visibleChapterColumns.map((ch) => {
          const chapterHooks = hooksByChapter.get(ch) ?? []
          const isCurrent = ch === playheadChapter
          // 单元格背景：取第一个钩子的类型颜色（多钩子时用主钩子着色）
          const primaryHook = chapterHooks[0]
          const meta = primaryHook ? HOOK_META[primaryHook.hookType] : null
          const tip = chapterHooks.length === 0
            ? `第 ${ch} 章 · 未设定`
            : chapterHooks.map((h) => {
                const hm = HOOK_META[h.hookType]
                const statusLabel =
                  h.status === 'fulfilled' ? '已兑现' :
                  h.status === 'thrown' ? '已抛出' : '已放弃'
                return `${hm.label}钩子（${statusLabel}）${h.description ? '：' + h.description : ''}`
              }).join('｜')
          return (
            <div
              key={ch}
              className={cn(
                'relative h-full shrink-0 flex items-center justify-center gap-0.5 border-r border-border/30',
                isCurrent && 'bg-amber-500/5',
              )}
              style={{
                width: `${cellWidth}px`,
                background: meta && primaryHook?.hookType !== 'none' ? meta.bg : undefined,
              }}
              data-tip={tip}
            >
              {chapterHooks.length === 1 && primaryHook && primaryHook.hookType !== 'none' && (
                <HookGlyph hook={primaryHook} meta={HOOK_META[primaryHook.hookType]} />
              )}
              {chapterHooks.length > 1 && (
                <div className="flex items-center gap-0.5">
                  {chapterHooks.slice(0, 4).map((h) => {
                    const hm = HOOK_META[h.hookType]
                    if (h.hookType === 'none') return null
                    return <HookDot key={h.id} hook={h} color={hm.color} />
                  })}
                </div>
              )}
            </div>
          )
        })}
        {/* 右侧占位 */}
        {visibleRange.end < maxChapter && (
          <div style={{ width: `${(maxChapter - visibleRange.end) * cellWidth}px` }} aria-hidden="true" />
        )}
      </div>
    </div>
  )
}

// ── 弧光类型元数据（角色行叠加标记用） ──

/** 弧光类型 → 显示元数据（颜色/背景/标签） */
const ARC_TYPE_META: Record<string, { label: string; color: string; bg: string }> = {
  growth: { label: '成长', color: '#10b981', bg: 'rgba(16,185,129,0.15)' },
  fall: { label: '堕落', color: '#ef4444', bg: 'rgba(239,68,68,0.15)' },
  redemption: { label: '救赎', color: '#a855f7', bg: 'rgba(168,85,247,0.15)' },
  shift: { label: '转变', color: '#3b82f6', bg: 'rgba(59,130,246,0.15)' },
}

// 单钩子图标：保持原圆形带字符样式，根据兑现状态区分实心/虚线
// - fulfilled：实心填充（类型色背景 + 白字）
// - thrown：空心虚线边框（半透明，暗示"待兑现"）
// - abandoned：空心虚线边框（更淡，暗示"已放弃"）
function HookGlyph({ hook, meta }: {
  hook: NovelHook
  meta: { color: string; icon: string; label: string }
}): ReactElement {
  const isFulfilled = hook.status === 'fulfilled'
  const isAbandoned = hook.status === 'abandoned'
  return (
    <span
      className="flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold leading-none"
      style={{
        color: isFulfilled ? '#fff' : meta.color,
        background: isFulfilled ? meta.color : undefined,
        border: `1px ${isFulfilled ? 'solid' : 'dashed'} ${meta.color}`,
        opacity: isAbandoned ? 0.35 : (hook.status === 'thrown' ? 0.75 : 1),
      }}
      aria-label={meta.label}
    >
      {meta.icon}
    </span>
  )
}

// 多钩子小圆点（每钩子一个点，颜色对应类型，状态决定实心/虚线）
function HookDot({ hook, color }: { hook: NovelHook; color: string }): ReactElement {
  const isFulfilled = hook.status === 'fulfilled'
  const isAbandoned = hook.status === 'abandoned'
  return (
    <span
      className="rounded-full"
      style={{
        width: 6,
        height: 6,
        background: isFulfilled ? color : 'transparent',
        border: `1px ${isFulfilled ? 'solid' : 'dashed'} ${color}`,
        opacity: isAbandoned ? 0.35 : (hook.status === 'thrown' ? 0.75 : 1),
      }}
    />
  )
}

// ── C-1 空状态引导 ──

function MatrixEmptyState(): ReactElement {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="text-center max-w-sm">
        <div className="mx-auto mb-3 w-12 h-12 rounded-full bg-muted/40 flex items-center justify-center text-2xl text-hint">
          ◇
        </div>
        <p className="text-sm font-medium text-text mb-1.5">暂无实体出场记录</p>
        <p className="text-xs text-muted-foreground leading-relaxed">
          请点击上方「补全历史」让 AI 自动补全角色起始章节，
          或从左侧 <span className="text-text font-medium">NovelSidebar</span> 新建实体后，
          <span className="text-text font-medium">左键单击空单元格</span>标记出场，
          <span className="text-text font-medium">右键单元格</span>删除出场或修改范围。
        </p>
      </div>
    </div>
  )
}

// ── 统一行组件（分组行 + 实体行共用同一 DOM 结构，确保 sticky 行为一致） ──
// 对照 preview-html：.matrix-row { display:flex; align-items:stretch; height:32px } 无 position:relative
// 左侧 sticky 列：.entity-name-cell / .group-label-cell { position:sticky; left:0; z-index:6; 不透明背景 }

interface MatrixRowProps {
  type: 'group' | 'entity'
  // group 类型所需
  group?: MatrixGroup
  collapsed?: boolean
  color?: string
  colorRgb?: string
  icon?: string
  onToggleCollapse?: () => void
  onContextMenuGroupEmpty?: (kind: MatrixEntityKind) => void
  // entity 类型所需
  entity?: MatrixEntity
  titleMap?: Map<number, string>
  isSelected?: boolean
  characterArcs?: NovelCharacterArc[]
  onClick?: () => void
  onContextMenuCell?: (entityId: string, entityName: string, entityType: MatrixEntityKind, chapter: number, x: number, y: number) => void
  onEditSpan?: (entity: MatrixEntity) => void
  onTogglePresent?: (entity: MatrixEntity, chapter: number) => void
  // 共用
  visibleChapterColumns: number[]
  visibleRange: { start: number; end: number }
  maxChapter: number
  cellWidth: number
}

function MatrixRow(props: MatrixRowProps): ReactElement {
  const {
    type, group, collapsed, color, colorRgb, icon, onToggleCollapse, onContextMenuGroupEmpty,
    entity, titleMap, isSelected, characterArcs, onClick,
    onContextMenuCell, onEditSpan, onTogglePresent,
    visibleChapterColumns, visibleRange, maxChapter, cellWidth,
  } = props

  // ── 角色弧光标记（仅 entity 类型） ──
  const arcMarkers = useMemo(() => {
    if (type !== 'entity' || !entity || entity.kind !== 'character' || !characterArcs || characterArcs.length === 0) return []
    const arc = characterArcs.find((a) => a.characterId === entity.entityId)
    if (!arc || arc.stageHistory.length === 0) return []
    return arc.stageHistory.map((entry) => {
      const am = ARC_TYPE_META[arc.arcType] ?? ARC_TYPE_META.growth
      return {
        chapter: entry.chapterNumber,
        label: am.label,
        color: am.color,
        bg: am.bg,
        stage: entry.stage,
        triggerEvent: entry.triggerEvent,
      }
    })
  }, [type, entity, characterArcs])

  const isGroup = type === 'group'
  const meta = entity ? GROUP_META[entity.kind] : null

  // 行容器：严格按 preview-html 的 .matrix-row（无 position:relative）
  // 分组行额外加 .group-divider 的背景和边框样式
  const rowClassName = cn(
    'flex h-7 z-[6] border-b border-border/20',
    isGroup
      ? 'cursor-pointer'
      : cn('cursor-pointer transition-colors', isSelected ? 'bg-primary/10' : 'hover:bg-muted/30'),
  )
  const rowStyle = isGroup
    ? {
        background: `rgba(${colorRgb}, 0.08)`,
        borderBottom: `1px solid rgba(${colorRgb}, 0.3)`,
        borderTop: `1px solid rgba(${colorRgb}, 0.12)`,
      }
    : undefined
  const rowOnClick = isGroup ? onToggleCollapse : onClick

  // 左侧 sticky 列：严格按 preview-html 的 .entity-name-cell / .group-label-cell
  // position:sticky; left:0; z-index:6/30; 不透明背景; border-right
  const leftCellClassName = cn(
    'sticky left-0 z-30 flex items-center gap-2 px-3 border-r border-border shrink-0',
    isGroup
      ? 'cursor-pointer'
      : cn('transition-colors', isSelected ? 'bg-primary/10' : 'hover:bg-muted/50'),
  )
  const leftCellStyle = {
    width: `${SIDEBAR_W}px`,
    backgroundColor: isGroup
      ? 'var(--color-surface-1)'
      : (isSelected ? undefined : 'var(--color-surface-1)'),
  }

  return (
    <div
      className={rowClassName}
      style={rowStyle}
      onClick={rowOnClick}
    >
      {/* 左侧 sticky 列 */}
      <div
        className={leftCellClassName}
        style={leftCellStyle}
        data-tip={isGroup
          ? (collapsed ? `展开${group!.name}` : `折叠${group!.name}`)
          : undefined}
      >
        {isGroup ? (
          <>
            <span className={cn('text-[9px] text-hint transition-transform w-2 inline-block shrink-0', collapsed && '-rotate-90')}>▼</span>
            <span className="text-[10px] leading-none shrink-0" style={{ color }}>{icon}</span>
            <span className="font-semibold text-xs text-text tracking-wide truncate flex-1">{group!.name}</span>
            <span className="font-mono text-[10px] text-hint bg-surface-1 border border-border px-1.5 py-px rounded tabular-nums shrink-0">
              {group!.entities.length}
            </span>
            <button
              type="button"
              className="ml-1 size-6 inline-flex items-center justify-center rounded border border-dashed border-border text-muted-foreground hover:border-primary hover:bg-primary/10 hover:text-primary transition-[color,background-color,border-color,transform] active:scale-[0.96] shrink-0"
              onClick={(e) => {
                e.stopPropagation()
                onContextMenuGroupEmpty?.(group!.id)
              }}
              data-tip={`新建${group!.name}`}
              aria-label={`新建${group!.name}`}
            >
              <Plus className="size-4" />
            </button>
          </>
        ) : (
          <>
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: meta!.color }} />
            <span className={cn('truncate flex-1 text-xs', isSelected ? 'text-primary font-medium' : 'text-muted-foreground')}>{entity!.name}</span>
            {entity!.isProtagonist && (
              <span className="text-[9px] text-amber-500 font-semibold shrink-0">主</span>
            )}
            <ChevronRight className={cn('size-3 text-muted-foreground shrink-0 transition-opacity', isSelected ? 'opacity-100 text-primary' : 'opacity-0')} />
            {isSelected && <span className="absolute right-0 top-0 bottom-0 w-0.5 bg-primary" />}
          </>
        )}
      </div>

      {/* 右侧单元格容器 */}
      <div
        className="relative flex"
        onContextMenu={isGroup ? (e) => {
          if (!onContextMenuGroupEmpty) return
          e.preventDefault()
          onContextMenuGroupEmpty(group!.id)
        } : undefined}
      >
        {visibleRange.start > 1 && (
          <div aria-hidden="true" style={{ width: `${(visibleRange.start - 1) * cellWidth}px` }} />
        )}
        {isGroup ? (
          visibleChapterColumns.map((ch) => (
            <div key={ch} className="shrink-0 border-r border-border/40" style={{ width: `${cellWidth}px` }} />
          ))
        ) : (
          visibleChapterColumns.map((ch) => (
            <Cell
              key={ch}
              entity={entity!}
              chapter={ch}
              chapterTitle={titleMap!.get(ch) ?? ''}
              color={meta!.color}
              cellWidth={cellWidth}
              onTogglePresent={onTogglePresent}
              onContextMenu={(e) => {
                if (!onContextMenuCell) return
                e.preventDefault()
                onContextMenuCell(entity!.entityId, entity!.name, entity!.kind, ch, e.clientX, e.clientY)
              }}
            />
          ))
        )}
        {visibleRange.end < maxChapter && (
          <div aria-hidden="true" style={{ width: `${(maxChapter - visibleRange.end) * cellWidth}px` }} />
        )}
        {/* 跨度叠加层 + 弧光标记（仅 entity 类型） */}
        {!isGroup && entity && (
          <>
            <EntityOverlay
              entity={entity}
              maxChapter={maxChapter}
              cellWidth={cellWidth}
              color={meta!.color}
              colorRgb={meta!.colorRgb}
              onEditSpan={onEditSpan}
              onContextMenuCell={onContextMenuCell}
              onEntityClick={onClick ?? (() => {})}
              onTogglePresent={onTogglePresent}
            />
            {arcMarkers.length > 0 && arcMarkers.map((m, i) => {
              const left = (m.chapter - 1) * cellWidth + cellWidth / 2 - 6
              return (
                <span
                  key={`arc-${i}`}
                  className="absolute top-0 z-[5] inline-flex items-center justify-center w-3 h-3 rounded-sm text-[8px] font-bold leading-none pointer-events-none ring-1 ring-surface-1"
                  style={{ left, color: m.color, background: m.bg }}
                  title={`${m.label}弧光 → ${m.stage}：${m.triggerEvent}`}
                >
                  {m.label[0]}
                </span>
              )
            })}
          </>
        )}
      </div>

      {/* 选中环 + 批注提示（仅 entity 类型） */}
      {!isGroup && isSelected && (
        <span className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-primary/40" />
      )}
      {!isGroup && entity?.note && (
        <div className="absolute right-1 top-1/2 -translate-y-1/2 text-amber-500 text-sm leading-none pointer-events-none opacity-70" style={{ position: 'absolute' }} data-tip={`批注：${entity.note}`}>·</div>
      )}
    </div>
  )
}

// ── 单元格 ──

interface CellProps {
  entity: MatrixEntity
  chapter: number
  chapterTitle: string
  color: string
  cellWidth: number
  onTogglePresent?: (entity: MatrixEntity, chapter: number) => void
  onContextMenu?: (e: React.MouseEvent) => void
}

function Cell({ entity, chapter, chapterTitle, color, cellWidth, onTogglePresent, onContextMenu }: CellProps): ReactElement {
  // 交互模型（click 永远非破坏性，破坏性操作走拖拽或右键）：
  // - 空单元格 click → 标记出场（构造性，无拖拽，无冲突）
  // - 已出场单元格(character/location) → 拖拽换章；click 不触发删除，冒泡到 EntityRow 选中实体
  // - 删除出场 → 右键菜单（EntityCellMenu）
  // - 跨度中段格 → 只读，点击无操作
  const symbol = computeCellSymbol(entity, chapter)
  const tip = symbol.type === 'empty'
    ? buildEmptyCellTip(entity, chapter, chapterTitle)
    : buildCellTooltip(symbol, entity, chapter, chapterTitle)

  const handleCellClickEvent = useCallback((e: React.MouseEvent) => {
    // 阻止冒泡到 EntityRow 的 onClick（行首点击才选中实体）
    e.stopPropagation()
    onTogglePresent?.(entity, chapter)
  }, [onTogglePresent, entity, chapter])

  if (symbol.type === 'empty') {
    return (
      <div
        className="group/cell h-full shrink-0 relative flex items-center justify-center border-r border-border/30 cursor-pointer transition-colors hover:bg-primary/8"
        style={{ width: `${cellWidth}px` }}
        data-tip={tip}
        onClick={handleCellClickEvent}
        onContextMenu={onContextMenu}
      >
        {/* hover 时显示 + 号提示可标记出场 */}
        <span className="text-primary text-sm font-light opacity-0 group-hover/cell:opacity-60 transition-opacity pointer-events-none select-none leading-none">+</span>
      </div>
    )
  }

  // character/location 已出场单元格可拖拽换章（其余类型用跨度端点手柄调整）
  if (entity.kind === 'character' || entity.kind === 'location') {
    return (
      <DraggablePresentCell
        entity={entity}
        chapter={chapter}
        cellWidth={cellWidth}
        color={color}
        tip={tip}
        symbol={symbol}
        onContextMenu={onContextMenu}
      />
    )
  }

  // 跨度中段格（conflict/faction span-middle/world-element）
  // 点击无操作，cursor 改 default 避免误导；tooltip 引导用户用右键或拖端点
  const isReadOnlyMiddle =
    symbol.type === 'span-middle' ||
    symbol.type === 'world-element'

  return (
    <div
      className="group/cell h-full shrink-0 relative flex items-center justify-center border-r border-border/30 transition-colors hover:bg-muted/20"
      style={{ width: `${cellWidth}px` }}
      data-tip={tip}
      onClick={isReadOnlyMiddle ? undefined : handleCellClickEvent}
      onContextMenu={onContextMenu}
    >
      {/* hover 时符号放大 */}
      <div className="transition-transform duration-150 ease-out group-hover/cell:scale-[1.25] origin-center">
        <Symbol symbol={symbol} color={color} />
      </div>
    </div>
  )
}

// ── 可拖拽的已出场单元格（character/location）──
// 拖拽换章；click 不绑定任何操作，自然冒泡到 EntityRow → 选中实体（非破坏性）。
// 删除出场走右键菜单（EntityCellMenu），避免 click 与 drag 在同元素上冲突。

interface DraggablePresentCellProps {
  entity: MatrixEntity
  chapter: number
  cellWidth: number
  color: string
  tip: string
  symbol: ReturnType<typeof computeCellSymbol>
  onContextMenu?: (e: React.MouseEvent) => void
}

function DraggablePresentCell({
  entity, chapter, cellWidth, color, tip, symbol, onContextMenu,
}: DraggablePresentCellProps): ReactElement {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `cell:${entity.entityId}:${chapter}`,
    data: {
      source: 'cell',
      entityType: entity.kind,
      entityId: entity.entityId,
      chapter,
    } satisfies CellDragData,
  })
  const style: React.CSSProperties = {
    width: `${cellWidth}px`,
    transform: transform ? CSS.Translate.toString(transform) : undefined,
    touchAction: 'none',
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onContextMenu={onContextMenu}
      data-tip={tip}
      className={cn(
        'group/cell h-full shrink-0 relative flex items-center justify-center border-r border-border/30 cursor-grab active:cursor-grabbing transition-opacity',
        isDragging && 'opacity-30',
      )}
    >
      {/* hover 时符号放大（scale 1.3）+ drop-shadow 增强可见性 */}
      <div className="transition-transform duration-150 ease-out group-hover/cell:scale-[1.3] origin-center">
        <Symbol symbol={symbol} color={color} />
      </div>
      {/* hover 时显示 GripVertical 手柄提示可拖拽 */}
      <GripVertical
        className="absolute left-0.5 top-1/2 -translate-y-1/2 size-2.5 text-foreground/30 opacity-0 group-hover/cell:opacity-100 transition-opacity pointer-events-none"
        aria-hidden
      />
    </div>
  )
}

// 空单元格提示：引导用户左键标记出场（按实体类型给出语义化文案）
function buildEmptyCellTip(entity: MatrixEntity, chapter: number, chapterTitle: string): string {
  const chStr = `第 ${chapter} 章${chapterTitle ? ' · ' + chapterTitle : ''}`
  switch (entity.kind) {
    case 'character':
      return `${chStr}｜左键：标记 ${entity.name} 出场`
    case 'location':
      return `${chStr}｜左键：标记 ${entity.name} 出场`
    case 'conflict':
    case 'faction':
      return `${chStr}｜左键：扩展 ${entity.name} 到本章`
    case 'foreshadow':
      return `${chStr}｜左键：标记 ${entity.name} 埋设/回收点`
    case 'world_element':
      return `${chStr}｜${entity.name}（常驻）`
    default:
      return ''
  }
}

// ── 符号渲染 ──

function Symbol({ symbol, color }: { symbol: ReturnType<typeof computeCellSymbol>; color: string }): ReactElement {
  const style = { color }
  switch (symbol.type) {
    case 'present':
      return (
        <span
          className={`text-[11px] leading-none transition-transform inline-block opacity-90 [filter:drop-shadow(0_0_3px_currentColor)] group-hover/cell:scale-[1.35] ${symbol.protagonist ? '!text-[13px] [filter:drop-shadow(0_0_5px_currentColor)]' : ''}`}
          style={style}
        >★</span>
      )
    case 'span-start':
      return <span className="text-[10px] leading-none transition-transform inline-block [text-shadow:0_0_4px_currentColor] group-hover/cell:scale-[1.35]" style={style}>▲</span>
    case 'span-end':
      return <span className="text-[10px] leading-none transition-transform inline-block [text-shadow:0_0_4px_currentColor] group-hover/cell:scale-[1.35]" style={style}>▼</span>
    case 'span-middle':
      return <span className="text-[11px] leading-none inline-block" />
    case 'conflict-climax':
      // 冲突高潮章节：火焰标记（琥珀色，覆盖分组色），提示爆发点
      return (
        <span
          className="text-[12px] leading-none transition-transform inline-block opacity-95 [filter:drop-shadow(0_0_5px_rgb(245_158_11))] group-hover/cell:scale-[1.4]"
          style={{ color: 'rgb(245, 158, 11)' }}
        >✦</span>
      )
    case 'foreshadow-plant':
      return <span className="text-[11px] leading-none transition-transform inline-block opacity-90 [filter:drop-shadow(0_0_3px_currentColor)] group-hover/cell:scale-[1.35]" style={style}>●</span>
    case 'foreshadow-payoff':
      return <span className="text-[11px] leading-none transition-transform inline-block [filter:drop-shadow(0_0_4px_currentColor)] group-hover/cell:scale-[1.35]" style={style}>○</span>
    case 'location':
      return <span className="text-[11px] leading-none transition-transform inline-block [filter:drop-shadow(0_0_3px_currentColor)] group-hover/cell:scale-[1.35]" style={style}>◆</span>
    case 'world-element':
      return <span className="text-[11px] leading-none inline-block" />
    case 'empty':
      return <span className="text-[11px] leading-none inline-block" />
  }
}

// ── 跨度/连线叠加层 ──

interface EntityOverlayProps {
  entity: MatrixEntity
  maxChapter: number
  cellWidth: number
  color: string
  colorRgb: string
  onEditSpan?: (entity: MatrixEntity) => void
  onContextMenuCell?: (entityId: string, entityName: string, entityType: MatrixEntityKind, chapter: number, x: number, y: number) => void
  /** 左键点击色带：选中该实体（与点击行首效果一致） */
  onEntityClick: () => void
  onTogglePresent?: (entity: MatrixEntity, chapter: number) => void
}

function EntityOverlay({ entity, maxChapter, cellWidth, color, colorRgb, onEditSpan, onContextMenuCell, onEntityClick, onTogglePresent }: EntityOverlayProps): ReactElement | null {
  switch (entity.kind) {
    case 'conflict':
    case 'faction': {
      const spans = entity.chapterSpans ?? []
      if (spans.length === 0) return null
      return (
        <>
          {spans.map((span, idx) => {
            const [s, e] = span
            const left = (s - 1) * cellWidth
            const width = (e - s + 1) * cellWidth
            return (
              <div
                key={`span-${idx}`}
                className="group/span absolute top-1/2 h-[15px] -translate-y-1/2 rounded z-[2] cursor-pointer hover:brightness-110 transition-[filter] overflow-visible"
                style={{
                  position: 'absolute',
                  left, width,
                  background: `rgba(${colorRgb}, 0.16)`,
                  border: `1px solid rgba(${colorRgb}, 0.3)`,
                }}
                data-tip="双击编辑跨度 · 拖动两端圆点调整范围"
                onClick={(ev) => {
                  ev.stopPropagation()
                  onEntityClick()
                }}
                onDoubleClick={(ev) => {
                  ev.stopPropagation()
                  onEditSpan?.(entity)
                }}
                onContextMenu={(ev) => {
                  if (!onContextMenuCell) return
                  ev.preventDefault()
                  ev.stopPropagation()
                  // 根据点击位置计算实际 chapter（clamp 到 [s, e]）
                  const rect = ev.currentTarget.getBoundingClientRect()
                  const offset = Math.floor((ev.clientX - rect.left) / cellWidth)
                  const ch = Math.min(e, Math.max(s, s + offset))
                  onContextMenuCell(entity.entityId, entity.name, entity.kind, ch, ev.clientX, ev.clientY)
                }}
              >
                {/* 起点手柄：对齐到 start 章节列中心 */}
                <EndpointHandle
                  entityId={entity.entityId}
                  entityType={entity.kind}
                  spanIndex={idx}
                  end="start"
                  origChapter={s}
                  left={cellWidth / 2}
                  color={color}
                />
                {/* 终点手柄：对齐到 end 章节列中心 */}
                <EndpointHandle
                  entityId={entity.entityId}
                  entityType={entity.kind}
                  spanIndex={idx}
                  end="end"
                  origChapter={e}
                  left={width - cellWidth / 2}
                  color={color}
                />
              </div>
            )
          })}
        </>
      )
    }
    case 'foreshadow': {
      // 伏笔：plant 章节 ● + payoff 章节 ○ + 之间虚线连线
      // - 未回收：从 plant 虚线延伸到末章（表示"悬而未决"）
      // - 已回收：从 plant 实线/虚线到 payoff（表示"已回收"）
      // 不用色带，只用两点 + 连线
      const plant = entity.plantChapter
      const payoff = entity.payoffChapter
      if (plant == null) return null
      const lineEnd = payoff ?? maxChapter
      const lineLeft = (plant - 1) * cellWidth + cellWidth / 2
      const lineRight = (lineEnd - 1) * cellWidth + cellWidth / 2
      const lineWidth = lineRight - lineLeft
      const recovered = payoff != null
      return (
        <>
          {/* 虚线连线：plant → payoff（或末章，未回收时） */}
          <div
            className="absolute top-1/2 -translate-y-1/2 h-px z-[2] pointer-events-none"
            style={{
              left: lineLeft,
              width: lineWidth,
              borderTop: `1.5px dashed rgba(${colorRgb}, ${recovered ? 0.4 : 0.5})`,
            }}
            aria-hidden="true"
          />
          {/* plant 端点手柄（可拖拽调整埋设点） */}
          <div
            className="absolute top-1/2 -translate-y-1/2 z-[3] cursor-pointer"
            style={{ left: lineLeft - 8, width: 16, height: 16 }}
            data-tip="拖动调整埋设点 · 右键更多操作"
            onClick={(ev) => {
              ev.stopPropagation()
              onEntityClick()
              onTogglePresent?.(entity, plant)
            }}
            onContextMenu={(ev) => {
              if (!onContextMenuCell) return
              ev.preventDefault()
              ev.stopPropagation()
              onContextMenuCell(entity.entityId, entity.name, entity.kind, plant, ev.clientX, ev.clientY)
            }}
          >
            <EndpointHandle
              entityId={entity.entityId}
              entityType={entity.kind}
              spanIndex={0}
              end="start"
              origChapter={plant}
              left={8}
              color={color}
            />
          </div>
          {/* payoff 端点手柄（仅已回收时显示，可拖拽调整回收点） */}
          {payoff != null && (
            <div
              className="absolute top-1/2 -translate-y-1/2 z-[3] cursor-pointer"
              style={{ left: lineRight - 8, width: 16, height: 16 }}
              data-tip="拖动调整回收点 · 右键更多操作"
              onClick={(ev) => {
                ev.stopPropagation()
                onEntityClick()
                onTogglePresent?.(entity, payoff)
              }}
              onContextMenu={(ev) => {
                if (!onContextMenuCell) return
                ev.preventDefault()
                ev.stopPropagation()
                onContextMenuCell(entity.entityId, entity.name, entity.kind, payoff, ev.clientX, ev.clientY)
              }}
            >
              <EndpointHandle
                entityId={entity.entityId}
                entityType={entity.kind}
                spanIndex={0}
                end="end"
                origChapter={payoff}
                left={8}
                color={color}
              />
            </div>
          )}
        </>
      )
    }
    case 'world_element': {
      const start = entity.alwaysStart ?? 1
      const end = entity.alwaysEnd ?? maxChapter
      const width = (end - start + 1) * cellWidth
      return (
        <div
          className="absolute top-1/2 -translate-y-1/2 h-3 left-0 z-[2] flex items-center px-2 pointer-events-none rounded"
          style={{
            width,
            background: `linear-gradient(90deg, rgba(${colorRgb}, 0.04) 0%, rgba(${colorRgb}, 0.22) 50%, rgba(${colorRgb}, 0.04) 100%)`,
            border: `1px solid rgba(${colorRgb}, 0.2)`,
          }}
        >
          <span
            className="font-mono text-[9px] tracking-wide opacity-80 whitespace-nowrap"
            style={{ color: `rgba(${colorRgb}, 0.9)` }}
          >常驻 · {entity.name}</span>
        </div>
      )
    }
    default:
      return null
  }
}

// ── 跨度端点拖拽手柄 ──
// 拖动起点/终点圆点到目标章节列即可调整 conflict/faction/foreshadow 的起止位置。
// 用 translate(-50%,-50%) 居中，叠加 @dnd-kit 的位移 transform。

interface EndpointHandleProps {
  entityId: string
  entityType: MatrixEntityKind
  /** conflict/faction 多段跨度中的段索引（foreshadow 恒为 0） */
  spanIndex: number
  end: 'start' | 'end'
  origChapter: number
  /** 相对父容器左边缘的 px 偏移（圆点中心） */
  left: number
  color: string
}

function EndpointHandle({ entityId, entityType, spanIndex, end, origChapter, left, color }: EndpointHandleProps): ReactElement {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `endpoint:${entityId}:${spanIndex}:${end}`,
    data: {
      source: 'endpoint',
      entityType,
      entityId,
      spanIndex,
      end,
      origChapter,
    } satisfies EndpointDragData,
  })
  // ⚠️ 把 transform.y 钉死为 0：章节换算 computeChapterFromRect 只用 X 坐标，
  // Y 坐标完全不影响结果。如果不限制 Y，拖动时手柄会跨行跑（视觉错乱），
  // 用户反馈"三角形超过自己的轨道"。直接丢弃 Y 位移，手柄只在 X 轴移动。
  const tf = transform
    ? `translate(-50%, -50%) translate3d(${transform.x}px, 0px, 0)`
    : 'translate(-50%, -50%)'

  // 伏笔端点透明化：让 Cell 的 ●/○ 符号作视觉，EndpointHandle 只做拖拽手柄
  const isForeshadow = entityType === 'foreshadow'

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      // doubleClick 仍阻止冒泡（防止拖拽手柄双击误触发编辑跨度）
      onDoubleClick={(e) => e.stopPropagation()}
      title={end === 'start' ? '拖动调整起点' : '拖动调整终点'}
      data-tip={end === 'start' ? '拖动调整起点' : '拖动调整终点'}
      className={cn(
        'group/endpoint absolute top-1/2 rounded-full flex items-center justify-center cursor-ew-resize pointer-events-auto transition-[transform,box-shadow] duration-150 ease-out z-[5] hover:scale-140',
        isForeshadow ? 'size-4' : 'size-3.5',
        isDragging && 'scale-150',
      )}
      style={{
        position: 'absolute',
        left,
        background: isForeshadow ? 'transparent' : color,
        transform: tf,
        touchAction: 'none',
        boxShadow: isForeshadow ? 'none' : '0 0 0 2px var(--color-surface-1), 0 0 4px rgba(0,0,0,0.3)',
      }}
    >
      {/* hover 时增强 glow（非伏笔端点）*/}
      {!isForeshadow && (
        <span
          className="absolute inset-0 rounded-full opacity-0 group-hover/endpoint:opacity-100 transition-opacity duration-150 pointer-events-none"
          style={{ boxShadow: `0 0 0 4px ${color}22, 0 0 12px ${color}66` }}
          aria-hidden
        />
      )}
      {/* conflict/faction 端点显示三角箭头；伏笔端点不显示（Cell 的 ●/○ 已作视觉） */}
      {entityType !== 'foreshadow' && (
        <span className="text-[8px] text-white leading-none font-bold select-none">
          {end === 'start' ? '◀' : '▶'}
        </span>
      )}
    </div>
  )
}

// ── Tooltip 文本构造 ──

function buildCellTooltip(
  symbol: ReturnType<typeof computeCellSymbol>,
  entity: MatrixEntity,
  chapter: number,
  chapterTitle: string,
): string {
  const chStr = `第 ${chapter} 章${chapterTitle ? ' · ' + chapterTitle : ''}`
  switch (symbol.type) {
    case 'present':
      return `${chStr}｜${entity.name} 出场${symbol.protagonist ? '（主角）' : ''}`
    case 'span-start':
      return `${chStr}｜${entity.name} 起始`
    case 'span-end':
      return `${chStr}｜${entity.name} 结束`
    case 'span-middle':
      return `${chStr}｜${entity.name}（跨度中，拖动端点或右键编辑范围）`
    case 'conflict-climax':
      return `${chStr}｜${entity.name} 冲突高潮（爆发点）`
    case 'foreshadow-plant':
      return `${chStr}｜${entity.name} 埋设${entity.note ? ' · ' + entity.note : ''}`
    case 'foreshadow-payoff':
      return `${chStr}｜${entity.name} 回收`
    case 'location':
      return `${chStr}｜${entity.name}`
    case 'world-element':
      return `${chStr}｜${entity.name}（常驻世界要素）`
    case 'empty':
      return ''
  }
}

export { GROUP_ORDER, GROUP_META }
