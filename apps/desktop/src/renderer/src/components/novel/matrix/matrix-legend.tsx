/**
 * MatrixLegend：矩阵符号图例条（可折叠）
 *
 * 图例项来自 legend-spec.ts —— 那里的每条都对应实现里真实存在的绘制。
 * 此前这里手写 12 条常量，其中 `★▲▼◆` 四个符号在实现里根本不存在
 * （角色/冲突是色带 + 端点把手、地点是 6px 圆点），用户按图例找符号找不到。
 *
 * 折叠态：紧凑条，仅显示展开按钮 + 摘要
 * 展开态：图例项横排 + 下方居中搜索框
 */

import { useState, type ReactElement } from 'react'
import { ChevronDown, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { selectLegendEntries, type LegendEntry, type LegendShape } from './legend-spec'

export interface MatrixLegendProps {
  /** 搜索关键字（受控，由父组件持有） */
  searchQuery?: string
  onSearchChange?: (next: string) => void
  /**
   * 是否有实体展开了子轨道。
   *
   * 伏笔的 beat 四色只在子轨道生效，折叠态是另一套视觉（靠填充区分）。
   * 未展开时列出四色只会让用户在折叠视图里找不到对应颜色。
   */
  hasExpandedSubtracks?: boolean
}

/** 按形态渲染图例样例。形态与 matrix-row 的实际绘制一一对应。 */
function LegendGlyph({ shape, color }: { shape: LegendShape; color: string }): ReactElement {
  switch (shape) {
    case 'dot':
      return (
        <span
          className="rounded-full shrink-0"
          style={{ width: 6, height: 6, background: color }}
          aria-hidden
        />
      )
    case 'ring':
      return (
        <span
          className="rounded-full shrink-0"
          style={{ width: 6, height: 6, background: 'var(--color-surface-1)', boxShadow: `0 0 0 1.5px ${color}` }}
          aria-hidden
        />
      )
    case 'band':
      return (
        <span
          className="rounded-sm shrink-0"
          style={{
            width: 14,
            height: 6,
            background: `linear-gradient(90deg, ${color}14 0%, ${color}33 50%, ${color}14 100%)`,
            boxShadow: `inset 0 0 0 1px ${color}40`,
          }}
          aria-hidden
        />
      )
    case 'dashed-line':
      return (
        <span
          className="shrink-0"
          style={{ width: 14, height: 0, borderTop: `2px dashed ${color}` }}
          aria-hidden
        />
      )
    case 'solid-line':
      return (
        <span
          className="shrink-0"
          style={{ width: 14, height: 0, borderTop: `2px solid ${color}` }}
          aria-hidden
        />
      )
    case 'vertical-line':
      return (
        <span className="shrink-0" style={{ width: 2, height: 10, background: color }} aria-hidden />
      )
    case 'hatch':
      return (
        <span
          className="rounded-sm shrink-0"
          style={{
            width: 14,
            height: 8,
            background: `repeating-linear-gradient(-45deg, ${color}38 0 3px, ${color}10 3px 6px)`,
          }}
          aria-hidden
        />
      )
    case 'none':
      // 「什么都不画」本身是需要传达的信息，用虚线空框表示"此处无标记"
      return (
        <span
          className="rounded-sm shrink-0"
          style={{ width: 12, height: 8, border: `1px dashed ${color}55` }}
          aria-hidden
        />
      )
  }
}

function LegendRow({ entry }: { entry: LegendEntry }): ReactElement {
  const title = entry.note ? `${entry.label}：${entry.note}` : entry.label
  return (
    <span className="flex items-center gap-1 whitespace-nowrap shrink-0" title={title}>
      <LegendGlyph shape={entry.shape} color={entry.color} />
      <span>{entry.label}</span>
      {entry.note && <span className="text-hint">（{entry.note}）</span>}
    </span>
  )
}

export function MatrixLegend({
  searchQuery = '',
  onSearchChange,
  hasExpandedSubtracks = false,
}: MatrixLegendProps = {}): ReactElement {
  const [collapsed, setCollapsed] = useState(false)

  const entries = selectLegendEntries('collapsed')
  const subtrackEntries = hasExpandedSubtracks ? selectLegendEntries('subtrack') : []
  const total = entries.length + subtrackEntries.length

  return (
    <div className="shrink-0 border-b border-border bg-surface-1/50">
      {/* 图例条 */}
      <div className="flex items-center gap-2 px-3 min-h-7 py-1 text-nano text-muted-foreground">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-micro font-medium text-text-secondary hover:bg-muted transition-colors shrink-0"
          aria-expanded={!collapsed}
          aria-label={collapsed ? '展开图例' : '收起图例'}
          title={collapsed ? '展开图例' : '收起图例'}
        >
          <ChevronDown className={cn('size-3.5 transition-transform', collapsed && '-rotate-90')} aria-hidden="true" />
          图例
          <span className="font-mono text-hint">{total}</span>
        </button>
        {!collapsed && (
          <div className="flex items-center gap-3 overflow-x-auto whitespace-nowrap flex-1 min-w-0">
            {entries.map((entry) => (
              <LegendRow key={entry.id} entry={entry} />
            ))}
            {subtrackEntries.length > 0 && (
              <>
                <span className="h-3 w-px bg-border shrink-0" aria-hidden />
                <span className="text-hint shrink-0">子轨道</span>
                {subtrackEntries.map((entry) => (
                  <LegendRow key={entry.id} entry={entry} />
                ))}
              </>
            )}
          </div>
        )}
        {collapsed && (
          <span className="text-nano text-hint truncate">已折叠 · 点击左侧按钮展开查看符号含义与搜索</span>
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
              className="w-full h-7 pl-8 pr-7 rounded-md bg-surface-2 border border-border text-micro text-text placeholder:text-hint focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30 transition-colors"
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
