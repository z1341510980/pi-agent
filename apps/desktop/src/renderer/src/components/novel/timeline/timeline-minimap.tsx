/**
 * TimelineMinimap：小地图导航
 *
 * Canvas 仅绘制片段色块（tracks/maxChapter 变化时 rAF 节流重绘）。
 * 视口框为独立绝对定位 DOM 元素，滚动时只更新 left/width。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { TimelineTrack } from './use-timeline-data'
import { computeMinimapViewportFrame } from './timeline-logic'

const MINIMAP_HEIGHT = 32

export interface TimelineMinimapProps {
  tracks: TimelineTrack[]
  maxChapter: number
  chapterWidth: number
  viewportStartChapter: number
  viewportVisibleChapters: number
  onViewportChange?: (startChapter: number) => void
  onChapterWidthChange?: (width: number) => void
}

type DragMode = 'pan' | 'resize-left' | 'resize-right' | null

export function TimelineMinimap({
  tracks,
  maxChapter,
  viewportStartChapter,
  viewportVisibleChapters,
  onViewportChange,
}: TimelineMinimapProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const dragModeRef = useRef<DragMode>(null)
  const dragStartRef = useRef<{ x: number; startChapter: number; visibleChapters: number } | null>(null)
  const rafRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(null)
  const [containerWidth, setContainerWidth] = useState(0)

  // 仅绘制片段色块（不含视口框）
  const drawClips = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      const canvas = canvasRef.current
      const container = containerRef.current
      if (!canvas || !container) return
      const dpr = window.devicePixelRatio || 1
      const width = container.clientWidth
      const height = MINIMAP_HEIGHT
      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.scale(dpr, dpr)
      ctx.fillStyle = 'rgba(0, 0, 0, 0.03)'
      ctx.fillRect(0, 0, width, height)
      if (maxChapter === 0) return
      const chapterW = width / maxChapter
      const trackColorMap: Record<string, string> = {
        character: 'rgba(59, 130, 246, 0.6)',
        conflict: 'rgba(239, 68, 68, 0.6)',
        foreshadow: 'rgba(245, 158, 11, 0.6)',
        faction: 'rgba(168, 85, 247, 0.6)',
        location: 'rgba(6, 182, 212, 0.6)',
        world_element: 'rgba(99, 102, 241, 0.6)',
      }
      const trackH = Math.max(2, Math.floor(height / Math.max(tracks.length, 1)))
      tracks.forEach((track, idx) => {
        const y = idx * trackH
        ctx.fillStyle = trackColorMap[track.kind] ?? 'rgba(100, 100, 100, 0.5)'
        for (const clip of track.clips) {
          const x = (clip.startChapter - 1) * chapterW
          const w = Math.max(1, (clip.endChapter - clip.startChapter + 1) * chapterW)
          ctx.fillRect(x, y, w, Math.max(2, trackH - 1))
        }
      })
    })
  }, [tracks, maxChapter])

  // canvas 仅在 tracks/maxChapter 变化时重绘
  useEffect(() => {
    drawClips()
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [drawClips])

  // 监听容器宽度变化（ResizeObserver 简化版：滚动/挂载时同步）
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    setContainerWidth(container.clientWidth)
  }, [tracks, maxChapter])

  const frame = computeMinimapViewportFrame(viewportStartChapter, viewportVisibleChapters, maxChapter, containerWidth || 1)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const x = e.clientX - rect.left
    const chapterW = rect.width / maxChapter
    const vpX = (viewportStartChapter - 1) * chapterW
    const vpW = Math.max(8, viewportVisibleChapters * chapterW)
    const edgeThreshold = 6

    let mode: DragMode = 'pan'
    if (Math.abs(x - vpX) < edgeThreshold) mode = 'resize-left'
    else if (Math.abs(x - (vpX + vpW)) < edgeThreshold) mode = 'resize-right'
    else if (x < vpX || x > vpX + vpW) {
      const centerChapter = Math.max(1, Math.min(maxChapter, Math.floor(x / chapterW) + 1))
      const newStart = Math.max(1, Math.min(maxChapter - viewportVisibleChapters + 1, centerChapter - Math.floor(viewportVisibleChapters / 2)))
      onViewportChange?.(newStart)
      dragModeRef.current = 'pan'
    } else {
      mode = 'pan'
    }
    dragModeRef.current = mode
    dragStartRef.current = { x: e.clientX, startChapter: viewportStartChapter, visibleChapters: viewportVisibleChapters }

    const handleMove = (ev: MouseEvent): void => {
      const start = dragStartRef.current
      const m = dragModeRef.current
      if (!start || !m) return
      const deltaX = ev.clientX - start.x
      const deltaChapters = Math.round(deltaX / chapterW)
      if (m === 'pan') {
        const newStart = Math.max(1, Math.min(maxChapter - start.visibleChapters + 1, start.startChapter + deltaChapters))
        onViewportChange?.(newStart)
      }
    }
    const handleUp = (): void => {
      dragModeRef.current = null
      dragStartRef.current = null
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
  }, [maxChapter, viewportStartChapter, viewportVisibleChapters, onViewportChange])

  return (
    <div className="tl-minimap" ref={containerRef} style={{ position: 'relative' }}>
      <canvas ref={canvasRef} onMouseDown={handleMouseDown} style={{ display: 'block' }} />
      {/* 视口框：独立 DOM 元素，滚动时只更新 left/width */}
      <div
        className="tl-minimap-viewport"
        style={{
          position: 'absolute',
          left: frame.left,
          top: 0,
          width: frame.width,
          height: MINIMAP_HEIGHT,
          border: '1.5px solid rgba(59, 130, 246, 0.9)',
          background: 'rgba(59, 130, 246, 0.1)',
          pointerEvents: 'none',
        }}
      />
    </div>
  )
}
