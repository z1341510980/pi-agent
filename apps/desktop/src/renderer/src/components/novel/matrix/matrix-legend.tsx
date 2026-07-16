/**
 * MatrixLegend：矩阵符号图例条
 *
 * 紧凑横排展示所有单元格符号的含义，放在 toolbar 下方。
 * 不可折叠，高度 24px。
 */

import type { ReactElement } from 'react'
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

export function MatrixLegend(): ReactElement {
  return (
    <div className="flex items-center gap-3 h-6 px-4 bg-surface-1/50 border-b border-border text-[10px] text-muted-foreground overflow-x-auto shrink-0">
      {LEGEND_ITEMS.map((item) => (
        <span key={item.label} className="flex items-center gap-1 whitespace-nowrap">
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
  )
}
