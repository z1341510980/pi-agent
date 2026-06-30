/**
 * TimelineToolbar：时间轴工具栏
 *
 * 功能分组：
 * - 工具组：选择/剃刀/手型/缩放
 * - 导航组：首章/上一章/播放暂停/下一章/末章 + 章节号显示
 * - 编辑组：撤销/重做/删除
 * - 视图组：Snap 开关 + 缩放档位 + 过滤
 * - 补全历史按钮
 */

import { type ReactElement } from 'react'
import {
  History,
  Filter,
  MousePointer2,
  Scissors,
  Hand,
  ZoomIn,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  ChevronFirst,
  ChevronLast,
  Undo2,
  Redo2,
  Trash2,
  Magnet,
  Spline,
  ArrowRightToLine,
  ArrowRightFromLine,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Tool } from './timeline-editor'

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
  /** 工具组 */
  activeTool: Tool
  onToolChange: (tool: Tool) => void
  /** 导航组 */
  playheadChapter: number
  isPlaying: boolean
  onPlayToggle: () => void
  onPrevChapter: () => void
  onNextChapter: () => void
  onFirstChapter: () => void
  onLastChapter: () => void
  /** In/Out 标记组 */
  inChapter?: number | null
  outChapter?: number | null
  onSetIn: () => void
  onSetOut: () => void
  /** 编辑组 */
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  canDelete: boolean
  onDelete: () => void
  /** Snap 开关 */
  snapEnabled: boolean
  onSnapToggle: () => void
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

const TOOLS: Array<{ tool: Tool; icon: typeof MousePointer2; label: string }> = [
  { tool: 'select', icon: MousePointer2, label: '选择' },
  { tool: 'razor', icon: Scissors, label: '剃刀' },
  { tool: 'hand', icon: Hand, label: '手型' },
  { tool: 'zoom', icon: ZoomIn, label: '缩放' },
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
  activeTool,
  onToolChange,
  playheadChapter,
  isPlaying,
  onPlayToggle,
  onPrevChapter,
  onNextChapter,
  onFirstChapter,
  onLastChapter,
  inChapter,
  outChapter,
  onSetIn,
  onSetOut,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  canDelete,
  onDelete,
  snapEnabled,
  onSnapToggle,
  showRelations,
  onToggleRelations,
}: TimelineToolbarProps): ReactElement {
  const handleFilterToggle = (key: keyof TimelineFilter): void => {
    onFilterChange({ ...filter, [key]: !filter[key] })
  }

  return (
    <div className="novel-timeline-toolbar">
      {/* 工具组 */}
      <div className="novel-timeline-toolbar-segment">
        {TOOLS.map(({ tool, icon: Icon, label }) => (
          <button
            key={tool}
            type="button"
            className={cn(
              'novel-timeline-toolbar-segment-btn',
              activeTool === tool && 'is-active',
            )}
            onClick={() => onToolChange(tool)}
            title={label}
          >
            <Icon className="size-3.5" />
          </button>
        ))}
      </div>

      <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

      {/* 导航组 */}
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          className="novel-timeline-nav-btn"
          onClick={onFirstChapter}
          title="首章"
          disabled={playheadChapter <= 1}
        >
          <ChevronFirst className="size-3.5" />
        </button>
        <button
          type="button"
          className="novel-timeline-nav-btn"
          onClick={onPrevChapter}
          title="上一章"
          disabled={playheadChapter <= 1}
        >
          <SkipBack className="size-3.5" />
        </button>
        <button
          type="button"
          className={cn('novel-timeline-nav-btn novel-timeline-play-btn', isPlaying && 'is-playing')}
          onClick={onPlayToggle}
          title={isPlaying ? '暂停' : '播放'}
        >
          {isPlaying ? <Pause className="size-4" /> : <Play className="size-4" />}
        </button>
        <button
          type="button"
          className="novel-timeline-nav-btn"
          onClick={onNextChapter}
          title="下一章"
          disabled={playheadChapter >= totalChapters}
        >
          <SkipForward className="size-3.5" />
        </button>
        <button
          type="button"
          className="novel-timeline-nav-btn"
          onClick={onLastChapter}
          title="末章"
          disabled={playheadChapter >= totalChapters}
        >
          <ChevronLast className="size-3.5" />
        </button>
        <span className="ml-1.5 text-[11px] tabular-nums text-muted-foreground">
          {playheadChapter} / {totalChapters}
        </span>
      </div>

      <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

      {/* In/Out 标记组 */}
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          className="novel-timeline-nav-btn"
          onClick={onSetIn}
          title={`设置 In 点（当前：第 ${inChapter ?? '-'} 章）`}
        >
          <ArrowRightToLine className="size-3.5" />
        </button>
        <button
          type="button"
          className="novel-timeline-nav-btn"
          onClick={onSetOut}
          title={`设置 Out 点（当前：第 ${outChapter ?? '-'} 章）`}
        >
          <ArrowRightFromLine className="size-3.5" />
        </button>
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

      {/* Snap 开关 */}
      <button
        type="button"
        className={cn('novel-timeline-nav-btn', snapEnabled && 'is-active')}
        onClick={onSnapToggle}
        title={snapEnabled ? '关闭吸附' : '开启吸附'}
      >
        <Magnet className="size-3.5" />
      </button>

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
