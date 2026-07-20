import { useCallback, useMemo, useState, type ReactElement } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useNovelDataStore } from '@/stores/novel-data-store'
import { useNovelUiStore, type NovelNodeType } from '@/stores/novel-ui-store'
import {
  listProjects,
  createProject,
  deleteProject,
  type NovelChapter,
  type TargetPlatform,
} from '@/api/novel-client'
import { CharacterCreateDialog } from './character-create-dialog'
import { ProjectTree } from './sidebar/project-tree'
import { TrashDialog } from './sidebar/trash-dialog'
import { STYLE_TEMPLATES } from './sidebar/style-templates'
import { SIDEBAR_PLATFORM_OPTIONS } from './sidebar/sidebar-constants'

// ── 主组件 ──

export interface NovelSidebarProps {
  /** 开始创作回调（D-5 联动：手动编排 / AI编排） */
  onStartCreation?: (mode: 'manual' | 'ai-arrange', chapterNumber?: number) => void
}

export function NovelSidebar({ onStartCreation }: NovelSidebarProps): ReactElement {
  const queryClient = useQueryClient()
  const projects = useNovelDataStore((s) => s.projects)
  const currentProjectId = useNovelDataStore((s) => s.currentProjectId)
  const setCurrentProject = useNovelDataStore((s) => s.setCurrentProject)
  const setProjects = useNovelDataStore((s) => s.setProjects)
  const upsertProject = useNovelDataStore((s) => s.upsertProject)
  const characters = useNovelDataStore((s) => s.characters)
  const chapters = useNovelDataStore((s) => s.chapters)
  const volumes = useNovelDataStore((s) => s.volumes)
  const conflicts = useNovelDataStore((s) => s.conflicts)
  const clues = useNovelDataStore((s) => s.clues)
  const foreshadows = useNovelDataStore((s) => s.foreshadows)
  const factions = useNovelDataStore((s) => s.factions)
  const locations = useNovelDataStore((s) => s.locations)
  const worldElements = useNovelDataStore((s) => s.worldElements)
  const infoLayers = useNovelDataStore((s) => s.infoLayers)
  const items = useNovelDataStore((s) => s.items)
  const selectNode = useNovelUiStore((s) => s.selectNode)
  const setPlayheadChapter = useNovelUiStore((s) => s.setPlayheadChapter)

  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [characterDialogOpen, setCharacterDialogOpen] = useState(false)
  const [form, setForm] = useState({ title: '', genre: '', synopsis: '', targetWords: '300000', targetPlatform: '__none__' as TargetPlatform | '__none__' })
  const [selectedTemplate, setSelectedTemplate] = useState<string>('custom')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 大纲树编排入口：先切播放头到目标章节，再联动 novel-workspace 的 handleStartCreation
  // ⚠️ 必须把 chapterNumber 直接透传给 onStartCreation，不能只靠 setPlayheadChapter 中转：
  // setPlayheadChapter 是 zustand set（同步生效），但 novel-workspace 的 handleStartCreation
  // 是 useCallback 闭包，捕获的 playheadChapter 是旧值，新值要等下一次 React render 才生效。
  // 同步连调 onStartCreation 时闭包仍读旧值，会传错章节号（默认 1）。
  const handleManualArrange = useCallback((chapter: NovelChapter) => {
    setPlayheadChapter(chapter.chapterNumber)
    onStartCreation?.('manual', chapter.chapterNumber)
  }, [setPlayheadChapter, onStartCreation])
  const handleAiArrange = useCallback((chapter: NovelChapter) => {
    setPlayheadChapter(chapter.chapterNumber)
    onStartCreation?.('ai-arrange', chapter.chapterNumber)
  }, [setPlayheadChapter, onStartCreation])

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
      selectNode(id, 'project')
    },
    [selectNode, setCurrentProject],
  )

  // ── 项目删除（移入回收站）──
  const removeProject = useNovelDataStore((s) => s.removeProject)
  const [trashDialogOpen, setTrashDialogOpen] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; title: string } | null>(null)

  const handleDeleteProject = useCallback(
    (id: string, title: string) => {
      setDeleteConfirm({ id, title })
    },
    [],
  )

  const confirmDeleteProject = useCallback(async () => {
    if (!deleteConfirm) return
    try {
      await deleteProject(deleteConfirm.id)
      removeProject(deleteConfirm.id)
      queryClient.invalidateQueries({ queryKey: ['novel', 'projects'] })
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除项目失败')
    } finally {
      setDeleteConfirm(null)
    }
  }, [deleteConfirm, removeProject, queryClient])

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
        targetPlatform: form.targetPlatform === '__none__' ? undefined : form.targetPlatform,
      })
      upsertProject(project)
      setCurrentProject(project.id)
      setProjectDialogOpen(false)
      setForm({ title: '', genre: '', synopsis: '', targetWords: '300000', targetPlatform: '__none__' as TargetPlatform | '__none__' })
      setSelectedTemplate('custom')
      void queryClient.invalidateQueries({ queryKey: ['novel-projects'] })
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建项目失败')
    } finally {
      setSubmitting(false)
    }
  }, [form, selectedTemplate, upsertProject, setCurrentProject, queryClient])

  const currentProject = useMemo(
    () => projects.find((p) => p.id === currentProjectId) ?? null,
    [projects, currentProjectId],
  )

  const handleSelectEntity = useCallback(
    (id: string, type: NovelNodeType) => {
      selectNode(id, type)
    },
    [selectNode],
  )

  return (
    <div className="flex h-full flex-col bg-surface-1 border-r border-border/60">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <BookOpen className="size-4 text-primary" />
          <span className="text-[13px] font-semibold text-text">小说项目</span>
        </div>
        <Button size="icon-sm" variant="ghost" onClick={() => setProjectDialogOpen(true)} aria-label="新建项目">
          <Plus className="size-4" />
        </Button>
      </div>

      {/* 主体：项目列表 + 当前项目分组树 */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {projects.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <p className="text-xs text-muted-foreground mb-3">暂无项目</p>
            <Button size="sm" variant="outline" onClick={() => setProjectDialogOpen(true)}>
              <Plus className="size-3.5" /> 新建项目
            </Button>
          </div>
        ) : (
          <div className="p-1.5 space-y-1">
            {/* 项目选择列表（紧凑） */}
            <ul className="space-y-0.5">
              {projects.map((p) => {
                const isActive = p.id === currentProjectId
                return (
                  <li key={p.id} className="group relative">
                    <button
                      type="button"
                      onClick={() => handleSelectProject(p.id)}
                      className={cn(
                        'w-full text-left rounded-lg px-2.5 py-2 transition-colors duration-150 ease-out',
                        isActive
                          ? 'bg-primary/[0.08] text-text'
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
                        <span className="tabular-nums">第 {p.currentChapter} 章</span>
                      </div>
                    </button>
                    {/* 删除项目按钮（hover 显示，移入回收站） */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDeleteProject(p.id, p.title)
                      }}
                      aria-label="移入回收站"
                      className="absolute top-1.5 right-1.5 z-10 size-6 flex items-center justify-center rounded text-muted-foreground opacity-0 pointer-events-none transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:pointer-events-auto group-hover:opacity-100"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </li>
                )
              })}
            </ul>

            {/* 当前项目分组树 */}
            {currentProject && (
              <div className="mt-2 pt-2 border-t border-border">
                <ProjectTree
                  projectId={currentProject.id}
                  project={currentProject}
                  characters={characters}
                  chapters={chapters}
                  volumes={volumes}
                  conflicts={conflicts}
                  clues={clues}
                  foreshadows={foreshadows}
                  factions={factions}
                  locations={locations}
                  worldElements={worldElements}
                  infoLayers={infoLayers}
                  items={items}
                  onSelectEntity={handleSelectEntity}
                  onOpenCharacterDialog={() => setCharacterDialogOpen(true)}
                  onManualArrange={handleManualArrange}
                  onAiArrange={handleAiArrange}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* 底部回收站入口 */}
      <div className="border-t border-border p-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-muted-foreground hover:text-text"
          onClick={() => setTrashDialogOpen(true)}
        >
          <Trash2 className="size-3.5 mr-1.5" />
          回收站
        </Button>
      </div>

      {/* 删除确认对话框（移入回收站） */}
      <Dialog open={deleteConfirm != null} onOpenChange={(open) => { if (!open) setDeleteConfirm(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>移入回收站</DialogTitle>
            <DialogDescription>
              确定将项目「{deleteConfirm?.title}」移入回收站吗？移入后可在回收站中恢复或永久删除。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>取消</Button>
            <Button variant="destructive" onClick={confirmDeleteProject}>
              <Trash2 className="size-3.5 mr-1.5" />
              移入回收站
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 回收站对话框 */}
      <TrashDialog
        open={trashDialogOpen}
        onOpenChange={setTrashDialogOpen}
        onRestored={() => {
          queryClient.invalidateQueries({ queryKey: ['novel', 'projects'] })
        }}
      />
      <Dialog open={projectDialogOpen} onOpenChange={setProjectDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>新建小说项目</DialogTitle>
            <DialogDescription className="text-pretty">选择风格模板快速开始，或自定义配置</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {/* 风格模板卡片选择 */}
            <div className="space-y-2">
              <Label>风格模板</Label>
              <div className="grid grid-cols-2 gap-2">
                {STYLE_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => {
                      setSelectedTemplate(tpl.id)
                      // 选择模板时自动填充字段（标题和简介保留用户输入）
                      setForm((f) => ({
                        ...f,
                        genre: tpl.genre || f.genre,
                        targetWords: tpl.targetWords,
                        targetPlatform: (tpl.platform ?? '__none__') as TargetPlatform | '__none__',
                      }))
                    }}
                    className={cn(
                      'flex flex-col items-start gap-0.5 rounded-lg border p-3 text-left transition-colors',
                      selectedTemplate === tpl.id
                        ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                        : 'border-border hover:border-primary/40 hover:bg-accent/50',
                    )}
                  >
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      <span className="text-base">{tpl.emoji}</span>
                      {tpl.name}
                    </span>
                    <span className="text-xs text-muted-foreground line-clamp-1">{tpl.description}</span>
                  </button>
                ))}
              </div>
            </div>

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
            <div className="space-y-1.5">
              <Label>目标平台</Label>
              <Select
                value={form.targetPlatform}
                onValueChange={(v) => setForm((f) => ({ ...f, targetPlatform: v as TargetPlatform | '__none__' }))}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择目标平台" />
                </SelectTrigger>
                <SelectContent>
                  {SIDEBAR_PLATFORM_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setProjectDialogOpen(false)} disabled={submitting}>
              取消
            </Button>
            <Button onClick={handleCreateProject} disabled={submitting}>
              {submitting ? '创建中...' : '创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* AI 角色创建对话框 */}
      <CharacterCreateDialog
        open={characterDialogOpen}
        onOpenChange={setCharacterDialogOpen}
        projectId={currentProjectId}
      />
    </div>
  )
}
