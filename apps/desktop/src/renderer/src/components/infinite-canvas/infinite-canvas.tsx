import { useEffect, useRef, useState } from 'react'
import type {
  DragEvent as ReactDragEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent
} from 'react'
import type { ReactNode } from 'react'

import type { ViewportTransform } from '@/api/infinite-canvas-client'
import type { CanvasBackgroundMode, CanvasTheme } from './canvas-theme'
import type { CanvasTool } from './types'

const MIN_SCALE = 0.05
const MAX_SCALE = 5
const PAN_MOVE_THRESHOLD = 3

interface CanvasGridProps {
  viewport: ViewportTransform
  mode: CanvasBackgroundMode
  theme: CanvasTheme
}

/** 纯 CSS 网格背景：dots / lines / blank 三种模式，随视口平移缩放取模。 */
function CanvasGrid({ viewport, mode, theme }: CanvasGridProps): React.ReactElement | null {
  if (mode === 'blank') return null
  const gridSize = 48 * viewport.k
  const x = viewport.x % gridSize
  const y = viewport.y % gridSize
  const dotSize = viewport.k < 0.12 ? 0.8 : 1.15
  const backgroundImage =
    mode === 'dots'
      ? `radial-gradient(circle, ${theme.canvas.dot} ${dotSize}px, transparent ${dotSize + 0.2}px)`
      : `linear-gradient(${theme.canvas.line} 1px, transparent 1px), linear-gradient(90deg, ${theme.canvas.line} 1px, transparent 1px)`
  return (
    <div
      className="pointer-events-none absolute inset-0 opacity-40"
      style={{
        backgroundImage,
        backgroundSize: `${gridSize}px ${gridSize}px`,
        backgroundPosition: `${x}px ${y}px`
      }}
    />
  )
}

export interface InfiniteCanvasProps {
  containerRef: React.RefObject<HTMLDivElement | null>
  viewport: ViewportTransform
  tool: CanvasTool
  theme: CanvasTheme
  backgroundMode?: CanvasBackgroundMode
  cursor?: string
  onViewportChange: (viewport: ViewportTransform) => void
  onCanvasMouseDown?: (event: ReactPointerEvent<HTMLDivElement>) => void
  onCanvasDeselect?: () => void
  onCanvasDoubleClick?: (event: React.MouseEvent) => void
  onContextMenu?: (event: React.MouseEvent) => void
  onDropFiles?: (event: ReactDragEvent<HTMLDivElement>) => void
  /**
   * 空格/Ctrl 临时反转工具的按键监听是否生效。
   * keep-alive 下隐藏挂载时必须关闭：Space 分支带全局 preventDefault，
   * 会吞掉其他页面上聚焦按钮的空格激活。
   */
  hotkeysEnabled?: boolean
  children: ReactNode
}

