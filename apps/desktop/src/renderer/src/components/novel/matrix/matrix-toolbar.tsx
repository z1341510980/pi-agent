/**
 * MatrixToolbar：矩阵视图工具栏
 *
 * 分两层：
 * - 标题栏（Header）：返回 + 矩阵/画布视图切换 + 章节号 + 当前章节 badge + 撤销/重做 + 缩放 + 补全 + 扫描
 * - 筛选栏（Filters）：实体类型过滤 chips
 */

import { type ReactElement } from 'react'
import { ArrowLeft, Undo2, Redo2, History, Minus, Plus, Wand2, Grid3x3, LayoutGrid, Network } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { GROUP_META, GROUP_ORDER, type MatrixEntityKind } from './matrix-logic'

export interface MatrixToolbarProps {
  playheadChapter: number
  totalChapters: number
  /** 当前章节标题（用于 badge 显示） */
  currentChapterTitle?: string
  /** 缩放：单元格宽度 px */
  cellWidth: number
  onZoomIn: () => void
  onZoomOut: () => void
  /** 连续缩放（滑杆 / Ctrl+滚轮） */
  onCellWidthChange?: (next: number) => void
  /** 补全历史 */
  completableCount: number
  isCompleting: boolean
  onCompleteHistory: () => void
  /** 撤销/重做（MVP 暂禁用） */
  canUndo?: boolean
  canRedo?: boolean
  onUndo?: () => void
  onRedo?: () => void
  /** 过滤 */
  activeFilter: MatrixEntityKind | null
  onFilterChange: (filter: MatrixEntityKind | null) => void
  /** LLM 相似度扫描（语义相似智能合并） */
  onSimilarityScan?: () => void
  similarityScanning?: boolean
  viewMode: 'matrix' | 'canvas'
  onViewModeChange: (mode: 'matrix' | 'canvas') => void
  /** 关系叠加层开关 */
  showRelationshipOverlay?: boolean
  onToggleRelationshipOverlay?: () => void
}

const FILTER_OPTIONS: Array<{ key: MatrixEntityKind | null; label: string }> = [
  { key: null, label: '全部' },
  ...GROUP_ORDER.map((k) => ({ key: k as MatrixEntityKind | null, label: GROUP_META[k].name }))
]

