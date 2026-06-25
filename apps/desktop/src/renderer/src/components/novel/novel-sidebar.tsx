import { useCallback, useMemo, useState, type ReactElement } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BookOpen,
  Plus,
  Users,
  FileText,
  Lightbulb,
  Swords,
  ChevronRight,
  ChevronDown,
  Trash2,
} from 'lucide-react'
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
import { useNovelStore, type NovelNodeType } from '@/stores/novel-store'
import {
  listProjects,
  createProject,
  createChapter,
  createConflict,
  createForeshadow,
  deleteCharacter,
  deleteChapter,
  deleteConflict,
  deleteForeshadow,
  type NovelCharacter,
  type NovelChapter,
  type NovelConflict,
  type NovelForeshadow,
} from '@/api/novel-client'
import { CharacterCreateDialog } from './character-create-dialog'

// ── 通用节点类型（用于拖拽） ──

type DraggableEntityType = 'character' | 'chapter' | 'foreshadow' | 'conflict'

function setDragData(
  e: React.DragEvent<HTMLDivElement>,
  type: DraggableEntityType,
  id: string,
): void {
  e.dataTransfer.setData('application/novel-node', JSON.stringify({ type, id }))
  e.dataTransfer.effectAllowed = 'move'
}

// ── 主组件 ──

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
  const selectNode = useNovelStore((s) => s.selectNode)

  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [characterDialogOpen, setCharacterDialogOpen] = useState(false)
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
      setProjectDialogOpen(false)
      setForm({ title: '', genre: '', synopsis: '', targetWords: '300000' })
      void queryClient.invalidateQueries({ queryKey: ['novel-projects'] })
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建项目失败')
    } finally {
      setSubmitting(false)
    }
  }, [form, upsertProject, setCurrentProject, queryClient])

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
    <div className="flex h-full flex-col bg-surface-1 border-r border-border">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <BookOpen className="size-4 text-primary" />
          <span className="text-sm font-semibold text-text">小说项目</span>
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
                  </li>
                )
              })}
            </ul>

            {/* 当前项目分组树 */}
            {currentProject && (
              <div className="mt-2 pt-2 border-t border-border">
                <ProjectTree
                  projectId={currentProject.id}
                  characters={characters}
                  chapters={chapters}
                  conflicts={conflicts}
                  foreshadows={foreshadows}
                  onSelectEntity={handleSelectEntity}
                  onOpenCharacterDialog={() => setCharacterDialogOpen(true)}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* 新建项目对话框 */}
      <Dialog open={projectDialogOpen} onOpenChange={setProjectDialogOpen}>
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

// ── 项目分组树 ──

interface ProjectTreeProps {
  projectId: string
  characters: NovelCharacter[]
  chapters: NovelChapter[]
  conflicts: NovelConflict[]
  foreshadows: NovelForeshadow[]
  onSelectEntity: (id: string, type: NovelNodeType) => void
  onOpenCharacterDialog: () => void
}

function ProjectTree({
  projectId,
  characters,
  chapters,
  conflicts,
  foreshadows,
  onSelectEntity,
  onOpenCharacterDialog,
}: ProjectTreeProps): ReactElement {
  const upsertChapter = useNovelStore((s) => s.upsertChapter)
  const upsertConflict = useNovelStore((s) => s.upsertConflict)
  const upsertForeshadow = useNovelStore((s) => s.upsertForeshadow)
  const removeCharacter = useNovelStore((s) => s.removeCharacter)
  const removeChapter = useNovelStore((s) => s.removeChapter)
  const removeConflict = useNovelStore((s) => s.removeConflict)
  const removeForeshadow = useNovelStore((s) => s.removeForeshadow)

  const sortedChapters = useMemo(
    () => [...chapters].sort((a, b) => a.chapterNumber - b.chapterNumber),
    [chapters],
  )

  const handleAddChapter = useCallback(async () => {
    const nextNumber = chapters.length > 0
      ? Math.max(...chapters.map((c) => c.chapterNumber)) + 1
      : 1
    try {
      const chapter = await createChapter(projectId, {
        chapterNumber: nextNumber,
        narrativeTask: {
          description: '推进主线剧情',
          type: 'advance_mainline',
          priority: 'medium',
        },
      })
      upsertChapter(chapter)
    } catch {
      // 静默失败
    }
  }, [projectId, chapters, upsertChapter])

  const handleAddConflict = useCallback(async () => {
    try {
      const conflict = await createConflict(projectId, {
        description: '新的冲突',
        type: 'interest',
        intensity: 5,
        stage: 'latent',
      })
      upsertConflict(conflict)
    } catch {
      // 静默失败
    }
  }, [projectId, upsertConflict])

  const handleAddForeshadow = useCallback(async () => {
    try {
      const foreshadow = await createForeshadow(projectId, {
        description: '新的伏笔',
        category: '事件',
        status: 'planned',
      })
      upsertForeshadow(foreshadow)
    } catch {
      // 静默失败
    }
  }, [projectId, upsertForeshadow])

  const handleDelete = useCallback(
    async (
      type: DraggableEntityType,
      id: string,
      label: string,
    ) => {
      if (!window.confirm(`确认删除「${label}」？此操作不可撤销。`)) return
      try {
        switch (type) {
          case 'character':
            await deleteCharacter(id)
            removeCharacter(id)
            break
          case 'chapter':
            await deleteChapter(id)
            removeChapter(id)
            break
          case 'conflict':
            await deleteConflict(id)
            removeConflict(id)
            break
          case 'foreshadow':
            await deleteForeshadow(id)
            removeForeshadow(id)
            break
        }
      } catch {
        // 静默失败
      }
    },
    [removeCharacter, removeChapter, removeConflict, removeForeshadow],
  )

  return (
    <div className="space-y-0.5 px-0.5">
      {/* 角色集合 */}
      <CollapsibleGroup
        icon={Users}
        label="角色集合"
        count={characters.length}
        accent="text-blue-500"
        onAdd={onOpenCharacterDialog}
        addLabel="新建角色"
      >
        {characters.length === 0 ? (
          <EmptyHint text="暂无角色" />
        ) : (
          characters.map((c) => (
            <EntityItem
              key={c.id}
              label={c.name || '未命名'}
              sublabel={c.identity}
              onClick={() => onSelectEntity(c.id, 'character')}
              onDragStart={(e) => setDragData(e, 'character', c.id)}
              onDelete={() => handleDelete('character', c.id, c.name || '角色')}
            />
          ))
        )}
      </CollapsibleGroup>

      {/* 章节集合 */}
      <CollapsibleGroup
        icon={FileText}
        label="章节集合"
        count={chapters.length}
        accent="text-emerald-500"
        onAdd={handleAddChapter}
        addLabel="新建章节"
      >
        {sortedChapters.length === 0 ? (
          <EmptyHint text="暂无章节" />
        ) : (
          sortedChapters.map((chapter) => (
            <ChapterItem
              key={chapter.id}
              chapter={chapter}
              characters={characters}
              conflicts={conflicts}
              foreshadows={foreshadows}
              onSelectEntity={onSelectEntity}
              onDelete={() => handleDelete('chapter', chapter.id, `第 ${chapter.chapterNumber} 章`)}
            />
          ))
        )}
      </CollapsibleGroup>

      {/* 伏笔集合 */}
      <CollapsibleGroup
        icon={Lightbulb}
        label="伏笔集合"
        count={foreshadows.length}
        accent="text-amber-500"
        onAdd={handleAddForeshadow}
        addLabel="新建伏笔"
      >
        {foreshadows.length === 0 ? (
          <EmptyHint text="暂无伏笔" />
        ) : (
          foreshadows.map((f) => (
            <EntityItem
              key={f.id}
              label={f.description.length > 18 ? `${f.description.slice(0, 18)}...` : f.description}
              sublabel={f.category}
              onClick={() => onSelectEntity(f.id, 'foreshadow')}
              onDragStart={(e) => setDragData(e, 'foreshadow', f.id)}
              onDelete={() => handleDelete('foreshadow', f.id, '伏笔')}
            />
          ))
        )}
      </CollapsibleGroup>

      {/* 冲突集合 */}
      <CollapsibleGroup
        icon={Swords}
        label="冲突集合"
        count={conflicts.length}
        accent="text-rose-500"
        onAdd={handleAddConflict}
        addLabel="新建冲突"
      >
        {conflicts.length === 0 ? (
          <EmptyHint text="暂无冲突" />
        ) : (
          conflicts.map((c) => (
            <EntityItem
              key={c.id}
              label={c.description.length > 18 ? `${c.description.slice(0, 18)}...` : c.description}
              sublabel={c.type}
              onClick={() => onSelectEntity(c.id, 'conflict')}
              onDragStart={(e) => setDragData(e, 'conflict', c.id)}
              onDelete={() => handleDelete('conflict', c.id, '冲突')}
            />
          ))
        )}
      </CollapsibleGroup>
    </div>
  )
}

// ── 可折叠分组 ──

interface CollapsibleGroupProps {
  icon: typeof Users
  label: string
  count: number
  accent: string
  onAdd: () => void
  addLabel: string
  children: ReactElement | ReactElement[]
}

function CollapsibleGroup({
  icon: Icon,
  label,
  count,
  accent,
  onAdd,
  addLabel,
  children,
}: CollapsibleGroupProps): ReactElement {
  const [expanded, setExpanded] = useState(true)
  const Chevron = expanded ? ChevronDown : ChevronRight
  return (
    <div className="rounded-md">
      <div className="flex items-center group">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1.5 flex-1 min-w-0 px-1.5 py-1 rounded text-left hover:bg-muted transition-colors"
        >
          <Chevron className="size-3.5 text-muted-foreground shrink-0" />
          <Icon className={cn('size-3.5 shrink-0', accent)} />
          <span className="text-xs font-medium text-text truncate">{label}</span>
          <Badge variant="secondary" className="ml-auto h-4 px-1 text-[10px]">
            {count}
          </Badge>
        </button>
      </div>
      {expanded && (
        <div className="ml-3 pl-2 border-l border-border/60 mt-0.5 space-y-0.5">
          {children}
          <button
            type="button"
            onClick={onAdd}
            className="flex items-center gap-1.5 w-full px-1.5 py-1 rounded text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <Plus className="size-3" />
            <span>{addLabel}</span>
          </button>
        </div>
      )}
    </div>
  )
}

// ── 实体项（可点击 + 拖拽 + 删除） ──

interface EntityItemProps {
  label: string
  sublabel?: string
  onClick: () => void
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void
  onDelete: () => void
}

function EntityItem({
  label,
  sublabel,
  onClick,
  onDragStart,
  onDelete,
}: EntityItemProps): ReactElement {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      className="group flex items-center gap-1.5 px-1.5 py-1 rounded text-left hover:bg-muted transition-colors cursor-pointer"
    >
      <span className="size-1 rounded-full bg-muted-foreground/40 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-xs text-text truncate">{label}</div>
        {sublabel && (
          <div className="text-[10px] text-muted-foreground truncate">{sublabel}</div>
        )}
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        title="删除"
        className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive shrink-0"
      >
        <Trash2 className="size-3" />
      </button>
    </div>
  )
}

