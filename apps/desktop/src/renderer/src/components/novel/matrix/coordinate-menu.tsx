import { createPortal } from 'react-dom'
import { useEffect, useLayoutEffect, useRef, type ReactElement, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * CoordinateMenu —— 按坐标弹出的浮层菜单
 *
 * 矩阵是虚拟化网格，不能给每个单元格套一个 Radix `ContextMenu.Trigger`
 * （几千个 trigger 的开销不可接受），所以右键菜单走"记录 {x,y} → 受控打开"这条路。
 * 菜单直接 portal 到 body，并使用 fixed 坐标，避免虚拟化滚动容器中
 * Popper 锚点测量失败后把浮层回退到左上角。
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
}: CoordinateMenuProps): ReactElement | null {
  const menuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!position) return
    const menu = menuRef.current
    if (!menu) return

    const rect = menu.getBoundingClientRect()
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight
    const margin = 8
    const maxX = Math.max(margin, viewportWidth - rect.width - margin)
    const maxY = Math.max(margin, viewportHeight - rect.height - margin)

    menu.style.left = `${Math.min(Math.max(position.x, margin), maxX)}px`
    menu.style.top = `${Math.min(Math.max(position.y, margin), maxY)}px`
  }, [position, children, className])

  useEffect(() => {
    if (!position) return

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && !menuRef.current?.contains(target)) onClose()
    }

    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [position, onClose])

  if (!position) return null

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={ariaLabel}
      className={cn(
        'fixed z-50 max-h-[calc(100vh-16px)] max-w-[calc(100vw-16px)] overflow-y-auto',
        'rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none',
        'w-auto text-xs',
        className,
      )}
      style={{ left: position.x, top: position.y }}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      {children}
    </div>,
    document.body,
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
