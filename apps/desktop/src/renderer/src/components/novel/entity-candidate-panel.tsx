import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { CheckCircle2, Inbox, LoaderCircle, ShieldQuestion, XCircle } from 'lucide-react'
import type { NovelEntityCandidate } from '@repo/shared/novel'
import {
  confirmEntityCandidate,
  listEntityCandidates,
  rejectEntityCandidate,
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
import { Input } from '@/components/ui/input'
import { toastError, toastSuccess } from '@/hooks/use-toast'

interface EntityCandidatePanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string | null
}

/** 候选 payload 摘要（conflict / clue 各自的展示字段） */
function describePayload(candidate: NovelEntityCandidate): string {
  const payload = candidate.payload as Record<string, unknown>
  if (candidate.entityType === 'conflict') {
    const desc = typeof payload.description === 'string' ? payload.description : ''
    const participants = Array.isArray(payload.participants) ? payload.participants.join('、') : ''
    return `${desc}${participants ? `（对抗方：${participants}）` : ''}`
  }
  const desc = typeof payload.description === 'string' ? payload.description : ''
  const pointsTo = typeof payload.pointsTo === 'string' ? payload.pointsTo : ''
  return `${desc}${pointsTo ? ` → 指向 ${pointsTo}` : ''}`
}

export function EntityCandidatePanel({ open, onOpenChange, projectId }: EntityCandidatePanelProps): ReactElement {
  const [candidates, setCandidates] = useState<NovelEntityCandidate[]>([])
  const [loading, setLoading] = useState(false)
  const [actingId, setActingId] = useState<string | null>(null)
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')

  const refresh = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const data = await listEntityCandidates(projectId, 'needs_review')
      setCandidates(data.candidates)
    } catch (err) {
      toastError('加载失败', err instanceof Error ? err.message : '未知错误')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    if (open && projectId) void refresh()
  }, [open, projectId, refresh])

  const handleConfirm = async (id: string): Promise<void> => {
    setActingId(id)
    try {
      const { candidate } = await confirmEntityCandidate(id)
      toastSuccess('已确认', `${candidate.entityType === 'conflict' ? '冲突' : '线索'}「${describePayload(candidate).slice(0, 20)}…」已晋升为正式实体`)
      setCandidates((prev) => prev.filter((c) => c.id !== id))
    } catch (err) {
      toastError('确认失败', err instanceof Error ? err.message : '未知错误')
    } finally {
      setActingId(null)
    }
  }

  const handleReject = async (): Promise<void> => {
    if (!rejectingId || !rejectReason.trim()) return
    setActingId(rejectingId)
    try {
      await rejectEntityCandidate(rejectingId, rejectReason.trim())
      toastSuccess('已拒绝', '该候选已标记为 rejected 并记录原因')
      setCandidates((prev) => prev.filter((c) => c.id !== rejectingId))
      setRejectingId(null)
      setRejectReason('')
    } catch (err) {
      toastError('拒绝失败', err instanceof Error ? err.message : '未知错误')
    } finally {
      setActingId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[75vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldQuestion className="h-5 w-5" />
            待确认的剧情实体
          </DialogTitle>
          <DialogDescription>
            Memory 从正文中发现了这些新的冲突/线索，需要你确认后才进入正式剧情实体。拒绝时必须填写原因。
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-3 py-2">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <LoaderCircle className="h-5 w-5 animate-spin mr-2" /> 加载中...
            </div>
          ) : candidates.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
              <Inbox className="h-8 w-8 mb-2" />
              <p>暂无待确认候选</p>
            </div>
          ) : (
            candidates.map((c) => (
              <div key={c.id} className="rounded-lg border p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <Badge variant={c.entityType === 'conflict' ? 'destructive' : 'default'}>
                    {c.entityType === 'conflict' ? '冲突' : '线索'}
                  </Badge>
                  {c.chapterNumber != null && (
                    <span className="text-xs text-muted-foreground">来源：第 {c.chapterNumber} 章</span>
                  )}
                </div>
                <p className="text-sm leading-relaxed">{describePayload(c)}</p>
                <div className="flex gap-2 justify-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={actingId === c.id}
                    onClick={() => { setRejectingId(c.id); setRejectReason('') }}
                  >
                    <XCircle className="h-4 w-4 mr-1" /> 拒绝
                  </Button>
                  <Button
                    size="sm"
                    disabled={actingId === c.id}
                    onClick={() => void handleConfirm(c.id)}
                  >
                    {actingId === c.id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-1" />}
                    确认
                  </Button>
                </div>
                {rejectingId === c.id && (
                  <div className="flex gap-2 pt-1">
                    <Input
                      placeholder="拒绝原因（必填）"
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void handleReject() }}
                      autoFocus
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!rejectReason.trim() || actingId === c.id}
                      onClick={() => void handleReject()}
                    >
                      提交拒绝
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRejectingId(null)}>取消</Button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
