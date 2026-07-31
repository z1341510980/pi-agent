import type { ReactElement, ReactNode } from 'react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/**
 * CoordinateMenu —— 按坐标弹出的浮层菜单
 *
 * 矩阵是虚拟化网格，不能给每个单元格套一个 Radix `ContextMenu.Trigger`
 * （几千个 trigger 的开销不可接受），所以右键菜单走"记录 {x,y} → 受控打开"这条路。
 * 这里把坐标包成一个零尺寸的 fixed 锚点交给 Popover 定位，从而复用它的：
 *   - 碰撞规避：替掉原来 `Math.min(x, innerWidth - 180)` 这类按当时菜单宽度猜的硬编码常量
 *   - 外部点击 / Esc 关闭：替掉两处各写一遍的 window 监听，
 *     以及随之而来的"内部每个可点区域都要 stopPropagation，漏一个就点不动"
 *   - 焦点管理：关闭后焦点归还触发元素
 */

export interface CoordinateMenuProps {
  /** 视口坐标；null 表示关闭 */
  position: { x: number; y: number } | null
  onClose: () => void
  /** 菜单的无障碍名称 */
  ariaLabel: string
  className?: string
  children: ReactNode
}

export function CoordinateMenu({
  position,
  onClose,
  ariaLabel,
  className,
  children,
}: CoordinateMenuProps): ReactElement {
  return (
    <Popover
      open={position !== null}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <PopoverAnchor asChild>
        <div
          aria-hidden
          style={{
            position: 'fixed',
            left: position?.x ?? 0,
            top: position?.y ?? 0,
            width: 0,
            height: 0,
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        role="menu"
        aria-label={ariaLabel}
        side="bottom"
        align="start"
        sideOffset={0}
        collisionPadding={8}
        // 在菜单上再次右键不应穿透到底层再开一个菜单
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
        className={cn('w-auto py-1 text-xs', className)}
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}

/** 菜单条目的共享样式：与 ui/dropdown-menu 的 item 视觉对齐 */
export const coordinateMenuItemClass =
  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ' +
  'hover:bg-accent focus-visible:outline-none focus-visible:bg-accent ' +
  'disabled:pointer-events-none disabled:opacity-40'

export const coordinateMenuDangerItemClass =
  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-destructive transition-colors ' +
  'hover:bg-destructive/10 focus-visible:outline-none focus-visible:bg-destructive/10 ' +
  'disabled:pointer-events-none disabled:opacity-40'
