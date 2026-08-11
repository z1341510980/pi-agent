/**
 * AnnotationPanelDialog：统一批注面板（T02-6 前端）
 *
 * 账本级批注（novel_annotations）：作者在事件/变化/实体/章节上留下意图、待办、疑问，
 * includeInPrompt 的批注会被 AI 上下文读取。本面板提供项目级批注的查看 / 新建 /
 * 解决 / 删除。
 *
 * 与矩阵 cell 的 marker（clip-note）不同：marker 是单元格展示物，本面板是统一
 * 账本批注（scope=entity/event/change/relation/matrix-cell/span）。
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { CheckCircle2, Circle, Inbox, LoaderCircle, Plus, Trash2 } from 'lucide-react'
import {
  createAnnotation,
  deleteAnnotation,
  listAnnotations,
  updateAnnotation,
  type CreateAnnotationInput,
  type NovelAnnotation,
  type NovelAnnotationKind,
  type NovelAnnotationScope,
} from '@/api/novel-client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toastError, toastSuccess } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'

const KIND_META: Record<NovelAnnotationKind, { label: string; className: string }> = {
  note: { label: '说明', className: 'bg-blue-500/10 text-blue-600 border-blue-500/30' },
  intent: { label: '意图', className: 'bg-violet-500/10 text-violet-600 border-violet-500/30' },
  todo: { label: '待办', className: 'bg-amber-500/10 text-amber-600 border-amber-500/30' },
  warning: { label: '警告', className: 'bg-red-500/10 text-red-600 border-red-500/30' },
  question: { label: '疑问', className: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30' },
}

const SCOPE_LABEL: Record<NovelAnnotationScope, string> = {
  entity: '实体',
  event: '事件',
  change: '变化',
  relation: '关系',
  'matrix-cell': '矩阵格',
  span: '章节区间',
}

function scopeText(a: NovelAnnotation): string {
  const base = SCOPE_LABEL[a.scopeType] ?? a.scopeType
  if (a.entityType) return `${base} · ${a.entityType}`
  if (a.scopeId) return `${base} · ${a.scopeId.slice(0, 8)}`
  if (a.chapterStart != null) {
    return a.chapterEnd != null ? `${base} · 第 ${a.chapterStart}-${a.chapterEnd} 章` : `${base} · 第 ${a.chapterStart} 章`
  }
  return base
}

interface AnnotationPanelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string | null
}

export function AnnotationPanelDialog({
  open,
  onOpenChange,
  projectId,
}: AnnotationPanelDialogProps): ReactElement {
  const [annotations, setAnnotations] = useState<NovelAnnotation[]>([])
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [showResolved, setShowResolved] = useState(false)
  // 新建表单
  const [draftKind, setDraftKind] = useState<NovelAnnotationKind>('note')
  const [draftContent, setDraftContent] = useState('')
  const [creating, setCreating] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    if (!projectId) return
    setLoading(true)
    try {
      setAnnotations(await listAnnotations(projectId))
    } catch {
      toastError('加载批注失败')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    if (open && projectId) void load()
    if (!open) {
      setAnnotations([])
      setDraftContent('')
      setBusyId(null)
    }
  }, [open, projectId, load])

  const handleCreate = useCallback(async (): Promise<void> => {
    if (!projectId || draftContent.trim() === '') return
    setCreating(true)
    try {
      const input: CreateAnnotationInput = {
        scopeType: 'matrix-cell',
        scopeId: null,
        entityType: null,
        entityId: null,
        chapterStart: null,
        chapterEnd: null,
        kind: draftKind,
        content: draftContent.trim(),
        color: 'blue',
        includeInPrompt: false,
        resolved: false,
      }
      await createAnnotation(projectId, input)
      toastSuccess('批注已添加')
      setDraftContent('')
      await load()
    } catch {
      toastError('添加批注失败')
    } finally {
      setCreating(false)
    }
  }, [projectId, draftContent, draftKind, load])

  const handleToggleResolved = useCallback(async (a: NovelAnnotation): Promise<void> => {
    if (!projectId) return
    setBusyId(a.id)
    try {
      await updateAnnotation(a.id, { resolved: !a.resolved })
      await load()
    } catch {
      toastError('更新批注失败')
    } finally {
      setBusyId(null)
    }
  }, [projectId, load])

  const handleDelete = useCallback(async (a: NovelAnnotation): Promise<void> => {
    if (!projectId) return
    setBusyId(a.id)
    try {
      await deleteAnnotation(a.id)
      toastSuccess('批注已删除')
      await load()
    } catch {
      toastError('删除批注失败')
    } finally {
      setBusyId(null)
    }
  }, [projectId, load])

  const visible = annotations.filter((a) => showResolved || !a.resolved)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[75vh] w-[600px] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Inbox className="size-4" />
            统一批注
          </DialogTitle>
          <DialogDescription>
            作者批注：说明、意图、待办、警告、疑问。勾选 includeInPrompt 的批注会进入 AI 上下文。
          </DialogDescription>
        </DialogHeader>

        {/* 新建表单 */}
        <div className="rounded-lg border border-border/60 bg-surface-2/50 p-2.5">
          <div className="flex items-center gap-1.5">
            <select
              value={draftKind}
              onChange={(e) => setDraftKind(e.target.value as NovelAnnotationKind)}
              className="h-7 rounded-md border border-border bg-surface-1 px-1.5 text-xs text-text outline-none"
            >
              {(Object.keys(KIND_META) as NovelAnnotationKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_META[k].label}
                </option>
              ))}
            </select>
            <input
              value={draftContent}
              onChange={(e) => setDraftContent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void handleCreate()
                }
              }}
              placeholder="写一条批注（Enter 提交）…"
              className="h-7 min-w-0 flex-1 rounded-md border border-border bg-surface-1 px-2 text-xs text-text outline-none placeholder:text-subtle focus:border-primary"
            />
            <Button
              size="sm"
              className="h-7 gap-1 px-2 text-[11px]"
              disabled={creating || draftContent.trim() === ''}
              onClick={() => void handleCreate()}
            >
              <Plus className="size-3" />
              添加
            </Button>
          </div>
        </div>

        <div className="min-h-[160px]">
          {loading ? (
            <div className="flex h-32 items-center justify-center text-subtle">
              <LoaderCircle className="size-4 animate-spin" />
              <span className="ml-2 text-xs">加载中…</span>
            </div>
          ) : visible.length === 0 ? (
            <div className="flex h-32 flex-col items-center justify-center gap-1 text-subtle">
              <Inbox className="size-6" />
              <p className="text-xs">{annotations.length === 0 ? '暂无批注' : '没有未解决的批注'}</p>
            </div>
          ) : (
            <ul className="space-y-1.5">
              {visible.map((a) => {
                const meta = KIND_META[a.kind] ?? KIND_META.note
                const busy = busyId === a.id
                return (
                  <li key={a.id} className="rounded-lg border border-border/60 bg-surface-2/40 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <Badge variant="outline" className={cn('shrink-0 text-[10px]', meta.className)}>
                          {meta.label}
                        </Badge>
                        <span className="truncate text-nano text-subtle">{scopeText(a)}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-1.5 text-[11px]"
                          disabled={busy}
                          title={a.resolved ? '标记为未解决' : '标记为已解决'}
                          onClick={() => void handleToggleResolved(a)}
                        >
                          {a.resolved ? (
                            <CheckCircle2 className="size-3.5 text-emerald-500" />
                          ) : (
                            <Circle className="size-3.5 text-subtle" />
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-1.5 text-destructive hover:text-destructive"
                          disabled={busy}
                          title="删除批注"
                          onClick={() => void handleDelete(a)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                    <p className={cn('mt-1 whitespace-pre-wrap text-xs leading-relaxed text-text', a.resolved && 'text-subtle line-through')}>
                      {a.content}
                    </p>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <DialogFooter className="border-t border-border/60 pt-2">
          <label className="mr-auto flex items-center gap-1.5 text-nano text-subtle">
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(e) => setShowResolved(e.target.checked)}
              className="size-3"
            />
            显示已解决（{annotations.filter((a) => a.resolved).length}）
          </label>
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