// ── 章节项（可继续展开显示该章关联实体） ──

interface ChapterItemProps {
  chapter: NovelChapter
  characters: NovelCharacter[]
  conflicts: NovelConflict[]
  foreshadows: NovelForeshadow[]
  onSelectEntity: (id: string, type: NovelNodeType) => void
  onDelete: () => void
}

function ChapterItem({
  chapter,
  characters,
  conflicts,
  foreshadows,
  onSelectEntity,
  onDelete,
}: ChapterItemProps): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const Chevron = expanded ? ChevronDown : ChevronRight
  const title = chapter.title || `第 ${chapter.chapterNumber} 章`

  // 该章关联的伏笔（按 firstChapter / recoverByChapter 匹配章节号）
  const chapterForeshadows = useMemo(
    () =>
      foreshadows.filter(
        (f) =>
          (f.firstChapter != null && f.firstChapter === chapter.chapterNumber) ||
          (f.recoverByChapter != null && f.recoverByChapter === chapter.chapterNumber),
      ),
    [foreshadows, chapter.chapterNumber],
  )

  return (
    <div>
      <div
        draggable
        onDragStart={(e) => setDragData(e, 'chapter', chapter.id)}
        className="group flex items-center gap-1.5 px-1.5 py-1 rounded text-left hover:bg-muted transition-colors cursor-pointer"
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setExpanded((v) => !v)
          }}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={expanded ? '收起' : '展开'}
        >
          <Chevron className="size-3.5" />
        </button>
        <span className="size-1 rounded-full bg-emerald-500/60 shrink-0" aria-hidden="true" />
        <div
          className="min-w-0 flex-1 cursor-pointer"
          onClick={() => onSelectEntity(chapter.id, 'chapter')}
        >
          <div className="text-xs text-text truncate">
            <span className="text-muted-foreground">第 {chapter.chapterNumber} 章</span> · {title}
          </div>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          title="删除"
          className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive shrink-0"
        >
          <Trash2 className="size-3" />
        </button>
      </div>

      {expanded && (
        <div className="ml-3 pl-2 border-l border-border/60 mt-0.5 space-y-1">
          {/* 出场角色（暂以全部项目角色近似展示） */}
          <div>
            <div className="text-[10px] text-muted-foreground px-1.5 py-0.5">
              出场角色（{characters.length}）
            </div>
            {characters.length === 0 ? (
              <div className="text-[10px] text-muted-foreground/70 px-1.5 py-0.5">
                暂无角色（章节→角色映射未实现，默认显示全部）
              </div>
            ) : (
              <div className="space-y-0.5">
                {characters.map((c) => (
                  <div
                    key={c.id}
                    onClick={() => onSelectEntity(c.id, 'character')}
                    className="flex items-center gap-1.5 px-1.5 py-0.5 rounded text-[11px] hover:bg-muted transition-colors cursor-pointer"
                  >
                    <Users className="size-2.5 text-blue-500/70 shrink-0" />
                    <span className="text-text truncate">{c.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 章节关联伏笔 */}
          <div>
            <div className="text-[10px] text-muted-foreground px-1.5 py-0.5">
              伏笔（{chapterForeshadows.length}）
            </div>
            {chapterForeshadows.length === 0 ? (
              <div className="text-[10px] text-muted-foreground/70 px-1.5 py-0.5">
                本章无关联伏笔
              </div>
            ) : (
              <div className="space-y-0.5">
                {chapterForeshadows.map((f) => (
                  <div
                    key={f.id}
                    onClick={() => onSelectEntity(f.id, 'foreshadow')}
                    className="flex items-center gap-1.5 px-1.5 py-0.5 rounded text-[11px] hover:bg-muted transition-colors cursor-pointer"
                  >
                    <Lightbulb className="size-2.5 text-amber-500/70 shrink-0" />
                    <span className="text-text truncate">
                      {f.description.length > 18 ? `${f.description.slice(0, 18)}...` : f.description}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 章节冲突（暂以全部项目冲突近似展示） */}
          <div>
            <div className="text-[10px] text-muted-foreground px-1.5 py-0.5">
              冲突（{conflicts.length}）
            </div>
            {conflicts.length === 0 ? (
              <div className="text-[10px] text-muted-foreground/70 px-1.5 py-0.5">
                暂无冲突（章节→冲突映射未实现，默认显示全部）
              </div>
            ) : (
              <div className="space-y-0.5">
                {conflicts.map((c) => (
                  <div
                    key={c.id}
                    onClick={() => onSelectEntity(c.id, 'conflict')}
                    className="flex items-center gap-1.5 px-1.5 py-0.5 rounded text-[11px] hover:bg-muted transition-colors cursor-pointer"
                  >
                    <Swords className="size-2.5 text-rose-500/70 shrink-0" />
                    <span className="text-text truncate">
                      {c.description.length > 18 ? `${c.description.slice(0, 18)}...` : c.description}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── 空提示 ──

function EmptyHint({ text }: { text: string }): ReactElement {
  return <div className="text-[10px] text-muted-foreground/70 px-1.5 py-1">{text}</div>
}