export function MatrixToolbar({
  playheadChapter,
  totalChapters,
  currentChapterTitle,
  cellWidth,
  onZoomIn,
  onZoomOut,
  onCellWidthChange,
  completableCount,
  isCompleting,
  onCompleteHistory,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  activeFilter,
  onFilterChange,
  onSimilarityScan,
  similarityScanning = false,
  viewMode,
  onViewModeChange,
  showRelationshipOverlay = false,
  onToggleRelationshipOverlay,
}: MatrixToolbarProps): ReactElement {
  const zoomPct = Math.round((cellWidth / 56) * 100)

  return (
    <div className="relative z-20 shrink-0 border-b border-border bg-surface-1">
      {/* ── 标题栏：返回 + 视图切换 + 章节信息 + 撤销/重做 + 缩放 + 补全 + 扫描 ── */}
      <div className="flex items-center gap-1.5 px-3 min-h-11 py-1.5 text-xs overflow-hidden">
        <button type="button" className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-text" onClick={() => window.history.back()} title="返回" aria-label="返回">
          <ArrowLeft className="size-3.5" />
        </button>
        <div className="inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-surface-2 p-0.5" role="tablist" aria-label="视图切换">
          {([['matrix', '矩阵', Grid3x3], ['canvas', '画布', LayoutGrid] ] as const).map(([mode, label, Icon]) => (
            <button key={mode} type="button" role="tab" aria-selected={viewMode === mode} onClick={() => onViewModeChange(mode)} className={cn('inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium', viewMode === mode ? 'bg-surface-1 text-text shadow-sm' : 'text-muted-foreground hover:bg-surface-1/60 hover:text-text')}>
              <Icon className="size-3.5" />{label}
            </button>
          ))}
        </div>
        {/* 关系叠加层切换 */}
        {onToggleRelationshipOverlay && (
          <button
            type="button"
            onClick={onToggleRelationshipOverlay}
            aria-pressed={showRelationshipOverlay}
            title="关系叠加层"
            aria-label="关系叠加层"
            className={cn(
              'inline-flex size-8 shrink-0 items-center justify-center rounded-md transition-[color,background-color,transform] active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
              showRelationshipOverlay
                ? 'bg-primary/20 text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-text',
            )}
          >
            <Network className="size-3.5" />
          </button>
        )}
        {/* 章节号显示 + 当前章节 badge */}
        <span className="font-mono text-[11px] text-muted-foreground px-1 tabular-nums whitespace-nowrap">
          第 {playheadChapter} 章 / 共 {totalChapters} 章
        </span>
        {currentChapterTitle && (
          <span
            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-500 text-[11px] font-medium"
            title={`当前章节：第 ${playheadChapter} 章 · ${currentChapterTitle}`}
          >
            <span
              className="w-1.5 h-1.5 rounded-full bg-amber-500"
              style={{ boxShadow: '0 0 6px #f59e0b' }}
            />
            <span className="font-mono opacity-80">
              CH.{String(playheadChapter).padStart(2, '0')}
            </span>
            <span className="truncate max-w-[140px]">{currentChapterTitle}</span>
          </span>
        )}

        <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

        {/* 编辑组：撤销/重做 */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center text-muted-foreground hover:text-text hover:bg-muted rounded-md transition-[color,background-color,transform] active:scale-[0.96] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            onClick={onUndo}
            title="撤销 (Cmd/Ctrl+Z)"
            aria-label="撤销"
            disabled={!canUndo}
          >
            <Undo2 className="size-3.5" />
          </button>
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center text-muted-foreground hover:text-text hover:bg-muted rounded-md transition-[color,background-color,transform] active:scale-[0.96] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            onClick={onRedo}
            title="重做 (Cmd/Ctrl+Shift+Z)"
            aria-label="重做"
            disabled={!canRedo}
          >
            <Redo2 className="size-3.5" />
          </button>
        </div>

        <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

        {/* 缩放：按钮 + 连续滑杆 */}
        <div className="inline-flex items-center bg-surface-3 border border-border rounded-md overflow-hidden" aria-label="矩阵缩放">
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center text-muted-foreground hover:text-text hover:bg-muted transition-[color,background-color,transform] active:scale-[0.96] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50"
            onClick={onZoomOut}
            title="缩小单元格（Ctrl+滚轮亦可）"
            aria-label="缩小矩阵单元格"
            disabled={cellWidth <= 24}
          >
            <Minus className="size-3.5" />
          </button>
          {onCellWidthChange && (
            <input
              type="range"
              min={24}
              max={80}
              step={1}
              value={cellWidth}
              onChange={(e) => onCellWidthChange(Number(e.target.value))}
              className="w-20 h-4 accent-[var(--color-primary)] cursor-pointer mx-1"
              aria-label="单元格宽度滑杆"
              title={`单元格宽度 ${cellWidth}px`}
            />
          )}
          <span className="font-mono text-[11px] text-muted-foreground min-w-[42px] text-center px-1 tabular-nums">
            {zoomPct}%
          </span>
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center text-muted-foreground hover:text-text hover:bg-muted transition-[color,background-color,transform] active:scale-[0.96] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50"
            onClick={onZoomIn}
            title="放大单元格（Ctrl+滚轮亦可）"
            aria-label="放大矩阵单元格"
            disabled={cellWidth >= 80}
          >
            <Plus className="size-3.5" />
          </button>
        </div>

        <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

        {/* 补全角色历史 */}
        <Button
          size="sm"
          variant="ghost"
          onClick={onCompleteHistory}
          disabled={completableCount === 0 || isCompleting}
          aria-busy={isCompleting}
          title={
            completableCount === 0
              ? '没有需要补全的角色'
              : `为 ${completableCount} 个无历史角色补全起始章节记录`
          }
          className="relative size-8 p-0 active:scale-[0.96] transition-transform"
        >
          <History className="size-3.5" />
          {completableCount > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-3.5 rounded-full bg-red-500 px-1 text-[9px] leading-3.5 text-white">{completableCount}</span>}
        </Button>

        {/* LLM 相似度扫描（AI 整理）：语义相似智能合并 */}
        {onSimilarityScan && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onSimilarityScan}
            disabled={similarityScanning}
            aria-busy={similarityScanning}
            title="LLM 分析语义相似的实体并智能合并"
            className="size-8 p-0 active:scale-[0.96] transition-transform"
          >
            <Wand2 className="size-3.5" />
          </Button>
        )}
      </div>

      {/* ── 筛选栏：实体类型过滤 chips ── */}
      <div className="flex items-center gap-1 px-3 min-h-8 py-1 bg-surface-2/40 border-t border-border/60 text-xs overflow-x-auto whitespace-nowrap" role="group" aria-label="实体类型筛选">
        {FILTER_OPTIONS.map((opt) => {
          const active = activeFilter === opt.key
          const color = opt.key ? GROUP_META[opt.key].color : undefined
          return (
            <button
              key={opt.key ?? 'all'}
              type="button"
              onClick={() => onFilterChange(opt.key)}
              aria-pressed={active}
              className={cn(
                'inline-flex h-7 items-center gap-1 px-2.5 rounded-[6px] text-[11px] bg-surface-1 border transition-[color,background-color,border-color,transform] active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 shrink-0',
                active
                  ? color
                    ? 'text-white border-transparent'
                    : 'text-text bg-surface-3 border-border-strong'
                  : 'text-muted-foreground border-border hover:text-text hover:border-border-strong'
              )}
              style={active && color ? { background: color, borderColor: color } : undefined}
              title={opt.key ? `只显示${opt.label}` : '显示全部分组'}
            >
              {/* 分类颜色圆点（active 时变白） */}
              {color && (
                <span
                  className={cn('w-1.5 h-1.5 rounded-full shrink-0 transition-colors', active && 'bg-white')}
                  style={!active ? { background: color } : undefined}
                />
              )}
              {opt.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
