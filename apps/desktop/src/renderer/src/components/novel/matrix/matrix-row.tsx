/**
 * matrix-row：矩阵行组件集合
 *
 * 从 matrix-view.tsx 抽取，包含：
 * - HookTrackRow：章尾钩子轨道行
 * - GroupRow：分组折叠头
 * - EntityRow：实体行（sticky 行首 + 命中层 + 主编码层 + 弧光标记）
 * - MatrixEmptyState：空状态
 * - HitCell / DraggablePresentCell：单元格命中/拖拽
 * - EntityMainEncoding / SpanBand / EndpointHandle / ForeshadowEncoding：视觉编码
 * - hc()：hover 卡属性构造器（matrix-view 也复用）
 */

import { useMemo, useCallback, memo, useRef, type ReactElement } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { ChevronRight, GripVertical, LayoutGrid } from 'lucide-react'
import type {
  NovelHook,
  NovelCharacterArc,
  ChapterEndingHookType,
} from '@/api/novel-client'
import { cn } from '@/lib/utils'
import {
  GROUP_META,
  computeCellSymbol,
  type MatrixEntityKind,
  type MatrixEntity,
  type MatrixGroup,
  type SpanDragData,
  type CellDragData,
} from './matrix-logic'
import { resolveEmptyCellHint, resolvePresentCellHint } from './entity-interaction-spec'
import {
  MATRIX_LAYOUT,
  gridlineBackgroundImage,
  isSubtrackSupported,
} from './matrix-model'

const { hookRowHeight: HOOK_H, groupHeight: GROUP_H, entityHeight: ROW_H } = MATRIX_LAYOUT

