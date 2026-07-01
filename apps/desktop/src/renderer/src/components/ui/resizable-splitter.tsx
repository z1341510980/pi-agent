import { useRef, useCallback, type ReactElement } from 'react'
import { cn } from '@/lib/utils'

// ── 类型定义 ──

interface ResizableSplitterProps {
  /** 分隔方向 */
  direction: 'horizontal' | 'vertical'
  /** 当前面板尺寸（px） */
  size: number
  /** 最小尺寸（px） */
  minSize?: number
  /** 最大尺寸（px） */
  maxSize?: number
  /** 尺寸变化回调 */
  onSizeChange: (size: number) => void
  /** 是否折叠（折叠时不显示拖拽条） */
  collapsed?: boolean
  /**
   * 被调整面板在分隔条的哪一侧
   * - horizontal: 'left' = 拖拽向右增大（左侧面板），'right' = 拖拽向左增大（右侧面板）
   * - vertical: 'top' = 拖拽向下增大，'bottom' = 拖拽向上增大
   */
  side?: 'left' | 'right' | 'top' | 'bottom'
  /** 额外类名 */
  className?: string
}

// ── 主组件 ──

/**
 * ResizableSplitter：可拖拽分隔条
 *
 * 拖拽时实时更新面板尺寸
 */
export function ResizableSplitter({
  direction,
  size,
  minSize = 200,
  maxSize = 600,
  onSizeChange,
  collapsed = false,
  side,
  className,
}: ResizableSplitterProps): ReactElement {
  const isDragging = useRef(false)
  const startPos = useRef(0)
  const startSize = useRef(0)

  // 推断默认 side：horizontal 默认 right，vertical 默认 bottom
  const effectiveSide = side ?? (direction === 'horizontal' ? 'right' : 'bottom')

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      isDragging.current = true
      startPos.current = direction === 'horizontal' ? e.clientX : e.clientY
      startSize.current = size

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!isDragging.current) return
        const currentPos = direction === 'horizontal' ? moveEvent.clientX : moveEvent.clientY
        // left/top 侧：拖拽正方向（右/下）增大；right/bottom 侧：拖拽反方向（左/上）增大
        const delta = (effectiveSide === 'left' || effectiveSide === 'top')
          ? currentPos - startPos.current
          : startPos.current - currentPos
        const newSize = Math.min(maxSize, Math.max(minSize, startSize.current + delta))
        onSizeChange(newSize)
      }

      const handleMouseUp = () => {
        isDragging.current = false
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize'
      document.body.style.userSelect = 'none'
    },
    [direction, size, minSize, maxSize, onSizeChange, effectiveSide],
  )

  if (collapsed) return <></>

  return (
    <div
      className={cn(
        'shrink-0 group relative z-10',
        direction === 'horizontal'
          ? 'w-[2px] cursor-col-resize hover:w-[3px] active:w-[3px] before:absolute before:inset-x-[-19px] before:inset-y-0 before:content-[""]'
          : 'h-[2px] cursor-row-resize hover:h-[3px] active:h-[3px] before:absolute before:inset-y-[-19px] before:inset-x-0 before:content-[""]',
        'transition-[width,height] duration-100',
        className,
      )}
      onMouseDown={handleMouseDown}
    >
      <div
        className={cn(
          'absolute inset-0',
          direction === 'horizontal'
            ? effectiveSide === 'left'
              ? '-right-[2px] w-[5px]'
              : '-left-[2px] w-[5px]'
            : effectiveSide === 'top'
              ? '-bottom-[2px] h-[5px]'
              : '-top-[2px] h-[5px]',
          'bg-transparent group-hover:bg-primary/30 group-active:bg-primary/50',
          'transition-colors duration-100',
        )}
      />
    </div>
  )
}
