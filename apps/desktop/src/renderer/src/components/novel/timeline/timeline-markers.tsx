/**
 * TimelineMarkers：时间轴标记层
 *
 * 位置：标尺和轨道之间，24px 高独立层
 * 支持 5 种标记类型：bookmark/turning-point/foreshadow/climax/note
 * 交互：点击跳转、双击编辑、拖拽移动、右键删除
 */

import { useCallback, useState, type ReactElement } from 'react'
import { Bookmark, Zap, Sprout, Flame, StickyNote, ArrowRightToLine, ArrowRightFromLine } from 'lucide-react'

export type MarkerType = 'bookmark' | 'turning-point' | 'foreshadow' | 'climax' | 'note' | 'in' | 'out'
export type MarkerColor = 'blue' | 'yellow' | 'green' | 'red' | 'purple'

export interface TimelineMarker {
  id: string
  chapter: number
  title: string
  note?: string
  color: MarkerColor
  type: MarkerType
}

const MARKER_CONFIG: Record<MarkerType, { color: MarkerColor; icon: typeof Bookmark; label: string }> = {
  'bookmark': { color: 'blue', icon: Bookmark, label: '书签' },
  'turning-point': { color: 'yellow', icon: Zap, label: '转折' },
  'foreshadow': { color: 'green', icon: Sprout, label: '伏笔' },
  'climax': { color: 'red', icon: Flame, label: '高潮' },
  'note': { color: 'purple', icon: StickyNote, label: '备注' },
  'in': { color: 'blue', icon: ArrowRightToLine, label: 'In 点' },
  'out': { color: 'red', icon: ArrowRightFromLine, label: 'Out 点' },
}

const COLOR_HEX: Record<MarkerColor, string> = {
  blue: '#3b82f6',
  yellow: '#f59e0b',
  green: '#10b981',
  red: '#ef4444',
  purple: '#a855f7',
}

export interface TimelineMarkersProps {
  markers: TimelineMarker[]
  chapterWidth: number
  maxChapter: number
  playheadChapter: number
  totalWidth?: number
  onMarkerClick?: (marker: TimelineMarker) => void
  onMarkerDoubleClick?: (marker: TimelineMarker) => void
  onMarkerMove?: (marker: TimelineMarker, newChapter: number) => void
  onMarkerContextMenu?: (marker: TimelineMarker, x: number, y: number) => void
  onEmptyClick?: (chapter: number) => void
}

export function TimelineMarkers({
  markers,
  chapterWidth,
  maxChapter,
  totalWidth,
  onMarkerClick,
  onMarkerDoubleClick,
  onMarkerMove,
  onMarkerContextMenu,
}: TimelineMarkersProps): ReactElement {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, marker: TimelineMarker) => {
      e.preventDefault()
      e.stopPropagation()
      setDraggingId(marker.id)
      const startX = e.clientX
      const origChapter = marker.chapter

      const handleMove = (ev: MouseEvent): void => {
        const deltaX = ev.clientX - startX
        const deltaChapters = Math.round(deltaX / chapterWidth)
        const newChapter = Math.max(1, Math.min(maxChapter, origChapter + deltaChapters))
        onMarkerMove?.(marker, newChapter)
      }

      const handleUp = (): void => {
        setDraggingId(null)
        window.removeEventListener('mousemove', handleMove)
        window.removeEventListener('mouseup', handleUp)
      }

      window.addEventListener('mousemove', handleMove)
      window.addEventListener('mouseup', handleUp)
    },
    [chapterWidth, maxChapter, onMarkerMove],
  )

  return (
    <div
      className="tl-markers-layer"
      style={{ height: 24, width: totalWidth ?? '100%', minWidth: '100%' }}
    >
      {markers.length === 0 && (
        <div className="tl-markers-empty">
          双击上方标尺可在此章创建标记
        </div>
      )}
      {markers.map((marker) => {
        const config = MARKER_CONFIG[marker.type]
        const Icon = config.icon
        const color = COLOR_HEX[marker.color]
        const left = (marker.chapter - 1) * chapterWidth + chapterWidth / 2
        const isDragging = draggingId === marker.id
        const isHovered = hoveredId === marker.id
        const isInOut = marker.type === 'in' || marker.type === 'out'
        return (
          <div
            key={marker.id}
            className={`tl-marker ${isInOut ? 'tl-marker-inout' : ''} ${isDragging ? 'is-dragging' : ''} ${isHovered ? 'is-hovered' : ''}`}
            style={isInOut ? { left, color, height: '100%' } : { left, color }}
            onMouseDown={(e) => handleMouseDown(e, marker)}
            onClick={(e) => {
              e.stopPropagation()
              onMarkerClick?.(marker)
            }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              onMarkerDoubleClick?.(marker)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onMarkerContextMenu?.(marker, e.clientX, e.clientY)
            }}
            onMouseEnter={() => setHoveredId(marker.id)}
            onMouseLeave={() => setHoveredId(null)}
            title={`${config.label}：${marker.title}${marker.note ? `\n${marker.note}` : ''}`}
          >
            {isInOut ? (
              <div className="tl-marker-inout-line" style={{ background: color }} />
            ) : (
              <Icon size={12} className="tl-marker-icon" style={{ fill: color, color }} />
            )}
            {isHovered && (
              <div className="tl-marker-tooltip" style={{ borderColor: color }}>
                <span className="tl-marker-tooltip-type">{config.label}</span>
                <span className="tl-marker-tooltip-title">{marker.title}</span>
                <span className="tl-marker-tooltip-chapter">第 {marker.chapter} 章</span>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export { MARKER_CONFIG, COLOR_HEX }
