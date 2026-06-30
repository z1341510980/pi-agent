/**
 * EntitySpanDialog：冲突/势力跨度编辑对话框
 *
 * 触发：双击冲突或势力的色带
 * 操作：修改 firstChapter / lastChapter
 *
 * 约束：
 * - 仅 conflict / faction 支持（其他类型不弹此对话框）
 * - 起始 ≤ 结束
 * - 章节号范围 1..maxChapter
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { GROUP_META, type MatrixEntity } from './matrix-logic'

export interface EntitySpanDialogProps {
  open: boolean
  entity: MatrixEntity | null
  maxChapter: number
  onClose: () => void
  onSubmit: (entity: MatrixEntity, firstChapter: number, lastChapter: number) => Promise<void>
}

export function EntitySpanDialog({
  open, entity, maxChapter, onClose, onSubmit,
}: EntitySpanDialogProps): ReactElement | null {
  const [first, setFirst] = useState<string>('')
  const [last, setLast] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open && entity) {
      setFirst(String(entity.spanStart ?? 1))
      setLast(String(entity.spanEnd ?? 1))
      setError(null)
      setSubmitting(false)
    }
  }, [open, entity])

  if (!entity) return null
  const meta = GROUP_META[entity.kind]

  const handleSubmit = async (): Promise<void> => {
    const firstN = Number(first)
    const lastN = Number(last)
    if (!Number.isFinite(firstN) || firstN < 1) {
      setError('起始章节需为 ≥ 1 的数字')
      return
    }
    if (!Number.isFinite(lastN) || lastN < 1) {
      setError('结束章节需为 ≥ 1 的数字')
      return
    }
    if (firstN > lastN) {
      setError('起始章节不能晚于结束章节')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit(entity, firstN, lastN)
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
            编辑跨度
          </DialogTitle>
          <DialogDescription>
            修改「{entity.name}」的起止章节。章节号范围 1–{maxChapter}。
          </DialogDescription>
        </DialogHeader>
        <div className="py-2 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="span-first">起始章</Label>
              <Input
                id="span-first"
                type="number"
                min={1}
                max={maxChapter}
                value={first}
                onChange={(e) => setFirst(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="span-last">结束章</Label>
              <Input
                id="span-last"
                type="number"
                min={1}
                max={maxChapter}
                value={last}
                onChange={(e) => setLast(e.target.value)}
                disabled={submitting}
              />
            </div>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
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
