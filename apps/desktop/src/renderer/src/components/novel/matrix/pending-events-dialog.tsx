/**
 * PendingEventsDialog：AI 提取确认队列（T02-6 前端）
 *
 * 展示 AI 自动写入的待确认 StoryEvent（source=ai-extracted/ai-planned，status=planned），
 * 支持确认（→confirmed）与驳回（事件→superseded，其 change record→rejected 并从消费排除）。
 *
 * 后端：GET /ledger/pending-queue + POST /ledger/events/:id/confirm + /reject
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { CheckCircle2, Inbox, LoaderCircle, XCircle } from 'lucide-react'
import {
  confirmStoryEvent,
  listPendingEvents,
  rejectStoryEvent,
  type PendingEventItem,
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
import { formatChangeValue, resolveDimensionLabel, translateEnumValue } from './matrix-model'

const EVENT_TYPE_LABEL: Record<string, string> = {
  encounter: '相遇',
  conflict: '冲突',
  discovery: '发现',
  transfer: '转移',
  reveal: '揭示',
  decision: '决策',
  transition: '过渡',
  resolution: '收束',
  custom: '自定义',
}

interface PendingEventsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string | null
  /** 事件数变化回调（工具栏角标刷新用） */
  onPendingCountChange?: (count: number) => void
}

export function PendingEventsDialog({
  open,
  onOpenChange,
  projectId,
  onPendingCountChange,
}: PendingEventsDialogProps): ReactElement {
  const [items, setItems] = useState<PendingEventItem[]>([])
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (!projectId) return
    setLoading(true)
    try {
      const res = await listPendingEvents(projectId)
      setItems(res.items)
      onPendingCountChange?.(res.items.length)
    } catch {
      toastError('加载待确认事件失败')
    } finally {
      setLoading(false)
    }
  }, [projectId, onPendingCountChange])

  useEffect(() => {
    if (open && projectId) void load()
    // 打开时刷新；关闭时清空本地状态
    if (!open) {
      setItems([])
      setBusyId(null)
    }
  }, [open, projectId, load])

  const handleConfirm = useCallback(async (item: PendingEventItem): Promise<void> => {
    if (!projectId) return
    setBusyId(item.event.id)
    try {
      await confirmStoryEvent(projectId, item.event.id)
      toastSuccess('事件已确认')
      await load()
    } catch {
      toastError('确认失败')
    } finally {
      setBusyId(null)
    }
  }, [projectId, load])

  const handleReject = useCallback(async (item: PendingEventItem): Promise<void> => {
    if (!projectId) return
    setBusyId(item.event.id)
    try {
      await rejectStoryEvent(projectId, item.event.id)
      toastSuccess('事件已驳回')
      await load()
    } catch {
      toastError('驳回失败')
    } finally {
      setBusyId(null)
    }
  }, [projectId, load])

  // 变化预览：dimension + before→after 紧凑展示（值经 formatChangeValue 处理对象/数组/UUID，避免 [object Object]）
  const changePreview = (item: PendingEventItem): string => {
    const changes = item.changes
    if (changes.length === 0) return '无关联变化'
    const parts = changes.slice(0, 3).map((c) => {
      const dim = resolveDimensionLabel(c.dimension)
      const from = translateEnumValue(formatChangeValue(c.beforeValue)) || '—'
      const to = translateEnumValue(formatChangeValue(c.afterValue)) || '—'
      return `${dim}: ${from} → ${to}`
    })
    return parts.join('；') + (changes.length > 3 ? ` 等 ${changes.length} 项` : '')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[70vh] w-[560px] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Inbox className="size-4" />
            AI 提取确认队列
          </DialogTitle>
          <DialogDescription>
            AI 自动提取的故事事件等待确认。确认后进入语义账本；驳回后从上下文消费中排除。
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-[180px]">
          {loading ? (
            <div className="flex h-32 items-center justify-center text-subtle">
              <LoaderCircle className="size-4 animate-spin" />
              <span className="ml-2 text-xs">加载中…</span>
            </div>
          ) : items.length === 0 ? (
            <div className="flex h-32 flex-col items-center justify-center gap-1 text-subtle">
              <Inbox className="size-6" />
              <p className="text-xs">没有待确认的事件</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {items.map((item) => {
                const busy = busyId === item.event.id
                return (
                  <li key={item.event.id} className="rounded-lg border border-border/60 bg-surface-2/50 p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-xs font-medium text-text">
                            {item.event.title || '(无标题)'}
                          </span>
                          <Badge variant="outline" className="shrink-0 text-[10px]">
                            {EVENT_TYPE_LABEL[item.event.type] ?? item.event.type}
                          </Badge>
                          {item.event.source === 'ai-planned' && (
                            <Badge variant="outline" className="shrink-0 text-[10px]">
                              AI 规划
                            </Badge>
                          )}
                        </div>
                        <p className="mt-0.5 truncate text-nano text-subtle">
                          第 {item.event.chapterNumber} 章 · {changePreview(item)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          size="sm"
                          variant="default"
                          className="h-6 gap-1 px-2 text-[11px]"
                          disabled={busy}
                          onClick={() => void handleConfirm(item)}
                        >
                          <CheckCircle2 className="size-3" />
                          确认
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 gap-1 px-2 text-[11px] text-destructive hover:text-destructive"
                          disabled={busy}
                          onClick={() => void handleReject(item)}
                        >
                          <XCircle className="size-3" />
                          驳回
                        </Button>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <DialogFooter className="border-t border-border/60 pt-2">
          <span className={cn('mr-auto text-nano text-subtle')}>
            {items.length > 0 ? `共 ${items.length} 条待确认` : '队列已清空'}
          </span>
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
