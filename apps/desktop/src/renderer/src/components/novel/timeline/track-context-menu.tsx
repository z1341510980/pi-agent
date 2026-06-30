/**
 * TrackContextMenu：轨道头部右键菜单
 *
 * 菜单项：
 * - 上移/下移轨道
 * - 轨道高度（紧凑/标准/宽松）
 * - ──
 * - 锁定/解锁
 * - 显示/隐藏
 */

import { type ReactElement } from 'react'
import { ChevronUp, ChevronDown, Lock, Unlock, Eye, EyeOff, AlignJustify } from 'lucide-react'
import type { TimelineTrack } from './use-timeline-data'

export type TrackHeightLevel = 'compact' | 'standard' | 'spacious'

export interface TrackContextMenuPosition {
  x: number
  y: number
  track: TimelineTrack
}

export interface TrackContextMenuProps {
  position: TrackContextMenuPosition | null
  isLocked: boolean
  isHidden: boolean
  isCollapsed: boolean
  heightLevel: TrackHeightLevel
  canMoveUp: boolean
  canMoveDown: boolean
  onClose: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onSetHeight: (level: TrackHeightLevel) => void
  onToggleLock: () => void
  onToggleVisible: () => void
  onToggleCollapse: () => void
}

export function TrackContextMenu({
  position,
  isLocked,
  isHidden,
  isCollapsed,
  heightLevel,
  canMoveUp,
  canMoveDown,
  onClose,
  onMoveUp,
  onMoveDown,
  onSetHeight,
  onToggleLock,
  onToggleVisible,
  onToggleCollapse,
}: TrackContextMenuProps): ReactElement | null {
  if (!position) return null

  const { x, y } = position
  const adjustedX = Math.min(x, window.innerWidth - 220)
  const adjustedY = Math.min(y, window.innerHeight - 260)

  const handle = (fn: () => void): void => {
    fn()
    onClose()
  }

  return (
    <div
      className="novel-timeline-context-menu"
      style={{ left: adjustedX, top: adjustedY }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="novel-timeline-context-item"
        disabled={!canMoveUp}
        onClick={() => handle(onMoveUp)}
        title="上移轨道顺序"
      >
        <ChevronUp className="size-3.5" />
        <span>上移轨道</span>
      </button>
      <button
        type="button"
        className="novel-timeline-context-item"
        disabled={!canMoveDown}
        onClick={() => handle(onMoveDown)}
        title="下移轨道顺序"
      >
        <ChevronDown className="size-3.5" />
        <span>下移轨道</span>
      </button>
      <div className="novel-timeline-context-divider" />
      <div className="novel-timeline-context-label">
        <AlignJustify className="size-3.5" />
        <span>轨道高度</span>
      </div>
      {(['compact', 'standard', 'spacious'] as const).map((level) => (
        <button
          key={level}
          type="button"
          className={`novel-timeline-context-item ${heightLevel === level ? 'is-active' : ''}`}
          onClick={() => handle(() => onSetHeight(level))}
        >
          <span className="novel-timeline-context-check">
            {heightLevel === level ? '✓' : ''}
          </span>
          <span>{level === 'compact' ? '紧凑 (28px)' : level === 'standard' ? '标准 (36px)' : '宽松 (56px)'}</span>
        </button>
      ))}
      <div className="novel-timeline-context-divider" />
      <button
        type="button"
        className="novel-timeline-context-item"
        onClick={() => handle(onToggleLock)}
      >
        {isLocked ? <Unlock className="size-3.5" /> : <Lock className="size-3.5" />}
        <span>{isLocked ? '解锁轨道' : '锁定轨道'}</span>
      </button>
      <button
        type="button"
        className="novel-timeline-context-item"
        onClick={() => handle(onToggleVisible)}
      >
        {isHidden ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
        <span>{isHidden ? '显示轨道' : '隐藏轨道'}</span>
      </button>
      <button
        type="button"
        className="novel-timeline-context-item"
        onClick={() => handle(onToggleCollapse)}
      >
        {isCollapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
        <span>{isCollapsed ? '展开轨道' : '折叠轨道'}</span>
      </button>
    </div>
  )
}
