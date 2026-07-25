/**
 * MatrixToolbar：矩阵视图工具栏（单行紧凑）
 *
 * 单行结构：返回 + 视图切换 + 关系叠加层 | 章节 badge | 撤销/重做 + 补全 + 扫描 | 缩放 + 筛选 chips
 *
 * 图例（MatrixLegend）在本组件之外、由 MatrixWorkspace 插入到 toolbar 与 view 之间。
 */

import { type ReactElement } from 'react'
import { ArrowLeft, Undo2, Redo2, History, Minus, Plus, Wand2, Grid3x3, LayoutGrid, Network } from 'lucide-react'
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
  /** 连续缩放（Ctrl+滚轮） */
  onCellWidthChange?: (next: number) => void
  /** 补全历史 */
  completableCount: number
  isCompleting: boolean
  onCompleteHistory: () => void
  /** 撤销/重做 */
  canUndo?: boolean
  canRedo?: boolean
  onUndo?: () => void
  onRedo?: () => void
  /** 过滤 */
  activeFilter: MatrixEntityKind | null
  onFilterChange: (filter: MatrixEntityKind | null) => void
  /** LLM 相似度扫描 */
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

/** 通用图标按钮样式 */
const iconBtn = 'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:text-text hover:bg-muted transition-[color,background-color,transform] active:scale-[0.96] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50'

export function MatrixToolbar({
  playheadChapter,
  totalChapters,
  currentChapterTitle,
  cellWidth,
  onZoomIn,
  onZoomOut,
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
      {/* ── 单行工具栏 ── */}
      <div className="flex items-center gap-1 px-2 h-10 text-xs overflow-hidden">
        {/* 返回 */}
        <button type="button" className={iconBtn} onClick={() => window.history.back()} title="返回" aria-label="返回">
          <ArrowLeft className="size-3.5" />
        </button>

        {/* 视图切换 */}
        <div className="inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-surface-2 p-0.5" role="tablist" aria-label="视图切换">
          {([['matrix', '矩阵', Grid3x3], ['canvas', '画布', LayoutGrid]] as const).map(([mode, label, Icon]) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={viewMode === mode}
              onClick={() => onViewModeChange(mode)}
              className={cn(
                'inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-colors',
                viewMode === mode ? 'bg-surface-1 text-text shadow-sm' : 'text-muted-foreground hover:text-text',
              )}
            >
              <Icon className="size-3" />{label}
            </button>
          ))}
        </div>

        {/* 关系叠加层 */}
        {onToggleRelationshipOverlay && (
          <button
            type="button"
            onClick={onToggleRelationshipOverlay}
            aria-pressed={showRelationshipOverlay}
            title="关系叠加层"
            aria-label="关系叠加层"
            className={cn(
              iconBtn,
              showRelationshipOverlay && 'bg-primary/15 text-primary hover:bg-primary/20 hover:text-primary',
            )}
          >
            <Network className="size-3.5" />
          </button>
        )}

        {/* 章节 badge */}
        <span
          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/25 text-amber-600 dark:text-amber-400 text-[10px] font-medium shrink-0"
          title={`第 ${playheadChapter} 章 / 共 ${totalChapters} 章${currentChapterTitle ? ` · ${currentChapterTitle}` : ''}`}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" style={{ boxShadow: '0 0 4px #f59e0b' }} />
          <span className="font-mono tabular-nums">{String(playheadChapter).padStart(2, '0')}</span>
          {currentChapterTitle && <span className="truncate max-w-[100px]">{currentChapterTitle}</span>}
        </span>

        {/* 分隔 */}
        <div className="mx-0.5 h-4 w-px bg-border/60 shrink-0" aria-hidden="true" />

        {/* 撤销/重做 */}
        <button type="button" className={iconBtn} onClick={onUndo} title="撤销 (Ctrl+Z)" aria-label="撤销" disabled={!canUndo}>
          <Undo2 className="size-3.5" />
        </button>
        <button type="button" className={iconBtn} onClick={onRedo} title="重做 (Ctrl+Shift+Z)" aria-label="重做" disabled={!canRedo}>
          <Redo2 className="size-3.5" />
        </button>

        {/* 补全历史 */}
        <button
          type="button"
          className={cn(iconBtn, 'relative')}
          onClick={onCompleteHistory}
          disabled={completableCount === 0 || isCompleting}
          title={completableCount === 0 ? '没有需要补全的角色' : `为 ${completableCount} 个角色补全起始章节`}
          aria-label="补全角色历史"
        >
          <History className="size-3.5" />
          {completableCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 min-w-3.5 rounded-full bg-red-500 px-0.5 text-[8px] leading-3.5 text-white">{completableCount}</span>
          )}
        </button>

        {/* LLM 相似度扫描 */}
        {onSimilarityScan && (
          <button
            type="button"
            className={iconBtn}
            onClick={onSimilarityScan}
            disabled={similarityScanning}
            title="LLM 语义相似智能合并"
            aria-label="相似度扫描"
          >
            <Wand2 className={cn('size-3.5', similarityScanning && 'animate-spin')} />
          </button>
        )}

        {/* 弹性间距 */}
        <div className="flex-1" aria-hidden="true" />

        {/* 缩放组（紧凑：- 百分比 +） */}
        <div className="inline-flex items-center gap-0.5 shrink-0" aria-label="矩阵缩放">
          <button type="button" className={iconBtn} onClick={onZoomOut} title="缩小 (Ctrl+滚轮)" aria-label="缩小" disabled={cellWidth <= 24}>
            <Minus className="size-3" />
          </button>
          <span className="font-mono text-[10px] text-muted-foreground min-w-[32px] text-center tabular-nums">
            {zoomPct}%
          </span>
          <button type="button" className={iconBtn} onClick={onZoomIn} title="放大 (Ctrl+滚轮)" aria-label="放大" disabled={cellWidth >= 80}>
            <Plus className="size-3" />
          </button>
        </div>

        {/* 分隔 */}
        <div className="mx-0.5 h-4 w-px bg-border/60 shrink-0" aria-hidden="true" />

        {/* 筛选 chips（紧凑胶囊） */}
        <div className="flex items-center gap-0.5 overflow-x-auto scrollbar-none shrink-0" role="group" aria-label="实体类型筛选">
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
                  'inline-flex h-6 items-center gap-1 px-2 rounded-full text-[10px] whitespace-nowrap transition-[color,background-color,border-color,transform] active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 shrink-0',
                  active
                    ? color
                      ? 'text-white border border-transparent'
                      : 'text-text bg-surface-3 border border-border'
                    : 'text-muted-foreground border border-transparent hover:text-text hover:bg-muted',
                )}
                style={active && color ? { background: color } : undefined}
                title={opt.key ? `只显示${opt.label}` : '显示全部'}
              >
                {color && (
                  <span
                    className={cn('w-1.5 h-1.5 rounded-full shrink-0', active && 'bg-white/90')}
                    style={!active ? { background: color } : undefined}
                  />
                )}
                {opt.label}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
