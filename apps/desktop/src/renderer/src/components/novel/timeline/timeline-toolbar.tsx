/**
 * TimelineToolbar：时间轴工具栏
 *
 * 功能分组：
 * - 章节号显示
 * - 编辑组：撤销/重做/删除
 * - 视图组：缩放档位 + 过滤
 * - 补全历史按钮
 */

import { type ReactElement } from 'react'
import {
  History,
  Filter,
  Undo2,
  Redo2,
  Trash2,
  Spline,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type ZoomLevel = 'compact' | 'standard' | 'detailed'

export const ZOOM_WIDTH: Record<ZoomLevel, number> = {
  compact: 80,
  standard: 180,
  detailed: 280,
}

export interface TimelineFilter {
  character: boolean
  conflict: boolean
  foreshadow: boolean
  faction: boolean
  location: boolean
  worldElement: boolean
}

export const DEFAULT_FILTER: TimelineFilter = {
  character: true,
  conflict: true,
  foreshadow: true,
  faction: true,
  location: true,
  worldElement: true,
}

export interface TimelineToolbarProps {
  zoom: ZoomLevel
  filter: TimelineFilter
  completableCount: number
  isCompleting: boolean
  onZoomChange: (zoom: ZoomLevel) => void
  onFilterChange: (filter: TimelineFilter) => void
  onCompleteHistory: () => void
  totalChapters: number
  /** 当前章节号显示 */
  playheadChapter: number
  /** 编辑组 */
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  canDelete: boolean
  onDelete: () => void
  /** 关系连线开关 */
  showRelations: boolean
  onToggleRelations: () => void
}

const FILTER_OPTIONS: Array<{ key: keyof TimelineFilter; label: string; color: string }> = [
  { key: 'character', label: '角色', color: 'rgb(59, 130, 246)' },
  { key: 'conflict', label: '冲突', color: 'rgb(244, 63, 94)' },
  { key: 'foreshadow', label: '伏笔', color: 'rgb(245, 158, 11)' },
  { key: 'faction', label: '势力', color: 'rgb(168, 85, 247)' },
  { key: 'location', label: '地点', color: 'rgb(6, 182, 212)' },
  { key: 'worldElement', label: '世界', color: 'rgb(99, 102, 241)' },
]

export function TimelineToolbar({
  zoom,
  filter,
  completableCount,
  isCompleting,
  onZoomChange,
  onFilterChange,
  onCompleteHistory,
  totalChapters,
  playheadChapter,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  canDelete,
  onDelete,
  showRelations,
  onToggleRelations,
}: TimelineToolbarProps): ReactElement {
  const handleFilterToggle = (key: keyof TimelineFilter): void => {
    onFilterChange({ ...filter, [key]: !filter[key] })
  }

  return (
    <div className="novel-timeline-toolbar">
      {/* 章节号显示 */}
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {playheadChapter} / {totalChapters}
        </span>
      </div>

      <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

      {/* 编辑组 */}
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          className="novel-timeline-nav-btn"
          onClick={onUndo}
          title="撤销"
          disabled={!canUndo}
        >
          <Undo2 className="size-3.5" />
        </button>
        <button
          type="button"
          className="novel-timeline-nav-btn"
          onClick={onRedo}
          title="重做"
          disabled={!canRedo}
        >
          <Redo2 className="size-3.5" />
        </button>
        <button
          type="button"
          className="novel-timeline-nav-btn novel-timeline-delete-btn"
          onClick={onDelete}
          title="删除选中"
          disabled={!canDelete}
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

      {/* 关系连线开关 */}
      <button
        type="button"
        className={cn('novel-timeline-nav-btn', showRelations && 'is-active')}
        onClick={onToggleRelations}
        title={showRelations ? '隐藏关系连线' : '显示关系连线'}
      >
        <Spline className="size-3.5" />
      </button>

      <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

      {/* 缩放 */}
      <div className="novel-timeline-toolbar-segment">
        {(['compact', 'standard', 'detailed'] as const).map((level) => (
          <button
            key={level}
            type="button"
            className={cn(
              'novel-timeline-toolbar-segment-btn',
              zoom === level && 'is-active',
            )}
            onClick={() => onZoomChange(level)}
            title={
              level === 'compact'
                ? '紧凑视图（80px/章）'
                : level === 'standard'
                  ? '标准视图（180px/章）'
                  : '详细视图（280px/章）'
            }
          >
            {level === 'compact' ? '紧凑' : level === 'standard' ? '标准' : '详细'}
          </button>
        ))}
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
          {isCompleting ? '补全中…' : `补全历史${completableCount > 0 ? ` (${completableCount})` : ''}`}
        </span>
      </Button>

      <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

      {/* 过滤 */}
      <div className="flex items-center gap-1">
        <Filter className="size-3.5 text-muted-foreground" />
        {FILTER_OPTIONS.map((opt) => {
          const active = filter[opt.key]
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => handleFilterToggle(opt.key)}
              className={cn(
                'novel-timeline-filter-btn',
                active && 'is-active',
              )}
              style={active ? { background: opt.color, borderColor: opt.color } : undefined}
              title={active ? `隐藏${opt.label}轨道` : `显示${opt.label}轨道`}
            >
              {opt.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
