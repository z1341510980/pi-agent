/**
 * MarkerEditDialog：标记编辑对话框
 *
 * 编辑标记的标题和备注
 */

import { useEffect, useState, type ReactElement } from 'react'
import { X } from 'lucide-react'
import type { TimelineMarker } from './timeline-markers'

export interface MarkerEditDialogProps {
  marker: TimelineMarker | null
  onClose: () => void
  onSave: (markerId: string, title: string, note: string) => void
}

export function MarkerEditDialog({
  marker,
  onClose,
  onSave,
}: MarkerEditDialogProps): ReactElement | null {
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    if (marker) {
      setTitle(marker.title)
      setNote(marker.note ?? '')
    }
  }, [marker])

  if (!marker) return null

  const handleSave = (): void => {
    onSave(marker.id, title.trim() || `第 ${marker.chapter} 章标记`, note)
  }

  return (
    <div
      className="novel-timeline-dialog-overlay"
      onClick={onClose}
    >
      <div
        className="novel-timeline-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="novel-timeline-dialog-header">
          <span className="novel-timeline-dialog-title">编辑标记 · 第 {marker.chapter} 章</span>
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
            <span>标题</span>
            <input
              type="text"
              className="novel-timeline-dialog-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="标记标题"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave()
                if (e.key === 'Escape') onClose()
              }}
            />
          </label>
          <label className="novel-timeline-dialog-label">
            <span>备注</span>
            <textarea
              className="novel-timeline-dialog-textarea"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="可选备注信息"
              rows={3}
              onKeyDown={(e) => {
                if (e.key === 'Escape') onClose()
              }}
            />
          </label>
        </div>
        <div className="novel-timeline-dialog-footer">
          <button
            type="button"
            className="novel-timeline-dialog-btn"
            onClick={onClose}
          >
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
