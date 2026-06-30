/**
 * EntityNoteDialog：实体批注编辑对话框
 *
 * 触发：右键单元格 → 「修改批注」
 * 操作：写入或更新 type='clip-note' 的 marker
 *
 * 数据模型：
 * - marker.type = 'clip-note'
 * - marker.entityType / marker.entityId 绑定到对应实体
 * - marker.chapter = 弹窗触发的章节号（仅用于排序与定位）
 * - marker.note = 批注内容
 * - marker.title = 实体名（便于后端检索）
 *
 * 若该实体已有 clip-note marker，则更新；否则新建。
 */

import { useEffect, useState, type ReactElement } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { GROUP_META, type MatrixEntityKind } from './matrix-logic'

export interface EntityNoteDialogProps {
  open: boolean
  entityId: string | null
  entityName: string | null
  entityType: MatrixEntityKind | null
  chapter: number | null
  /** 该实体已有的批注（用于回填） */
  initialNote: string
  /** 已有 clip-note marker 的 ID（有则 update，无则 create） */
  existingMarkerId: string | null
  onClose: () => void
  onSubmit: (note: string) => Promise<void>
}

export function EntityNoteDialog({
  open, entityId, entityName, entityType, chapter,
  initialNote, existingMarkerId, onClose, onSubmit,
}: EntityNoteDialogProps): ReactElement | null {
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setNote(initialNote)
      setError(null)
      setSubmitting(false)
    }
  }, [open, initialNote])

  if (!entityId || !entityType) return null
  const meta = GROUP_META[entityType]

  const handleSubmit = async (): Promise<void> => {
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit(note)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            <span className="mr-1.5" style={{ color: meta.color }}>{meta.icon}</span>
            修改批注
          </DialogTitle>
          <DialogDescription>
            为「{entityName ?? ''}」
            {chapter != null ? `在第 ${chapter} 章` : ''}
            {existingMarkerId ? '更新批注' : '添加批注'}。
            批注显示在实体行右侧（· 标记），hover 查看内容。
          </DialogDescription>
        </DialogHeader>
        <div className="py-2 space-y-3">
          <textarea
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例如：此处伏笔与第 12 章的玉佩呼应"
            className="w-full min-h-[88px] rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            disabled={submitting}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void handleSubmit()
              }
            }}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <p className="text-[10px] text-muted-foreground">
            ⌘/Ctrl + Enter 保存
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>取消</Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting}>
            {submitting ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
