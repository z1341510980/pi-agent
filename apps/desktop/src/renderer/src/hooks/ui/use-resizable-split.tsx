import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { cn } from '@/lib/utils'

export interface UseResizableSplitOptions {
  defaultWidth?: number
  minWidth?: number
  maxWidth?: number
  storageKey?: string
  unit?: 'ratio' | 'px'
  onResize?: (ratio: number) => void
}

export function useResizableSplit(options: UseResizableSplitOptions) {
  const {
    defaultWidth = 50,
    minWidth = 0,
    maxWidth = Number.MAX_SAFE_INTEGER,
    storageKey,
    unit = 'ratio',
    onResize,
  } = options

  const [splitRatio, setSplitRatioState] = useState<number>(() => {
    if (storageKey) {
      const stored = localStorage.getItem(storageKey)
      if (stored !== null) {
        const n = Number(stored)
        if (!Number.isNaN(n)) return Math.max(minWidth, Math.min(maxWidth, n))
      }
    }
    return defaultWidth
  })

  const draggingRef = useRef(false)
  const dragHandleRef = useRef<HTMLDivElement>(null)
  const onResizeRef = useRef(onResize)
  onResizeRef.current = onResize

  const setSplitRatio = useCallback((next: number) => {
    const clamped = Math.max(minWidth, Math.min(maxWidth, next))
    setSplitRatioState(clamped)
    if (storageKey) localStorage.setItem(storageKey, String(clamped))
    onResizeRef.current?.(clamped)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('preview-panel-resize', { detail: { ratio: clamped } }))
    }
  }, [minWidth, maxWidth, storageKey])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const handleMove = (e: PointerEvent) => {
      if (!draggingRef.current) return
      const parent = (dragHandleRef.current?.parentElement) as HTMLElement | null
      if (!parent) return
      const rect = parent.getBoundingClientRect()
      if (unit === 'px') {
        const newWidth = rect.right - e.clientX
        setSplitRatio(newWidth)
      } else {
        const ratio = ((rect.right - e.clientX) / rect.width) * 100
        setSplitRatio(ratio)
      }
    }

    const handleUp = () => {
      if (draggingRef.current) {
        draggingRef.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)
    window.addEventListener('blur', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
      window.removeEventListener('blur', handleUp)
    }
  }, [setSplitRatio, unit])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    draggingRef.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    try {
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    } catch { /* ignore */ }
  }, [])

  const handleDoubleClick = useCallback(() => {
    setSplitRatio(defaultWidth)
  }, [defaultWidth, setSplitRatio])

  const dragHandle = (
    <div
      ref={dragHandleRef}
      data-slot="resize-handle"
      className={cn(
        'group relative flex w-1 cursor-col-resize items-center justify-center',
        'hover:bg-primary/30 transition-colors',
        draggingRef.current && 'bg-primary/50'
      )}
      onPointerDown={handlePointerDown}
      onDoubleClick={handleDoubleClick}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={splitRatio}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      tabIndex={0}
    >
      <div className="h-8 w-0.5 rounded-full bg-border group-hover:bg-primary" />
    </div>
  ) as unknown as ReactElement

  return {
    splitRatio,
    setSplitRatio,
    dragHandle,
    dragHandleRef,
  }
}