/** 画布根：背景网格 + transform 世界层 + 滚轮缩放 + 平移（中键 / pan 工具 / 空格、Ctrl 反转）。 */
export function InfiniteCanvas({
  containerRef,
  viewport,
  tool,
  theme,
  backgroundMode = 'lines',
  onViewportChange,
  onCanvasMouseDown,
  onCanvasDeselect,
  onCanvasDoubleClick,
  onContextMenu,
  onDropFiles,
  hotkeysEnabled = true,
  children
}: InfiniteCanvasProps): React.ReactElement {
  const [isSpacePressed, setIsSpacePressed] = useState(false)
  const [isControlPressed, setIsControlPressed] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const panStateRef = useRef<{
    isPanning: boolean
    startX: number
    startY: number
    initialX: number
    initialY: number
    hasMoved: boolean
    startedOnBackground: boolean
  }>({
    isPanning: false,
    startX: 0,
    startY: 0,
    initialX: 0,
    initialY: 0,
    hasMoved: false,
    startedOnBackground: false
  })
  const rafRef = useRef<number | null>(null)
  const nextViewportRef = useRef<ViewportTransform | null>(null)
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport
  const onViewportChangeRef = useRef(onViewportChange)
  onViewportChangeRef.current = onViewportChange
  const onCanvasDeselectRef = useRef(onCanvasDeselect)
  onCanvasDeselectRef.current = onCanvasDeselect

  // ref 保持最新值：监听器只绑定一次，不因 prop 变化重挂
  const hotkeysEnabledRef = useRef(hotkeysEnabled)
  hotkeysEnabledRef.current = hotkeysEnabled

  // ── 空格 / Ctrl 临时反转当前工具 ──
  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean =>
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof Element && Boolean(target.closest("[contenteditable='true']")))

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!hotkeysEnabledRef.current) return
      if (event.code === 'Space' && !isEditableTarget(event.target)) {
        event.preventDefault()
        setIsSpacePressed(true)
      }
      if (event.key === 'Control') setIsControlPressed(true)
    }
    const handleKeyUp = (event: KeyboardEvent): void => {
      if (!hotkeysEnabledRef.current) return
      if (event.code === 'Space') setIsSpacePressed(false)
      if (event.key === 'Control') setIsControlPressed(false)
    }
    const reset = (): void => {
      setIsSpacePressed(false)
      setIsControlPressed(false)
      endPan()
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', reset)
    }
  }, [])

  const temporaryTool = isControlPressed || isSpacePressed
  const activeTool: CanvasTool = temporaryTool ? (tool === 'select' ? 'pan' : 'select') : tool

  const flushPanFrame = (): void => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    const next = nextViewportRef.current
    if (next) {
      nextViewportRef.current = null
      onViewportChangeRef.current(next)
    }
  }

  const endPan = (): void => {
    panStateRef.current.isPanning = false
    setIsPanning(false)
    document.body.style.cursor = ''
    flushPanFrame()
  }

  // ── 平移 pointer 处理 ──
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    if (target.closest('[data-canvas-no-zoom],[data-connection-create-menu]')) return
    const isBackgroundClick = !target.closest('[data-node-id],[data-connection-id]')
    const shouldPan =
      event.button === 1 || (event.button === 0 && activeTool === 'pan' && isBackgroundClick)

    if (!shouldPan) {
      if (event.button === 0 && isBackgroundClick) onCanvasMouseDown?.(event)
      return
    }

    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    panStateRef.current = {
      isPanning: true,
      startX: event.clientX,
      startY: event.clientY,
      initialX: viewportRef.current.x,
      initialY: viewportRef.current.y,
      hasMoved: false,
      startedOnBackground: isBackgroundClick
    }
    setIsPanning(true)
    document.body.style.cursor = 'grabbing'
  }

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent): void => {
      const state = panStateRef.current
      if (!state.isPanning) return
      const dx = event.clientX - state.startX
      const dy = event.clientY - state.startY
      if (Math.abs(dx) > PAN_MOVE_THRESHOLD || Math.abs(dy) > PAN_MOVE_THRESHOLD)
        state.hasMoved = true
      nextViewportRef.current = {
        x: state.initialX + dx,
        y: state.initialY + dy,
        k: viewportRef.current.k
      }
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(flushPanFrame)
      }
    }
    const handlePointerUp = (event: PointerEvent): void => {
      const state = panStateRef.current
      if (!state.isPanning) return
      endPan()
      if (!state.hasMoved && state.startedOnBackground && event.button === 0)
        onCanvasDeselectRef.current?.()
    }
    const handleCancel = (): void => endPan()

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handleCancel)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handleCancel)
    }
  }, [])

  // ── 滚轮缩放：以鼠标位置为锚点，范围 5%–500% ──
  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    if (
      target.closest(
        '[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,[data-radix-popper-content-wrapper]'
      )
    )
      return
    const rect = event.currentTarget.getBoundingClientRect()
    const mouseX = event.clientX - rect.left
    const mouseY = event.clientY - rect.top
    const current = viewportRef.current
    const delta = -event.deltaY
    const factor = Math.pow(1.1, delta / 100)
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.k * factor))
    const worldX = (mouseX - current.x) / current.k
    const worldY = (mouseY - current.y) / current.k
    onViewportChange({ x: mouseX - worldX * newScale, y: mouseY - worldY * newScale, k: newScale })
  }

  const cursor = isPanning ? 'grabbing' : activeTool === 'pan' ? 'grab' : undefined

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full select-none overflow-hidden"
      style={{ background: theme.canvas.background, color: theme.node.text, cursor }}
      onPointerDown={handlePointerDown}
      onDoubleClick={(event) => {
        const target = event.target as HTMLElement
        if (!target.closest('[data-node-id],[data-canvas-no-zoom],[data-connection-create-menu]'))
          onCanvasDoubleClick?.(event)
      }}
      onWheel={handleWheel}
      onContextMenu={onContextMenu}
      onDragOver={(event) => {
        if (onDropFiles) event.preventDefault()
      }}
      onDrop={onDropFiles}
    >
      <CanvasGrid viewport={viewport} mode={backgroundMode} theme={theme} />
      <div
        className="absolute origin-top-left"
        style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})` }}
      >
        {children}
      </div>
    </div>
  )
}
