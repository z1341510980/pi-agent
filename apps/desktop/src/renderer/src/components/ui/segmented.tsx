import type { ComponentType, ReactElement } from 'react'
import { cn } from '@/lib/utils'

/**
 * Segmented —— 分段选择器（roving tablist）
 *
 * 收口此前散落在小说工作台的四处手写实现（视图切换 / 工作区模式 / 矩阵工具栏视图 /
 * 右栏 Tab），它们各自复制了一份几乎相同的类名串，改一次样式要改四个地方。
 *
 * 视觉约定（沿用原实现）：
 * - 容器 surface-2 无边框，营造内陷感
 * - 选中项 surface-1 + 微阴影上浮，形成物理层级
 * - active:scale 提供点击反馈；hover 柔和过渡
 *
 * 可访问性：容器 role="tablist"，选项 role="tab" + aria-selected。
 * 键盘用左右方向键在选项间移动（只有选中项进 Tab 序列，符合 tablist 惯例）。
 */

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: ComponentType<{ className?: string }>
  /** 悬浮提示；缺省时用 label */
  title?: string
  /** 单个选项上的引导锚点（driver.js 有几处直接指向某一个 tab） */
  dataTour?: string
  /** 可选角标计数（0 或 undefined 不显示），如审校 Tab 的待办数 */
  badge?: number
}

export interface SegmentedProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>
  value: T
  onChange: (value: T) => void
  /** tablist 的无障碍名称 */
  ariaLabel: string
  /** 尺寸：md 用于顶栏（h-7），sm 用于工具栏与右栏 Tab（h-6） */
  size?: 'sm' | 'md'
  /** 引导流程锚点（driver.js） */
  dataTour?: string
  className?: string
}

const SIZE_CLASS = {
  sm: 'h-6 px-2.5 text-[11px] gap-1',
  md: 'h-7 px-3 text-[11px] gap-1.5',
} as const

const ICON_CLASS = {
  sm: 'size-3',
  md: 'size-3.5',
} as const

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = 'md',
  dataTour,
  className,
}: SegmentedProps<T>): ReactElement {
  // 左右方向键移动选中项：tablist 的标准键盘行为，循环到头尾
  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (delta === 0) return
    const index = options.findIndex((o) => o.value === value)
    if (index === -1) return
    event.preventDefault()
    const next = options[(index + delta + options.length) % options.length]
    onChange(next.value)
  }

  return (
    <div
      className={cn('inline-flex items-center gap-0.5 p-0.5 bg-surface-2 rounded-lg', className)}
      role="tablist"
      aria-label={ariaLabel}
      data-tour={dataTour}
      onKeyDown={handleKeyDown}
    >
      {options.map((option) => {
        const selected = option.value === value
        const Icon = option.icon
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={selected}
            // 未选中项退出 Tab 序列，由方向键到达
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            title={option.title ?? option.label}
            data-tour={option.dataTour}
            className={cn(
              'inline-flex items-center font-medium rounded-[6px] whitespace-nowrap',
              'transition-all duration-200 ease-out active:scale-[0.96]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
              SIZE_CLASS[size],
              selected
                ? 'bg-surface-1 text-text shadow-sm'
                : 'text-subtle hover:text-text hover:bg-surface-1/50',
            )}
          >
            {Icon && <Icon className={ICON_CLASS[size]} />}
            <span className="leading-none">{option.label}</span>
            {option.badge != null && option.badge > 0 && (
              <span
                className="inline-flex min-w-3.5 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-semibold leading-3.5 text-white tabular-nums"
                aria-label={`${option.badge} 项待办`}
              >
                {option.badge > 99 ? '99+' : option.badge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
