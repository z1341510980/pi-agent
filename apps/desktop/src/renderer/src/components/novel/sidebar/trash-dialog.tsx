import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  listTrashedProjects,
  restoreProject,
  purgeProject,
  emptyTrash,
  type NovelProject,
} from '@/api/novel-client'

// ── 回收站对话框 ──

export interface TrashDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 项目恢复后回调（用于刷新项目列表） */
  onRestored?: () => void
}

export function TrashDialog({ open, onOpenChange, onRestored }: TrashDialogProps): ReactElement {
  const [trashedProjects, setTrashedProjects] = useState<NovelProject[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [purgeConfirm, setPurgeConfirm] = useState<{ id: string; title: string } | null>(null)
  const [emptyConfirm, setEmptyConfirm] = useState(false)

  // 打开时加载回收站项目列表
  const loadTrash = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const projects = await listTrashedProjects()
      setTrashedProjects(projects)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载回收站失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) loadTrash()
  }, [open, loadTrash])

  const handleRestore = useCallback(async (id: string) => {
    try {
      await restoreProject(id)
      setTrashedProjects((prev) => prev.filter((p) => p.id !== id))
      onRestored?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : '恢复项目失败')
    }
  }, [onRestored])

  const handlePurge = useCallback(async () => {
    if (!purgeConfirm) return
    try {
      await purgeProject(purgeConfirm.id)
      setTrashedProjects((prev) => prev.filter((p) => p.id !== purgeConfirm.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : '永久删除失败')
    } finally {
      setPurgeConfirm(null)
    }
  }, [purgeConfirm])

  const handleEmptyTrash = useCallback(async () => {
    try {
      await emptyTrash()
      setTrashedProjects([])
      setEmptyConfirm(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '清空回收站失败')
    }
  }, [])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>回收站</DialogTitle>
          <DialogDescription>
            已删除的项目可恢复或永久删除。永久删除后数据不可恢复。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 max-h-[400px] overflow-y-auto">
          {loading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">加载中...</div>
          ) : error ? (
            <div className="py-8 text-center text-sm text-destructive">{error}</div>
          ) : trashedProjects.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">回收站为空</div>
          ) : (
            <ul className="space-y-1">
              {trashedProjects.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{p.title}</div>
                    <div className="flex items-center gap-1.5 mt-0.5 text-nano text-muted-foreground">
                      <span>{p.genre}</span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">第 {p.currentChapter} 章</span>
                      {p.deletedAt != null && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>删除于 {new Date(p.deletedAt).toLocaleDateString('zh-CN')}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-success hover:text-success"
                    onClick={() => handleRestore(p.id)}
                  >
                    <RotateCcw className="size-3.5 mr-1" />
                    恢复
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setPurgeConfirm({ id: p.id, title: p.title })}
                  >
                    <Trash2 className="size-3.5 mr-1" />
                    永久删除
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {trashedProjects.length > 0 && !loading && !error && (
          <div className="flex justify-end pt-2 border-t border-border">
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => setEmptyConfirm(true)}
            >
              <Trash2 className="size-3.5 mr-1.5" />
              清空回收站
            </Button>
          </div>
        )}

        {/* 永久删除确认 */}
        <Dialog open={purgeConfirm != null} onOpenChange={(open) => { if (!open) setPurgeConfirm(null) }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>永久删除</DialogTitle>
              <DialogDescription>
                确定永久删除项目「{purgeConfirm?.title}」吗？此操作不可恢复，所有章节、角色、冲突等数据将被清除。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPurgeConfirm(null)}>取消</Button>
              <Button variant="destructive" onClick={handlePurge}>永久删除</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 清空回收站确认 */}
        <Dialog open={emptyConfirm} onOpenChange={setEmptyConfirm}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>清空回收站</DialogTitle>
              <DialogDescription>
                确定清空回收站吗？将永久删除 {trashedProjects.length} 个项目，此操作不可恢复。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEmptyConfirm(false)}>取消</Button>
              <Button variant="destructive" onClick={handleEmptyTrash}>清空</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  )
}