// ── hover 卡属性构造（data-hc-* → MatrixHoverCard）──
export function hc(dim: string, ch: string | number, opts?: { before?: string; after?: string; desc?: string; color?: string }): Record<string, string> {
  return {
    'data-hc-dim': dim,
    'data-hc-ch': String(ch),
    'data-hc-before': opts?.before ?? '',
    'data-hc-after': opts?.after ?? '',
    'data-hc-desc': opts?.desc ?? '',
    'data-hc-color': opts?.color ?? '',
  }
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

export interface HookTrackRowProps {
  hooks: NovelHook[]
  visibleChapterColumns: number[]
  cellWidth: number
  sidebarWidth: number
}

export function HookTrackRow({
  hooks, visibleChapterColumns, cellWidth, sidebarWidth,
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
        className={cn(
          'sticky left-0 z-30 flex items-center border-r border-border/40 shrink-0 bg-surface-1 overflow-hidden',
          sidebarWidth <= 32 ? 'justify-center px-0' : 'justify-start pl-2',
        )}
        style={{ width: sidebarWidth }}
      >
        <span className="text-nano text-hint tracking-wider truncate">章尾钩子</span>
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
                  className="flex items-center justify-center w-4 h-4 rounded-full text-nano font-bold leading-none"
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
        {/* 播放头列高亮由 matrix-view 的全局贯通条统一绘制（z-[4]，覆盖标尺以下全高）。
            此前每个 GroupRow / EntityRow / 子轨道各画一份，同一列被重复绘制 4 次，
            长篇下（数百行 × 每行一个 absolute div）是无谓的合成层开销。 */}
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────
// 空状态
// ────────────────────────────────────────────────────────────

export function MatrixEmptyState(): ReactElement {
  return (
    <div className="flex items-center justify-center px-6 py-16">
      <div className="text-center max-w-sm">
        <div className="mx-auto mb-3 w-12 h-12 rounded-full bg-muted/40 flex items-center justify-center text-hint">
          <LayoutGrid className="size-5" />
        </div>
        <p className="text-sm font-medium text-text mb-1.5">暂无实体出场记录</p>
        <p className="text-xs text-muted-foreground leading-relaxed">
          请点击上方「补全历史」让 AI 自动补全角色起始章节，
          或从左侧边栏新建实体后，左键双击空单元格标记出场，右键单元格更多操作。
        </p>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────
// 分组行
// ────────────────────────────────────────────────────────────

export interface GroupRowProps {
  group: MatrixGroup
  collapsed: boolean
  cellWidth: number
  sidebarWidth: number
  onToggleCollapse: () => void
  onContextMenuGroupEmpty?: (kind: MatrixEntityKind) => void
}

/** 分组头行。九个分组在每次滚动时都会重建，memo 后只在折叠态或实体数变化时更新。 */
export const GroupRow = memo(function GroupRow({ group, collapsed, cellWidth, sidebarWidth, onToggleCollapse, onContextMenuGroupEmpty }: GroupRowProps): ReactElement {
  const sidebarCollapsed = sidebarWidth <= 32
  return (
    <div className="relative flex border-b border-border/10 bg-surface-2/70" style={{ height: GROUP_H }}>
      <div
        className={cn(
          'sticky left-0 z-30 flex items-center border-r border-border/40 shrink-0 bg-surface-2 cursor-pointer select-none hover:bg-surface-3 transition-colors overflow-hidden',
          sidebarCollapsed ? 'justify-center px-0' : 'gap-1.5 px-2',
        )}
        style={{ width: sidebarWidth }}
        onClick={onToggleCollapse}
        {...hc(collapsed ? `展开${group.name}` : `折叠${group.name}`, '', {})}
      >
        <span className={cn('inline-flex items-center justify-center w-3.5 h-3.5 text-subtle transition-transform shrink-0', collapsed && '-rotate-90')}>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m6 9 6 6 6-6" /></svg>
        </span>
        <span className="w-1.5 h-1.5 rounded-sm shrink-0" style={{ background: group.color }} />
        {!sidebarCollapsed && (
          <>
            <span className="text-micro font-bold text-text-secondary tracking-wide truncate flex-1">{group.name}</span>
            <span className="font-mono text-nano text-hint tabular-nums shrink-0">{group.entities.length}</span>
          </>
        )}
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
})

// ────────────────────────────────────────────────────────────
// 实体行
// ────────────────────────────────────────────────────────────

export interface EntityRowProps {
  entity: MatrixEntity
  visibleChapterColumns: number[]
  maxChapter: number
  cellWidth: number
  sidebarWidth: number
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

const ARC_TYPE_META: Record<string, { label: string; color: string; bg: string }> = {
  growth: { label: '成长', color: '#15a877', bg: 'rgba(21,168,119,0.15)' },
  fall: { label: '堕落', color: '#e8463a', bg: 'rgba(232,70,58,0.15)' },
  redemption: { label: '救赎', color: '#a855f7', bg: 'rgba(168,85,247,0.15)' },
  shift: { label: '转变', color: '#3b82f6', bg: 'rgba(59,130,246,0.15)' },
}

export function EntityRow(props: EntityRowProps): ReactElement {
  const {
    entity, visibleChapterColumns, maxChapter, cellWidth, sidebarWidth,
    isSelected, isMatrixSelected, isExpanded, characterArcs, onClick,
    onContextMenuCell, onEditEntity, onEditSpan, onTogglePresent, onPlayheadChange, onToggleExpand,
  } = props
  const meta = GROUP_META[entity.kind]
  const selected = isSelected || isMatrixSelected
  const expandable = isSubtrackSupported(entity.kind)
  const sidebarCollapsed = sidebarWidth <= 32

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
          'sticky left-0 z-30 flex items-center border-r border-border/40 shrink-0 cursor-pointer select-none transition-colors overflow-hidden',
          sidebarCollapsed ? 'justify-center px-0' : 'gap-1.5 pr-2 pl-2',
          selected ? 'bg-primary/[0.08]' : 'bg-surface-1',
        )}
        style={{ width: sidebarWidth }}
        onClick={(e) => onClick({ multi: e.ctrlKey || e.metaKey })}
      >
        {selected && <span className="absolute left-0 top-0 bottom-0 w-0.5" style={{ background: meta.color }} aria-hidden="true" />}
        {!sidebarCollapsed && (
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
        )}
        <span
          className={cn('w-1.5 h-1.5 rounded-full shrink-0', entity.pending && 'opacity-40')}
          style={
            entity.pending
              // 未上线：空心点，与「已放置」的实心点区分
              ? { border: `1px solid ${meta.color}` }
              : { background: meta.color }
          }
        />
        {!sidebarCollapsed && (
          <>
            <span
              className={cn(
                'truncate flex-1 min-w-0 text-xs',
                selected ? 'text-text font-semibold' : 'text-text-secondary',
                entity.pending && 'text-subtle italic',
              )}
              title={entity.pending ? `${entity.name}（未上线：双击任一章即放置）` : entity.name}
            >
              {entity.name}
            </span>
            {entity.isProtagonist && (
              <span className="text-nano text-amber-600 dark:text-amber-400 font-semibold shrink-0 bg-amber-500/10 rounded px-1 leading-4">主</span>
            )}
            {entity.subLabel && sidebarWidth >= 160 && (
              <span
                className={cn(
                  'text-nano rounded px-1 leading-4 shrink-0 max-w-[56px] truncate',
                  entity.pending
                    ? 'text-subtle bg-transparent ring-1 ring-border ring-inset'
                    : 'text-subtle bg-muted/60',
                )}
                title={entity.subLabel}
              >
                {entity.subLabel}
              </span>
            )}
            {entity.note && (
              <span
                className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"
                {...hc('批注', '', { desc: entity.note })}
              />
            )}
          </>
        )}
      </div>

      {/* 右侧单元格区 */}
      <div className="relative flex-1" style={{ backgroundImage: gridlineBackgroundImage(cellWidth) }}>
        {/* 播放头列高亮由 matrix-view 统一绘制，见 GroupRow 处注释 */}

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

/**
 * 单元格命中层。
 *
 * memo 的收益在这里最大：数量 = 可见列 × 可见行，长篇下每次滚动或播放头移动
 * 都会重建上千个实例。props 全是原始值与稳定回调，浅比较足够。
 */
const HitCell = memo(function HitCell({ entity, chapter, cellWidth, onTogglePresent, onSelectEntity, onContextMenu, onPlayheadChange }: HitCellProps): ReactElement {
  const symbol = computeCellSymbol(entity, chapter)
  const meta = GROUP_META[entity.kind]
  const canTogglePresence = entity.kind !== 'world_element' && entity.kind !== 'info_layer'

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
          {...hc(entity.name, chapter, { after: resolveEmptyCellHint(entity.kind), color: meta.color })}
        onClick={handleSelect}
        onDoubleClick={canTogglePresence ? handleToggle : undefined}
        onContextMenu={onContextMenu}
        aria-label={`第 ${chapter} 章 ${entity.name} 空单元格`}
      >
        {canTogglePresence && (
          <span className="text-primary/60 text-sm font-light opacity-0 group-hover/cell:opacity-70 transition-opacity pointer-events-none select-none leading-none">+</span>
        )}
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
        onPlayheadChange={onPlayheadChange}
      />
    )
  }

  // 其余类型已出场：单击选中并定位播放头，双击亦定位
  return (
    <div
      className="absolute top-0 bottom-0 cursor-pointer focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60"
      style={{ left, width: cellWidth }}
      role="button"
      tabIndex={0}
          {...hc(entity.name, chapter, { after: resolvePresentCellHint(entity.kind, symbol.type), color: meta.color })}
      onClick={(e) => {
        handleSelect(e)
      }}
      onDoubleClick={handleActivate}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        handleSelect(e)
        onPlayheadChange?.(chapter)
      }}
      onContextMenu={onContextMenu}
      aria-label={`第 ${chapter} 章 ${entity.name}`}
    />
  )
})

// emptyCellHint / presentCellHint 已收口到 ENTITY_INTERACTION_SPEC。
// 此前这两个 switch 与 entity-cell-menu 的四个 switch 各自维护同一套语义，
// 已导致 location/faction/character 的已占格提示落到 default 返回空串、
// item 九类里唯一全部落 default 等不一致。

// ── 可拖拽的已出场单元格（character/location）──

interface DraggablePresentCellProps {
  entity: MatrixEntity
  chapter: number
  cellWidth: number
  left: number
  isProtagonist: boolean
  onContextMenu?: (e: React.MouseEvent) => void
  onPlayheadChange?: (chapter: number) => void
}

function DraggablePresentCell({ entity, chapter, cellWidth, left, isProtagonist, onContextMenu, onPlayheadChange }: DraggablePresentCellProps): ReactElement {
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
  // 区分单击与拖拽：pointerdown 记录起点，click 时位移超过阈值视为拖拽残留，不切播放头。
  const downPosRef = useRef<{ x: number; y: number } | null>(null)
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onPointerDownCapture={(e) => { downPosRef.current = { x: e.clientX, y: e.clientY } }}
      onClick={(e) => {
        const down = downPosRef.current
        downPosRef.current = null
        if (down && (Math.abs(e.clientX - down.x) > 4 || Math.abs(e.clientY - down.y) > 4)) return
        onPlayheadChange?.(chapter)
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onPlayheadChange?.(chapter)
      }}
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
    case 'item':
    case 'narrative': {
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

    case 'info_layer': {
      const start = entity.infoStart ?? 1
      const end = entity.infoEnd ?? 0
      const revealChapter = entity.revealChapter
      return (
        <>
          {end >= start && (
            <div
              aria-hidden="true"
              className="absolute pointer-events-none rounded"
              style={{
                top: ROW_H / 2 - 6,
                height: 12,
                left: (start - 1) * cellWidth,
                width: (end - start + 1) * cellWidth,
                background: `repeating-linear-gradient(-45deg, rgba(${meta.colorRgb}, 0.22) 0 4px, rgba(${meta.colorRgb}, 0.06) 4px 8px)`,
                border: `1px solid rgba(${meta.colorRgb}, 0.38)`,
              }}
            />
          )}
          {revealChapter != null && revealChapter >= 1 && revealChapter <= maxChapter && (
            <span
              aria-hidden="true"
              className="absolute z-[9] pointer-events-none"
              style={{
                left: (revealChapter - 0.5) * cellWidth,
                top: ROW_H / 2,
                width: 9,
                height: 9,
                transform: 'translate(-50%, -50%) rotate(45deg)',
                background: meta.color,
                borderRadius: 2,
                boxShadow: `0 0 0 2px rgba(${meta.colorRgb}, 0.22)`,
              }}
            />
          )}
        </>
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

/**
 * 跨度色带（conflict/faction/item/narrative）。
 *
 * 每个实体可能有多段跨度，且内部含两个可拖拽端点把手 —— 单个实例的 DOM 成本
 * 高于 HitCell，长篇下重建开销明显。
 */
const SpanBand = memo(function SpanBand({
  entity, spanIndex, startChapter, endChapter, cellWidth, isSelected, onEntityClick, onEditEntity, onEditSpan, onContextMenuCell,
}: SpanBandProps): ReactElement {
  const meta = GROUP_META[entity.kind]
  const entityType = entity.kind as 'conflict' | 'faction' | 'item' | 'narrative'
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
})

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
  const recovered = payoff != null

  // 事实段：已发生的 beats 之间的连线（实线）
  const factEnd = beats.length > 1 ? beats[beats.length - 1].chapter : plant
  const factLeft = (plant - 0.5) * cellWidth
  const factWidth = Math.max(0, (factEnd - plant) * cellWidth)

  // 意图段：从最后一个已发生节点延伸到计划回收章（虚线 + 空心终点）。
  //
  // 此前事实与意图共用一根线、靠 recovered 决定实线/虚线，于是
  // 「已回收到第 8 章」与「欠着到第 8 章」画出来完全一样。现在分成两段：
  // 实线到最后一个真实节点，虚线延伸到计划终点，终点画空心箭头示意"未兑现"。
  const plannedEnd = !recovered && entity.spanEndKind === 'planned' ? entity.spanEnd ?? null : null
  const plannedLeft = (factEnd - 0.5) * cellWidth
  const plannedWidth = plannedEnd != null ? Math.max(0, (plannedEnd - factEnd) * cellWidth) : 0

  const beatLabel = (t: string): string =>
    t === 'plant' ? '埋设' : t === 'reinforce' ? '强化' : t === 'reveal' ? '揭示' : '回收'

  return (
    <>
      {factWidth > 0 && (
        <div
          aria-hidden="true"
          className="absolute top-1/2 -translate-y-1/2 pointer-events-none z-[2]"
          style={{
            left: factLeft,
            width: factWidth,
            // 事实段恒为实线：这些节点都真的发生了
            borderTop: `2px solid rgba(${meta.colorRgb}, 0.55)`,
          }}
        />
      )}
      {plannedWidth > 0 && (
        <>
          <div
            aria-hidden="true"
            className="absolute top-1/2 -translate-y-1/2 pointer-events-none z-[2]"
            style={{
              left: plannedLeft,
              width: plannedWidth,
              // 意图段虚线且更淡：欠着的债，不是已完成的事
              borderTop: `2px dashed rgba(${meta.colorRgb}, 0.35)`,
            }}
          />
          {/* 计划终点：空心方框，与已回收的实心圆点明确区分 */}
          <span
            className="absolute z-[5] pointer-events-none"
            style={{
              left: (plannedEnd! - 0.5) * cellWidth,
              top: ROW_H / 2,
              width: 8,
              height: 8,
              transform: 'translate(-50%, -50%)',
              border: `1.5px dashed rgba(${meta.colorRgb}, 0.7)`,
              borderRadius: 2,
              background: 'transparent',
            }}
            {...hc(entity.name, plannedEnd!, {
              after: '计划回收（未兑现）',
              desc: '这是计划而非事实；拖动此端点改的是计划回收章',
              color: meta.color,
            })}
          />
        </>
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
