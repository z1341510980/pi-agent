import { useResizableSplit } from '@/hooks/ui/use-resizable-split'
import { cn } from '@/lib/utils'

interface ResizableSplitterProps {
  direction: 'horizontal' | 'vertical'
  size: number
  minSize?: number
  maxSize?: number
  onSizeChange: (size: number) => void
  collapsed?: boolean
  side?: 'left' | 'right' | 'top' | 'bottom'
  className?: string
  storageKey?: string
  unit?: 'ratio' | 'px'
}

export function ResizableSplitter(props: ResizableSplitterProps) {
  const {
    direction,
    size,
    minSize = 200,
    maxSize = 600,
    onSizeChange,
    collapsed = false,
    side = 'right',
    className,
    storageKey,
    unit = 'px',
  } = props

  const split = useResizableSplit({
    defaultWidth: size,
    minWidth: minSize,
    maxWidth: maxSize,
    storageKey,
    unit,
    onResize: onSizeChange,
  })

  return (
    <div
      className={cn(
        'group relative flex items-center justify-center',
        direction === 'horizontal' ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize',
        collapsed && 'pointer-events-none opacity-0',
        className,
      )}
      aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
      data-slot="resizable-splitter"
      data-collapsed={collapsed}
      data-side={side}
    >
      {split.dragHandle}
    </div>
  )
}
