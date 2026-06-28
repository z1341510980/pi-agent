/**
 * TimelineMinimap：小地图导航
 *
 * Canvas 渲染全部章节的片段分布
 * 视口框可拖拽平移、拖拽边缘缩放
 */

import { useCallback, useEffect, useRef, type ReactElement } from 'react'
import type { TimelineTrack } from './use-timeline-data'

const MINIMAP_HEIGHT = 32

export interface TimelineMinimapProps {
  tracks: TimelineTrack[]
  maxChapter: number
  chapterWidth: number
  /** 当前视口的起始章节 */
  viewportStartChapter: number
  /** 当前视口可见的章节数 */
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

  // 绘制小地图
  const draw = useCallback(() => {
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

    // 背景
    ctx.fillStyle = 'rgba(0, 0, 0, 0.03)'
    ctx.fillRect(0, 0, width, height)

    if (maxChapter === 0) return

    const chapterW = width / maxChapter

    // 片段色块
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
      const color = trackColorMap[track.kind] ?? 'rgba(100, 100, 100, 0.5)'
      ctx.fillStyle = color
      for (const clip of track.clips) {
        const x = (clip.startChapter - 1) * chapterW
        const w = Math.max(1, (clip.endChapter - clip.startChapter + 1) * chapterW)
        ctx.fillRect(x, y, w, Math.max(2, trackH - 1))
      }
    })

    // 视口框
    const vpX = (viewportStartChapter - 1) * chapterW
    const vpW = Math.max(8, viewportVisibleChapters * chapterW)
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.9)'
    ctx.lineWidth = 1.5
    ctx.strokeRect(vpX, 0, vpW, height)
    ctx.fillStyle = 'rgba(59, 130, 246, 0.1)'
    ctx.fillRect(vpX, 0, vpW, height)
  }, [tracks, maxChapter, viewportStartChapter, viewportVisibleChapters])

  useEffect(() => {
    draw()
  }, [draw])

  // 拖拽处理
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
      // 点击外部 → 跳转
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
      const mode = dragModeRef.current
      if (!start || !mode) return
      const deltaX = ev.clientX - start.x
      const deltaChapters = Math.round(deltaX / chapterW)

      if (mode === 'pan') {
        const newStart = Math.max(1, Math.min(maxChapter - start.visibleChapters + 1, start.startChapter + deltaChapters))
        onViewportChange?.(newStart)
      }
      // resize 模式暂不实现缩放（需要 onChapterWidthChange），仅平移
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
    <div className="tl-minimap" ref={containerRef}>
      <canvas ref={canvasRef} onMouseDown={handleMouseDown} />
    </div>
  )
}
