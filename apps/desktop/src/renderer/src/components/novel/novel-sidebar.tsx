import { useCallback, useState, type ReactElement } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, Plus, Users, FileText, Swords, Lightbulb } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useNovelStore } from '@/stores/novel-store'
import { listProjects, createProject } from '@/api/novel-client'

interface EntityCountRow {
  label: string
  icon: typeof Users
  count: number
  color: string
}

export function NovelSidebar(): ReactElement {
  const queryClient = useQueryClient()
  const projects = useNovelStore((s) => s.projects)
  const currentProjectId = useNovelStore((s) => s.currentProjectId)
  const setCurrentProject = useNovelStore((s) => s.setCurrentProject)
  const setProjects = useNovelStore((s) => s.setProjects)
  const upsertProject = useNovelStore((s) => s.upsertProject)
  const characters = useNovelStore((s) => s.characters)
  const chapters = useNovelStore((s) => s.chapters)
  const conflicts = useNovelStore((s) => s.conflicts)
  const foreshadows = useNovelStore((s) => s.foreshadows)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState({ title: '', genre: '', synopsis: '', targetWords: '300000' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 拉取项目列表
  useQuery({
    queryKey: ['novel-projects'],
    queryFn: async () => {
      const list = await listProjects()
      setProjects(list)
      return list
    },
    refetchInterval: 30_000,
  })

  const handleSelectProject = useCallback(
    (id: string) => {
      setCurrentProject(id)
    },
    [setCurrentProject],
  )

  const handleCreateProject = useCallback(async () => {
    setError(null)
    if (!form.title.trim()) {
      setError('请输入项目标题')
      return
    }
    if (!form.genre.trim()) {
      setError('请输入题材')
      return
    }
    setSubmitting(true)
    try {
      const project = await createProject({
        title: form.title.trim(),
        genre: form.genre.trim(),
        synopsis: form.synopsis.trim(),
        targetWords: Number(form.targetWords) || 0,
      })
      upsertProject(project)
      setCurrentProject(project.id)
      setDialogOpen(false)
      setForm({ title: '', genre: '', synopsis: '', targetWords: '300000' })
      void queryClient.invalidateQueries({ queryKey: ['novel-projects'] })
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建项目失败')
    } finally {
      setSubmitting(false)
    }
  }, [form, upsertProject, setCurrentProject, queryClient])

  const entityCounts: EntityCountRow[] = currentProjectId
    ? [
        { label: '角色', icon: Users, count: characters.length, color: 'text-blue-500' },
        { label: '章节', icon: FileText, count: chapters.length, color: 'text-emerald-500' },
        { label: '冲突', icon: Swords, count: conflicts.length, color: 'text-rose-500' },
        { label: '伏笔', icon: Lightbulb, count: foreshadows.length, color: 'text-amber-500' },
      ]
    : []

  return (
    <div className="flex h-full flex-col bg-surface-1 border-r border-border">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <BookOpen className="size-4 text-primary" />
          <span className="text-sm font-semibold text-text">小说项目</span>
        </div>
        <Button size="icon-sm" variant="ghost" onClick={() => setDialogOpen(true)} aria-label="新建项目">
          <Plus className="size-4" />
        </Button>
      </div>

      {/* 项目列表 */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {projects.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <p className="text-xs text-muted-foreground mb-3">暂无项目</p>
            <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
              <Plus className="size-3.5" /> 新建项目
            </Button>
          </div>
        ) : (
          <ul className="p-1.5 space-y-0.5">
            {projects.map((p) => {
              const isActive = p.id === currentProjectId
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => handleSelectProject(p.id)}
                    className={cn(
                      'w-full text-left rounded-md px-2.5 py-2 transition-colors',
                      isActive
                        ? 'bg-primary/10 text-text'
                        : 'hover:bg-muted text-text-secondary',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'size-1.5 rounded-full shrink-0',
                          p.status === 'active' && 'bg-success',
                          p.status === 'paused' && 'bg-amber-500',
                          p.status === 'completed' && 'bg-primary',
                        )}
                        aria-hidden="true"
                      />
                      <span className="text-sm font-medium truncate flex-1">{p.title}</span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5 pl-3.5 text-[10px] text-muted-foreground">
                      <span>{p.genre}</span>
                      <span aria-hidden="true">·</span>
                      <span>第 {p.currentChapter} 章</span>
                    </div>
                  </button>
                  {/* 当前项目的实体计数 */}
                  {isActive && entityCounts.length > 0 && (
                    <div className="grid grid-cols-2 gap-1 px-2.5 py-2 mt-0.5">
                      {entityCounts.map((row) => (
                        <div
                          key={row.label}
                          className="flex items-center gap-1.5 rounded bg-muted/50 px-2 py-1"
                        >
                          <row.icon className={cn('size-3', row.color)} />
                          <span className="text-[10px] text-muted-foreground">{row.label}</span>
                          <Badge variant="secondary" className="ml-auto h-4 px-1 text-[10px]">
                            {row.count}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* 新建项目对话框 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建小说项目</DialogTitle>
            <DialogDescription>创建一个新的小说创作项目</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="np-title">标题</Label>
              <Input
                id="np-title"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="例如：星河彼岸"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="np-genre">题材</Label>
              <Input
                id="np-genre"
                value={form.genre}
                onChange={(e) => setForm((f) => ({ ...f, genre: e.target.value }))}
                placeholder="玄幻 / 科幻 / 悬疑 / 都市"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="np-synopsis">简介</Label>
              <textarea
                id="np-synopsis"
                value={form.synopsis}
                onChange={(e) => setForm((f) => ({ ...f, synopsis: e.target.value }))}
                placeholder="一句话概括故事核心"
                className="w-full min-h-[72px] rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="np-words">目标字数</Label>
              <Input
                id="np-words"
                type="number"
                value={form.targetWords}
                onChange={(e) => setForm((f) => ({ ...f, targetWords: e.target.value }))}
              />
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={submitting}>
              取消
            </Button>
            <Button onClick={handleCreateProject} disabled={submitting}>
              {submitting ? '创建中...' : '创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
