/**
 * ClipNoteDialog：片段批注编辑对话框
 *
 * 双击片段时弹出，编辑该片段的批注文本。
 * 批注以 type='clip-note' 的 marker 持久化，关联 entityId。
 */
import { useEffect, useState, type ReactElement } from 'react'
import { X, Trash2 } from 'lucide-react'
import type { TimelineClip } from './use-timeline-data'

export interface ClipNoteDialogProps {
  clip: TimelineClip | null
  /** 当前批注文本（来自 marker.note） */
  initialNote: string
  onClose: () => void
  onSave: (note: string) => void
  onDelete: () => void
}

export function ClipNoteDialog({
  clip,
  initialNote,
  onClose,
  onSave,
  onDelete,
}: ClipNoteDialogProps): ReactElement | null {
  const [note, setNote] = useState('')

  useEffect(() => {
    setNote(initialNote)
  }, [initialNote, clip])

  if (!clip) return null

  const handleSave = (): void => {
    onSave(note.trim())
  }

  return (
    <div className="novel-timeline-dialog-overlay" onClick={onClose}>
      <div className="novel-timeline-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="novel-timeline-dialog-header">
          <span className="novel-timeline-dialog-title">片段批注 · {clip.label}</span>
          <button
            type="button"
            className="novel-timeline-dialog-close"
            onClick={onClose}
            title="关闭"
          >
            <X className="size-3.5" />
          </button>
        </div>
        <div className="novel-timeline-dialog-body">
          <label className="novel-timeline-dialog-label">
            <span>批注内容</span>
            <textarea
              className="novel-timeline-dialog-textarea"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="为此片段添加批注（双击片段可再次编辑）"
              rows={5}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Escape') onClose()
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSave()
              }}
            />
          </label>
        </div>
        <div className="novel-timeline-dialog-footer">
          {initialNote && (
            <button
              type="button"
              className="novel-timeline-dialog-btn is-danger"
              onClick={onDelete}
              title="删除批注"
            >
              <Trash2 className="size-3.5" />
              <span>删除</span>
            </button>
          )}
          <button type="button" className="novel-timeline-dialog-btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="novel-timeline-dialog-btn is-primary"
            onClick={handleSave}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
