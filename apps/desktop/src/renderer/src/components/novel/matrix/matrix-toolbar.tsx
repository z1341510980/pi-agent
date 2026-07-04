/**
 * MatrixToolbar：矩阵视图工具栏
 *
 * 功能分组：
 * - 章节号显示（当前/总数）
 * - 编辑组：撤销/重做
 * - 缩放：单元格宽度 ± 按钮
 * - 补全角色历史
 * - 过滤 chips：角色/冲突/伏笔/势力/地点/世界要素/全部
 */

import { type ReactElement } from 'react'
import { Undo2, Redo2, History, Minus, Plus } from 'lucide-react'
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
  completableCount,
  isCompleting,
  onCompleteHistory,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  activeFilter,
  onFilterChange
}: MatrixToolbarProps): ReactElement {
  const zoomPct = Math.round((cellWidth / 36) * 100)

  return (
    <div className="relative z-20 flex items-center gap-1 flex-wrap px-3 min-h-9 py-1 bg-surface-1 border-b border-border text-xs shrink-0">
      {/* 章节号显示 + 当前章节 badge */}
      <span className="font-mono text-[11px] text-muted-foreground px-1 tabular-nums">
        {playheadChapter} / {totalChapters}
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
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          className="inline-flex items-center justify-center min-w-[26px] h-[26px] px-1.5 text-muted-foreground hover:text-text hover:bg-muted rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={onUndo}
          title="撤销"
          disabled={!canUndo}
        >
          <Undo2 className="size-3.5" />
        </button>
        <button
          type="button"
          className="inline-flex items-center justify-center min-w-[26px] h-[26px] px-1.5 text-muted-foreground hover:text-text hover:bg-muted rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={onRedo}
          title="重做"
          disabled={!canRedo}
        >
          <Redo2 className="size-3.5" />
        </button>
      </div>

      <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

      {/* 缩放 */}
      <div className="inline-flex items-center bg-surface-3 border border-border rounded-md overflow-hidden">
        <button
          type="button"
          className="inline-flex items-center justify-center min-w-[26px] h-[26px] px-1.5 text-muted-foreground hover:text-text hover:bg-muted transition-[color,background-color,transform] active:scale-[0.96] disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={onZoomOut}
          title="缩小单元格"
          disabled={cellWidth <= 24}
        >
          <Minus className="size-3.5" />
        </button>
        <span className="font-mono text-[11px] text-muted-foreground min-w-[42px] text-center px-1 tabular-nums">
          {zoomPct}%
        </span>
        <button
          type="button"
          className="inline-flex items-center justify-center min-w-[26px] h-[26px] px-1.5 text-muted-foreground hover:text-text hover:bg-muted transition-[color,background-color,transform] active:scale-[0.96] disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={onZoomIn}
          title="放大单元格"
          disabled={cellWidth >= 56}
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
        title={
          completableCount === 0
            ? '没有需要补全的角色'
            : `为 ${completableCount} 个无历史角色补全起始章节记录`
        }
        className="h-7"
      >
        <History className="size-3.5" />
        <span className="hidden sm:inline">
          {isCompleting
            ? '补全中…'
            : `补全历史${completableCount > 0 ? ` (${completableCount})` : ''}`}
        </span>
      </Button>

      {/* 分隔线：补全历史与筛选 chips 之间 */}
      <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

      {/* 过滤 chips */}
      <div className="flex items-center gap-1">
        {FILTER_OPTIONS.map((opt) => {
          const active = activeFilter === opt.key
          const color = opt.key ? GROUP_META[opt.key].color : undefined
          return (
            <button
              key={opt.key ?? 'all'}
              type="button"
              onClick={() => onFilterChange(opt.key)}
              className={cn(
                'inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-surface-1 border transition-[color,background-color,border-color,transform] active:scale-[0.96]',
                active
                  ? color
                    ? 'text-white border-transparent'
                    : 'text-text bg-surface-3 border-border-strong'
                  : 'text-muted-foreground border-border hover:text-text hover:border-border-strong'
              )}
              style={active && color ? { background: color, borderColor: color } : undefined}
              title={opt.key ? `只显示${opt.label}` : '显示全部分组'}
            >
              {opt.label}
            </button>
          )
        })}
      </div>

      <div className="ml-auto" aria-hidden="true" />
    </div>
  )
}
