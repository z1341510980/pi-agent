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
import { Plus, ChevronRight } from 'lucide-react'
import type { NovelChapter, NovelRelationship, NovelConflict, NovelFaction, NovelMarker } from '@/api/novel-client'
import { cn } from '@/lib/utils'
import { useNovelStore } from '@/stores/novel-store'
import {
  buildGroups,
  computeCellSymbol,
  GROUP_META,
  GROUP_ORDER,
  type MatrixEntityKind,
  type MatrixEntity,
  type MatrixGroup,
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

export function MatrixView({
  chapters, characters, conflicts, foreshadows, factions, locations, worldElements,
  characterHistory, markers, playheadChapter, cellWidth, collapsedGroups, activeFilter,
  selectedNodeId, showMarkers = true,
  onSelectEntity, onToggleCollapse, onPlayheadChange, onContextMenuChapter,
  onContextMenuCell, onContextMenuGroupEmpty, onEditSpan, onDropEntity,
}: MatrixViewProps): ReactElement {
  const titleMap = useMemo(() => buildChapterTitleMap(chapters), [chapters])

  const { groups, maxChapter } = useMemo(
    () => buildGroups({
      chapters, characters, conflicts, foreshadows, factions, locations, worldElements,
      characterHistory, markers,
    }),
    [chapters, characters, conflicts, foreshadows, factions, locations, worldElements, characterHistory, markers],
  )

  const chapterColumns = useMemo(() => {
    const cols: number[] = []
    for (let i = 1; i <= maxChapter; i++) cols.push(i)
    return cols
  }, [maxChapter])

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

  // ── C-3c 滚动到指定章节列（监听 store 的 matrixScrollTarget）──
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const matrixScrollTarget = useNovelStore((s) => s.matrixScrollTarget)
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

  // ── 拖入实体到章节列：标记出场 ──
  const [dragOverChapter, setDragOverChapter] = useState<number | null>(null)
  const [flashChapter, setFlashChapter] = useState<number | null>(null)

  const computeChapterFromEvent = useCallback((e: React.DragEvent<HTMLDivElement>): number | null => {
    const el = scrollContainerRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const contentX = e.clientX - rect.left + el.scrollLeft
    const colX = contentX - SIDEBAR_W
    if (colX < 0) return null
    const ch = Math.floor(colX / cellWidth) + 1
    if (ch < 1 || ch > maxChapter) return null
    return ch
  }, [cellWidth, maxChapter])

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!onDropEntity) return
    // 仅接受 application/novel-node 类型
    const types = e.dataTransfer.types
    if (!types.includes('application/novel-node')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const ch = computeChapterFromEvent(e)
    setDragOverChapter(ch)
  }, [onDropEntity, computeChapterFromEvent])

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // 仅在离开容器（不在子元素间移动）时清除
    if (e.currentTarget === e.target) {
      setDragOverChapter(null)
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!onDropEntity) return
    e.preventDefault()
    const raw = e.dataTransfer.getData('application/novel-node')
    setDragOverChapter(null)
    if (!raw) return
    let parsed: { type?: string; id?: string } | null = null
    try {
      parsed = JSON.parse(raw) as { type?: string; id?: string }
    } catch {
      return
    }
    if (!parsed?.type || !parsed?.id) return
    // 仅接受矩阵支持的实体类型（排除 chapter）
    if (parsed.type === 'chapter') return
    const validKinds: string[] = ['character', 'conflict', 'foreshadow', 'faction', 'location', 'world_element']
    if (!validKinds.includes(parsed.type)) return
    const ch = computeChapterFromEvent(e)
    if (ch == null) return
    onDropEntity(parsed.id, parsed.type as MatrixEntityKind, ch)
    // 触发闪烁反馈
    setFlashChapter(ch)
    setTimeout(() => setFlashChapter(null), 800)
  }, [onDropEntity, computeChapterFromEvent])

  // 整体内容宽度
  const totalWidth = SIDEBAR_W + maxChapter * cellWidth
  // 当前章节列高亮 left（在内容容器内）
  const highlightLeft = SIDEBAR_W + (playheadChapter - 1) * cellWidth

  // ── C-1 空状态判定 ──
  const hasAnyEntity = groups.some((g) => g.entities.length > 0)

  return (
    <div
      ref={scrollContainerRef}
      className="overflow-x-auto overflow-y-auto h-full isolate"
      onScroll={(e) => {
        e.currentTarget.style.setProperty('--scroll-x', `${e.currentTarget.scrollLeft}px`)
      }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {hasAnyEntity ? (
        <div className="relative" style={{ width: `${totalWidth}px` }}>
          {/* 当前章节列高亮带（跨整列，从标尺下方开始避免被 sticky 标尺遮挡） */}
          <div
            className="absolute top-[44px] bottom-0 pointer-events-none z-[5] border-x border-amber-500/30"
            style={{ left: `${highlightLeft}px`, width: `${cellWidth}px`, background: 'rgba(245, 158, 11, 0.07)' }}
            aria-hidden="true"
          />

          {/* 拖入反馈：高亮目标章节列 */}
          {dragOverChapter != null && (
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
            {/* 章节标尺单元格 */}
            <div className="flex">
              {chapterColumns.map((ch) => {
                const isCurrent = ch === playheadChapter
                const title = titleMap.get(ch) ?? ''
                const ms = markersByChapter.get(ch) ?? []
                const tip = `第 ${ch} 章${title ? ' · ' + title : ''}${isCurrent ? '（当前章节）' : ''}`
                return (
                  <div
                    key={ch}
                    className="relative h-full shrink-0 flex flex-col justify-center items-center gap-1 border-r border-border/40 cursor-pointer transition-colors hover:bg-muted/40"
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
                  </div>
                )
              })}
            </div>
          </div>

          {/* 分组 + 实体行 */}
          <div className="relative z-[6]">
            {groups.map((group) => {
              if (activeFilter != null && group.id !== activeFilter) return null
              const meta = GROUP_META[group.id]
              const collapsed = collapsedGroups.has(group.id)
              return (
                <GroupBlock
                  key={group.id}
                  group={group}
                  collapsed={collapsed}
                  chapterColumns={chapterColumns}
                  titleMap={titleMap}
                  maxChapter={maxChapter}
                  cellWidth={cellWidth}
                  selectedNodeId={selectedNodeId}
                  color={meta.color}
                  colorRgb={meta.colorRgb}
                  icon={meta.icon}
                  onToggleCollapse={() => onToggleCollapse(group.id)}
                  onEntityClick={handleEntityClick}
                  onContextMenuCell={onContextMenuCell}
                  onContextMenuGroupEmpty={onContextMenuGroupEmpty}
                  onEditSpan={onEditSpan}
                />
              )
            })}
          </div>
        </div>
      ) : (
        <MatrixEmptyState />
      )}
    </div>
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
          或从左侧 <span className="text-text font-medium">NovelSidebar</span> 新建实体后右键标记出场。
        </p>
      </div>
    </div>
  )
}

// ── 分组块 ──

interface GroupBlockProps {
  group: MatrixGroup
  collapsed: boolean
  chapterColumns: number[]
  titleMap: Map<number, string>
  maxChapter: number
  cellWidth: number
  selectedNodeId?: string | null
  color: string
  colorRgb: string
  icon: string
  onToggleCollapse: () => void
  onEntityClick: (entity: MatrixEntity) => void
  onContextMenuCell?: (entityId: string, entityName: string, entityType: MatrixEntityKind, chapter: number, x: number, y: number) => void
  onContextMenuGroupEmpty?: (kind: MatrixEntityKind) => void
  onEditSpan?: (entity: MatrixEntity) => void
}

function GroupBlock({
  group, collapsed, chapterColumns, titleMap, maxChapter, cellWidth, selectedNodeId,
  color, colorRgb, icon, onToggleCollapse, onEntityClick,
  onContextMenuCell, onContextMenuGroupEmpty, onEditSpan,
}: GroupBlockProps): ReactElement {
  const filtered = false // activeFilter 已在父组件过滤
  return (
    <div
      className={cn(filtered && 'opacity-40')}
      style={{ background: `rgba(${colorRgb}, 0.03)` }}
    >
      {/* 分组标题行：左 sticky 列显示分组名+折叠按钮，右侧色条 */}
      <div
        className="relative flex h-[30px] z-[1] border-b border-border/20"
        style={{
          background: `rgba(${colorRgb}, 0.08)`,
          borderBottom: `1px solid rgba(${colorRgb}, 0.3)`,
          borderTop: `1px solid rgba(${colorRgb}, 0.12)`,
        }}
      >
        <div
          className="relative z-30 flex items-center gap-1.5 px-2.5 cursor-pointer border-r border-border shrink-0 transition-colors"
          style={{
            width: `${SIDEBAR_W}px`,
            backgroundColor: 'var(--color-surface-1)',
            backgroundImage: `linear-gradient(rgba(${colorRgb}, 0.08), rgba(${colorRgb}, 0.08))`,
            transform: 'translateX(var(--scroll-x, 0px))',
          }}
          onClick={onToggleCollapse}
          data-tip={collapsed ? `展开${group.name}` : `折叠${group.name}`}
        >
          <span className={cn('text-[9px] text-hint transition-transform w-2 inline-block', collapsed && '-rotate-90')}>▼</span>
          <span className="text-[10px] leading-none" style={{ color }}>{icon}</span>
          <span className="font-semibold text-xs text-text tracking-wide">{group.name}</span>
          <span className="ml-auto font-mono text-[10px] text-hint bg-surface-1 border border-border px-1.5 py-px rounded">
            {group.entities.length}
          </span>
          <button
            type="button"
            className="ml-1 size-6 inline-flex items-center justify-center rounded border border-dashed border-border text-muted-foreground hover:border-primary hover:bg-primary/10 hover:text-primary transition-all"
            onClick={(e) => {
              e.stopPropagation()
              onContextMenuGroupEmpty?.(group.id)
            }}
            data-tip={`新建${group.name}`}
            aria-label={`新建${group.name}`}
          >
            <Plus className="size-4" />
          </button>
        </div>
        {/* 色条占位（右键空白处新建实体）—— 用 flex 容器 + shrink-0 cells 撑开宽度，与 EntityRow 结构一致 */}
        <div
          className="relative flex"
          onContextMenu={(e) => {
            if (!onContextMenuGroupEmpty) return
            e.preventDefault()
            onContextMenuGroupEmpty(group.id)
          }}
        >
          {chapterColumns.map((ch) => (
            <div key={ch} className="shrink-0 border-r border-border/40" style={{ width: `${cellWidth}px` }} />
          ))}
        </div>
      </div>

      {/* 实体行 */}
      {!collapsed && group.entities.map((entity) => (
        <EntityRow
          key={entity.id}
          entity={entity}
          chapterColumns={chapterColumns}
          titleMap={titleMap}
          maxChapter={maxChapter}
          cellWidth={cellWidth}
          isSelected={selectedNodeId === entity.entityId}
          onClick={() => onEntityClick(entity)}
          onContextMenuCell={onContextMenuCell}
          onEditSpan={onEditSpan}
        />
      ))}

      {/* 折叠或空分组：留出空白右键区域 */}
      {!collapsed && group.entities.length === 0 && (
        <div
          className="h-10 border-b border-border/20"
          onContextMenu={(e) => {
            if (!onContextMenuGroupEmpty) return
            e.preventDefault()
            onContextMenuGroupEmpty(group.id)
          }}
        />
      )}
    </div>
  )
}

// ── 实体行 ──

interface EntityRowProps {
  entity: MatrixEntity
  chapterColumns: number[]
  titleMap: Map<number, string>
  maxChapter: number
  cellWidth: number
  isSelected: boolean
  onClick: () => void
  onContextMenuCell?: (entityId: string, entityName: string, entityType: MatrixEntityKind, chapter: number, x: number, y: number) => void
  onEditSpan?: (entity: MatrixEntity) => void
}

function EntityRow({
  entity, chapterColumns, titleMap, maxChapter, cellWidth, isSelected, onClick,
  onContextMenuCell, onEditSpan,
}: EntityRowProps): ReactElement {
  const meta = GROUP_META[entity.kind]

  return (
    <div
      className={cn(
        'relative flex h-7 z-[1] transition-colors cursor-pointer border-b border-border/20',
        isSelected ? 'bg-primary/10' : 'hover:bg-muted/30',
      )}
      onClick={onClick}
      data-tip={entity.name}
    >
      {/* 左侧 sticky 列：实体名（含 hover 联动提示） */}
      <div
        className={cn(
          'group/entity sticky left-0 z-30 flex items-center gap-2 px-3 border-r border-border shrink-0 transition-colors',
          isSelected ? 'bg-primary/10' : 'hover:bg-muted/50',
        )}
        style={{
          width: `${SIDEBAR_W}px`,
          backgroundColor: isSelected ? undefined : 'var(--color-surface-1)',
        }}
      >
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: meta.color }} />
        <span className={cn('truncate flex-1 text-xs', isSelected ? 'text-primary font-medium' : 'text-muted-foreground group-hover/entity:text-text')}>{entity.name}</span>
        {entity.isProtagonist && (
          <span className="text-[9px] text-amber-500 font-semibold shrink-0">主</span>
        )}
        {/* hover 提示：点击查看详情 */}
        <ChevronRight className={cn('size-3 text-muted-foreground shrink-0 transition-opacity', isSelected ? 'opacity-100 text-primary' : 'opacity-0 group-hover/entity:opacity-60')} />
        {isSelected && <span className="absolute right-0 top-0 bottom-0 w-0.5 bg-primary" />}
      </div>

      {/* 右侧单元格容器 */}
      <div className="relative flex">
        {chapterColumns.map((ch) => (
          <Cell
            key={ch}
            entity={entity}
            chapter={ch}
            chapterTitle={titleMap.get(ch) ?? ''}
            color={meta.color}
            cellWidth={cellWidth}
            onContextMenu={(e) => {
              if (!onContextMenuCell) return
              e.preventDefault()
              onContextMenuCell(entity.entityId, entity.name, entity.kind, ch, e.clientX, e.clientY)
            }}
          />
        ))}
        {/* 跨度叠加层 */}
        <EntityOverlay
          entity={entity}
          maxChapter={maxChapter}
          cellWidth={cellWidth}
          color={meta.color}
          colorRgb={meta.colorRgb}
          onEditSpan={onEditSpan}
        />
      </div>

      {/* 选中环 */}
      {isSelected && <span className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-primary/40" />}

      {/* 批注提示 */}
      {entity.note && (
        <div className="absolute right-1 top-1/2 -translate-y-1/2 text-amber-500 text-sm leading-none pointer-events-none opacity-70" data-tip={`批注：${entity.note}`}>·</div>
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
  onContextMenu?: (e: React.MouseEvent) => void
}

function Cell({ entity, chapter, chapterTitle, color, cellWidth, onContextMenu }: CellProps): ReactElement {
  // D-5.3 联动收尾：单元格点击 → 选中实体 + 切播放头到该章节列
  const selectNode = useNovelStore((s) => s.selectNode)
  const setPlayheadChapter = useNovelStore((s) => s.setPlayheadChapter)
  const symbol = computeCellSymbol(entity, chapter)
  const tip = buildCellTooltip(symbol, entity, chapter, chapterTitle)

  const handleCellClick = useCallback(() => {
    selectNode(entity.entityId, entity.kind)
    setPlayheadChapter(chapter)
  }, [selectNode, setPlayheadChapter, entity.entityId, entity.kind, chapter])

  const handleCellClickEvent = useCallback((e: React.MouseEvent) => {
    // 阻止冒泡到 EntityRow 的 onClick（已通过 onEntityClick 链路选中实体，避免重复）
    e.stopPropagation()
    handleCellClick()
  }, [handleCellClick])

  if (symbol.type === 'empty') {
    return (
      <div
        className="h-full shrink-0 relative flex items-center justify-center border-r border-border/30 cursor-pointer"
        style={{ width: `${cellWidth}px` }}
        onClick={handleCellClickEvent}
        onContextMenu={onContextMenu}
      />
    )
  }

  return (
    <div
      className="group/cell h-full shrink-0 relative flex items-center justify-center border-r border-border/30 cursor-pointer"
      style={{ width: `${cellWidth}px` }}
      data-tip={tip}
      onClick={handleCellClickEvent}
      onContextMenu={onContextMenu}
    >
      <Symbol symbol={symbol} color={color} />
    </div>
  )
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
    case 'foreshadow-plant':
      return <span className="text-[11px] leading-none transition-transform inline-block opacity-90 [filter:drop-shadow(0_0_3px_currentColor)] group-hover/cell:scale-[1.35]" style={style}>●</span>
    case 'foreshadow-payoff':
      return <span className="text-[11px] leading-none transition-transform inline-block [filter:drop-shadow(0_0_4px_currentColor)] group-hover/cell:scale-[1.35]" style={style}>○</span>
    case 'foreshadow-span':
      return <span className="text-[11px] leading-none inline-block" />
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
}

function EntityOverlay({ entity, maxChapter, cellWidth, color, colorRgb, onEditSpan }: EntityOverlayProps): ReactElement | null {
  switch (entity.kind) {
    case 'conflict':
    case 'faction': {
      const start = entity.spanStart
      const end = entity.spanEnd
      if (start == null || end == null) return null
      const left = (start - 1) * cellWidth
      const width = (end - start + 1) * cellWidth
      return (
        <div
          className="absolute top-1/2 h-[15px] -translate-y-1/2 rounded z-[2] cursor-pointer hover:brightness-110 transition-[filter]"
          style={{
            left, width,
            background: `rgba(${colorRgb}, 0.16)`,
            border: `1px solid rgba(${colorRgb}, 0.3)`,
          }}
          data-tip="双击编辑跨度"
          onDoubleClick={(e) => {
            e.stopPropagation()
            onEditSpan?.(entity)
          }}
        />
      )
    }
    case 'foreshadow': {
      const plant = entity.plantChapter
      if (plant == null) return null
      const payoff = entity.payoffChapter
      const recovered = payoff != null
      const endChapter = payoff ?? maxChapter
      const lineLeft = (plant - 1) * cellWidth + cellWidth / 2
      const lineWidth = (endChapter - plant) * cellWidth
      const arrowLeft = (maxChapter - 1) * cellWidth + cellWidth / 2
      return (
        <div className="absolute inset-0 z-[2] pointer-events-none">
          <span
            className={`absolute top-1/2 -translate-y-1/2 h-0 rounded ${recovered ? 'opacity-60' : 'opacity-50 border-t-dashed'}`}
            style={{ left: lineLeft, width: lineWidth, borderTop: `1.5px solid ${color}` }}
          />
          {!recovered && (
            <span
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 text-xs font-mono z-[3] [text-shadow:0_0_6px_currentColor]"
              style={{ left: arrowLeft, color }}
            >→</span>
          )}
        </div>
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
      return `${chStr}｜${entity.name}（跨度中）`
    case 'foreshadow-plant':
      return `${chStr}｜${entity.name} 埋设${entity.note ? ' · ' + entity.note : ''}`
    case 'foreshadow-payoff':
      return `${chStr}｜${entity.name} 回收`
    case 'foreshadow-span':
      return `${chStr}｜${entity.name}（${symbol.recovered ? '已回收' : '待回收'}）`
    case 'location':
      return `${chStr}｜${entity.name}`
    case 'world-element':
      return `${chStr}｜${entity.name}（常驻世界要素）`
    case 'empty':
      return ''
  }
}

export { GROUP_ORDER, GROUP_META }
