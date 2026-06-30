/**
 * ClipContextMenu：片段右键菜单
 *
 * 菜单项：
 * - 在播放头切分（Ctrl+K）
 * - 复制（Ctrl+C）
 * - 剪切（Ctrl+X）
 * - 删除（Delete）
 * - ──
 * - 对齐到播放头
 * - 编辑详情
 */

import { type ReactElement } from 'react'
import { Scissors, Copy, ClipboardCut, Trash2, AlignCenterVertical, Pencil } from 'lucide-react'
import type { TimelineClip } from './use-timeline-data'

export interface ClipContextMenuPosition {
  x: number
  y: number
  clip: TimelineClip
}

export interface ClipContextMenuProps {
  position: ClipContextMenuPosition | null
  canPaste: boolean
  onClose: () => void
  onSplit: (clip: TimelineClip) => void
  onCopy: (clip: TimelineClip) => void
  onCut: (clip: TimelineClip) => void
  onDelete: (clip: TimelineClip) => void
  onRippleDelete: (clip: TimelineClip) => void
  onAlignToPlayhead: (clip: TimelineClip) => void
  onEditDetails: (clip: TimelineClip) => void
}

export function ClipContextMenu({
  position,
  canPaste,
  onClose,
  onSplit,
  onCopy,
  onCut,
  onDelete,
  onRippleDelete,
  onAlignToPlayhead,
  onEditDetails,
}: ClipContextMenuProps): ReactElement | null {
  if (!position) return null

  const { x, y, clip } = position

  const handleAction = (fn: (clip: TimelineClip) => void): void => {
    fn(clip)
    onClose()
  }

  // 确保菜单不溢出视口
  const adjustedX = Math.min(x, window.innerWidth - 220)
  const adjustedY = Math.min(y, window.innerHeight - 260)

  return (
    <div
      className="novel-timeline-context-menu"
      style={{ left: adjustedX, top: adjustedY }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="novel-timeline-context-item"
        onClick={() => handleAction(onSplit)}
        title="在播放头位置切分（Ctrl+K）"
      >
        <Scissors className="size-3.5" />
        <span>在播放头切分</span>
        <kbd>Ctrl+K</kbd>
      </button>
      <button
        type="button"
        className="novel-timeline-context-item"
        onClick={() => handleAction(onCopy)}
        title="复制（Ctrl+C）"
      >
        <Copy className="size-3.5" />
        <span>复制</span>
        <kbd>Ctrl+C</kbd>
      </button>
      <button
        type="button"
        className="novel-timeline-context-item"
        onClick={() => handleAction(onCut)}
        title="剪切（Ctrl+X）"
      >
        <ClipboardCut className="size-3.5" />
        <span>剪切</span>
        <kbd>Ctrl+X</kbd>
      </button>
      <div className="novel-timeline-context-divider" />
      <button
        type="button"
        className="novel-timeline-context-item is-danger"
        onClick={() => handleAction(onDelete)}
        title="删除（Delete）"
      >
        <Trash2 className="size-3.5" />
        <span>删除</span>
        <kbd>Del</kbd>
      </button>
      <button
        type="button"
        className="novel-timeline-context-item is-danger"
        onClick={() => handleAction(onRippleDelete)}
        title="删除并使后续片段前移（Shift+Del）"
      >
        <Trash2 className="size-3.5" />
        <span>涟漪删除</span>
        <kbd>⇧Del</kbd>
      </button>
      <div className="novel-timeline-context-divider" />
      <button
        type="button"
        className="novel-timeline-context-item"
        onClick={() => handleAction(onAlignToPlayhead)}
        title="把片段起始对齐到当前播放头位置"
      >
        <AlignCenterVertical className="size-3.5" />
        <span>对齐到播放头</span>
      </button>
      <button
        type="button"
        className="novel-timeline-context-item"
        onClick={() => handleAction(onEditDetails)}
        title="编辑片段详情"
      >
        <Pencil className="size-3.5" />
        <span>编辑详情…</span>
      </button>
      {canPaste && (
        <>
          <div className="novel-timeline-context-divider" />
          <div className="novel-timeline-context-hint">可在空白处右键粘贴</div>
        </>
      )}
    </div>
  )
}
