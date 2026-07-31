/**
 * EntitySpanDialog：通用实体跨度编辑对话框
 *
 * 触发：双击 conflict/faction 色带，或单元格右键菜单「编辑范围」
 * 适用：所有实体类型（character/conflict/foreshadow/faction/location）
 *
 * 各类型语义：
 * - character：在 [first, last] 范围每章创建/保留 characterHistory，移除范围外的记录
 * - conflict / faction：设 chapterSpans: [[first, last]]（单段覆盖，多段时仅保留此段）
 * - foreshadow：first → firstChapter（埋设点，事实）；last → recoverByChapter（计划回收章，意图）
 * - location：[first, last] 范围填满 appearChapters，移除范围外的章
 * - world_element：恒全程，不支持编辑
 *
 * 约束：
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

/** 按 entityType 返回起始/结束字段的语义化 label */
function fieldLabels(kind: MatrixEntity['kind']): { first: string; last: string; desc: string } {
  switch (kind) {
    case 'character':
      return { first: '出场起始章', last: '出场结束章', desc: '在范围内每章标记出场，范围外的出场记录将被清除' }
    case 'foreshadow':
      return {
        first: '埋设章节',
        last: '计划回收章',
        desc: '埋设章节是已发生的事实；计划回收章只表达意图，不会把伏笔标记为已回收',
      }
    case 'location':
      return { first: '出场起始章', last: '出场结束章', desc: '范围内每章加入 appearChapters，范围外的章会被移除' }
    case 'conflict':
    case 'faction':
      return { first: '起始章', last: '结束章', desc: '修改实体起止章节' }
    default:
      return { first: '起始章', last: '结束章', desc: '' }
  }
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
      setLast(String(entity.spanEnd ?? entity.spanStart ?? 1))
      setError(null)
      setSubmitting(false)
    }
  }, [open, entity])

  if (!entity) return null
  const meta = GROUP_META[entity.kind]
  const labels = fieldLabels(entity.kind)

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
            编辑范围
          </DialogTitle>
          <DialogDescription className="text-pretty">
            修改「{entity.name}」的起止章节。章节号范围 <span className="tabular-nums">1–{maxChapter}</span>。
          </DialogDescription>
        </DialogHeader>
        <div className="py-2 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="span-first">{labels.first}</Label>
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
              <Label htmlFor="span-last">{labels.last}</Label>
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
          {labels.desc && (
            <p className="text-micro text-muted-foreground leading-relaxed">{labels.desc}</p>
          )}
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
