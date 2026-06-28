/**
 * MarkerContextMenu：标记右键菜单
 *
 * 菜单项：
 * - 跳转到此章
 * - ──
 * - 切换类型：书签 / 转折 / 伏笔 / 高潮 / 备注
 * - 编辑标题与备注…
 * - ──
 * - 删除标记
 */

import { type ReactElement } from 'react'
import {
  Trash2,
  Pencil,
  Bookmark,
  Zap,
  Sprout,
  Flame,
  StickyNote,
  ArrowRight,
} from 'lucide-react'
import type { TimelineMarker, MarkerType } from './timeline-markers'

export interface MarkerContextMenuPosition {
  x: number
  y: number
  marker: TimelineMarker
}

export interface MarkerContextMenuProps {
  position: MarkerContextMenuPosition | null
  onClose: () => void
  onJumpTo: (marker: TimelineMarker) => void
  onChangeType: (markerId: string, type: MarkerType) => void
  onEdit: (marker: TimelineMarker) => void
  onDelete: (markerId: string) => void
}

const TYPE_OPTIONS: Array<{ type: MarkerType; label: string; icon: typeof Bookmark }> = [
  { type: 'bookmark', label: '书签', icon: Bookmark },
  { type: 'turning-point', label: '转折', icon: Zap },
  { type: 'foreshadow', label: '伏笔', icon: Sprout },
  { type: 'climax', label: '高潮', icon: Flame },
  { type: 'note', label: '备注', icon: StickyNote },
]

export function MarkerContextMenu({
  position,
  onClose,
  onJumpTo,
  onChangeType,
  onEdit,
  onDelete,
}: MarkerContextMenuProps): ReactElement | null {
  if (!position) return null

  const { x, y, marker } = position

  const adjustedX = Math.min(x, window.innerWidth - 200)
  const adjustedY = Math.min(y, window.innerHeight - 280)

  return (
    <div
      className="novel-timeline-context-menu"
      style={{ left: adjustedX, top: adjustedY }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="novel-timeline-context-item"
        onClick={() => {
          onJumpTo(marker)
          onClose()
        }}
        title={`跳转到第 ${marker.chapter} 章`}
      >
        <ArrowRight className="size-3.5" />
        <span>跳转到第 {marker.chapter} 章</span>
      </button>

      <div className="novel-timeline-context-divider" />
      <div className="novel-timeline-context-label">切换类型</div>
      {TYPE_OPTIONS.map(({ type, label, icon: Icon }) => (
        <button
          key={type}
          type="button"
          className={`novel-timeline-context-item ${marker.type === type ? 'is-active' : ''}`}
          onClick={() => {
            onChangeType(marker.id, type)
            onClose()
          }}
          title={`设为${label}`}
        >
          <Icon className="size-3.5" />
          <span>{label}</span>
          {marker.type === type && <span className="ml-auto text-[10px] text-primary">●</span>}
        </button>
      ))}

      <div className="novel-timeline-context-divider" />
      <button
        type="button"
        className="novel-timeline-context-item"
        onClick={() => {
          onEdit(marker)
          onClose()
        }}
        title="编辑标题与备注"
      >
        <Pencil className="size-3.5" />
        <span>编辑…</span>
      </button>

      <div className="novel-timeline-context-divider" />
      <button
        type="button"
        className="novel-timeline-context-item is-danger"
        onClick={() => {
          onDelete(marker.id)
          onClose()
        }}
        title="删除标记"
      >
        <Trash2 className="size-3.5" />
        <span>删除标记</span>
      </button>
    </div>
  )
}
