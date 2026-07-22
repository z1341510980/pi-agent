/**
 * MatrixLegend：矩阵符号图例条（可折叠）
 *
 * 折叠态：紧凑条，仅显示展开按钮 + 摘要
 * 展开态：图例项横排 + 下方居中搜索框
 */

import { useState, type ReactElement } from 'react'
import { ChevronDown, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { GROUP_META } from './matrix-logic'

interface LegendItem {
  symbol: string
  label: string
  color: string
}

const LEGEND_ITEMS: LegendItem[] = [
  { symbol: '★', label: '角色出场', color: GROUP_META.character.color },
  { symbol: '▲', label: '冲突起始', color: GROUP_META.conflict.color },
  { symbol: '▼', label: '冲突结束', color: GROUP_META.conflict.color },
  { symbol: '✦', label: '冲突高潮', color: '#f59e0b' },
  { symbol: '━', label: '跨度色带', color: GROUP_META.conflict.color },
  { symbol: '◇', label: '线索推进', color: GROUP_META.clue.color },
  { symbol: '●', label: '伏笔埋设', color: GROUP_META.foreshadow.color },
  { symbol: '○', label: '伏笔回收', color: GROUP_META.foreshadow.color },
  { symbol: '┄', label: '伏笔连线', color: GROUP_META.foreshadow.color },
  { symbol: '◆', label: '地点出场', color: GROUP_META.location.color },
  { symbol: '▌', label: '常驻要素', color: GROUP_META.world_element.color },
  { symbol: '│', label: '当前章节', color: '#f59e0b' },
]

export interface MatrixLegendProps {
  /** 搜索关键字（受控，由父组件持有） */
  searchQuery?: string
  onSearchChange?: (next: string) => void
}

export function MatrixLegend({ searchQuery = '', onSearchChange }: MatrixLegendProps = {}): ReactElement {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div className="shrink-0 border-b border-border bg-surface-1/50">
      {/* 图例条 */}
      <div className="flex items-center gap-2 px-3 h-7 text-[10px] text-muted-foreground">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-text-secondary hover:bg-muted transition-colors shrink-0"
          aria-expanded={!collapsed}
          aria-label={collapsed ? '展开图例' : '收起图例'}
          title={collapsed ? '展开图例' : '收起图例'}
        >
          <ChevronDown className={cn('size-3.5 transition-transform', collapsed && '-rotate-90')} aria-hidden="true" />
          图例
          <span className="font-mono text-hint">{LEGEND_ITEMS.length}</span>
        </button>
        {!collapsed && (
          <div className="flex items-center gap-3 overflow-x-auto whitespace-nowrap flex-1 min-w-0">
            {LEGEND_ITEMS.map((item) => (
              <span key={item.label} className="flex items-center gap-1 whitespace-nowrap shrink-0">
                <span
                  className="text-[11px] leading-none inline-block min-w-[10px] text-center"
                  style={{ color: item.color }}
                >
                  {item.symbol}
                </span>
                <span>{item.label}</span>
              </span>
            ))}
          </div>
        )}
        {collapsed && (
          <span className="text-[10px] text-hint truncate">已折叠 · 点击左侧按钮展开查看符号含义与搜索</span>
        )}
      </div>

      {/* 展开态：搜索框居中 */}
      {!collapsed && onSearchChange && (
        <div className="flex justify-center px-3 pb-2">
          <div className="relative w-full max-w-md">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-hint pointer-events-none" aria-hidden="true" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="搜索实体名称以定位行…"
              className="w-full h-7 pl-8 pr-7 rounded-md bg-surface-2 border border-border text-[11px] text-text placeholder:text-hint focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30 transition-colors"
              aria-label="搜索实体"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => onSearchChange('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex size-5 items-center justify-center rounded text-hint hover:bg-muted hover:text-text transition-colors"
                aria-label="清除搜索"
                title="清除"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
