import { Children, useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useDraggable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import {
  BookOpen,
  Plus,
  Users,
  Lightbulb,
  Swords,
  ChevronRight,
  ChevronDown,
  Trash2,
  MapPin,
  Globe,
  GripVertical,
  RotateCcw,
  Layers,
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
  createConflict,
  createForeshadow,
  createFaction,
  createLocation,
  createWorldElement,
  deleteCharacter,
  deleteChapter,
  deleteConflict,
  deleteForeshadow,
  deleteFaction,
  deleteLocation,
  deleteWorldElement,
  deleteProject,
  listTrashedProjects,
  restoreProject,
  purgeProject,
  emptyTrash,
  type NovelProject,
  type NovelCharacter,
  type NovelChapter,
  type NovelVolume,
  type NovelConflict,
  type NovelForeshadow,
  type NovelCharacterHistory,
  type NovelFaction,
  type NovelLocation,
  type NovelWorldElement,
  type NovelInformationLayer,
  createInfoLayer,
  deleteInfoLayer,
} from '@/api/novel-client'
import { CharacterCreateDialog } from './character-create-dialog'
import { OutlineTree } from './outline-tree'
import { GROUP_META, type MatrixEntityKind, type SidebarDragData } from './matrix/matrix-logic'

// ── 通用节点类型（用于删除等操作；拖拽已统一走 @dnd-kit useDraggable）──

type DraggableEntityType = 'character' | 'chapter' | 'foreshadow' | 'conflict' | 'faction' | 'location' | 'world_element' | 'info_layer'

// ── 主组件 ──

export interface NovelSidebarProps {
  /** 开始创作回调（D-5 联动：手动编排 / AI编排） */
  onStartCreation?: (mode: 'manual' | 'ai-arrange', chapterNumber?: number) => void
}

export function NovelSidebar({ onStartCreation }: NovelSidebarProps): ReactElement {
  const queryClient = useQueryClient()
  const projects = useNovelStore((s) => s.projects)
  const currentProjectId = useNovelStore((s) => s.currentProjectId)
  const setCurrentProject = useNovelStore((s) => s.setCurrentProject)
  const setProjects = useNovelStore((s) => s.setProjects)
  const upsertProject = useNovelStore((s) => s.upsertProject)
  const characters = useNovelStore((s) => s.characters)
  const chapters = useNovelStore((s) => s.chapters)
  const volumes = useNovelStore((s) => s.volumes)
  const conflicts = useNovelStore((s) => s.conflicts)
  const foreshadows = useNovelStore((s) => s.foreshadows)
  const factions = useNovelStore((s) => s.factions)
  const locations = useNovelStore((s) => s.locations)
  const worldElements = useNovelStore((s) => s.worldElements)
  const infoLayers = useNovelStore((s) => s.infoLayers)
  const selectNode = useNovelStore((s) => s.selectNode)
  const setPlayheadChapter = useNovelStore((s) => s.setPlayheadChapter)

  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [characterDialogOpen, setCharacterDialogOpen] = useState(false)
  const [form, setForm] = useState({ title: '', genre: '', synopsis: '', targetWords: '300000' })
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
    },
    [setCurrentProject],
  )

  // ── 项目删除（移入回收站）──
  const removeProject = useNovelStore((s) => s.removeProject)
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
                  <li key={p.id} className="group relative">
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
                  foreshadows={foreshadows}
                  factions={factions}
                  locations={locations}
                  worldElements={worldElements}
                  infoLayers={infoLayers}
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建小说项目</DialogTitle>
            <DialogDescription className="text-pretty">创建一个新的小说创作项目</DialogDescription>
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
  project: NovelProject
  characters: NovelCharacter[]
  chapters: NovelChapter[]
  volumes: NovelVolume[]
  conflicts: NovelConflict[]
  foreshadows: NovelForeshadow[]
  factions: NovelFaction[]
  locations: NovelLocation[]
  worldElements: NovelWorldElement[]
  infoLayers: NovelInformationLayer[]
  onSelectEntity: (id: string, type: NovelNodeType) => void
  onOpenCharacterDialog: () => void
  onManualArrange: (chapter: NovelChapter) => void
  onAiArrange: (chapter: NovelChapter) => void
}

function ProjectTree({
  projectId,
  project,
  characters,
  chapters,
  volumes,
  conflicts,
  foreshadows,
  factions,
  locations,
  worldElements,
  infoLayers,
  onSelectEntity,
  onOpenCharacterDialog,
  onManualArrange,
  onAiArrange,
}: ProjectTreeProps): ReactElement {
  const upsertConflict = useNovelStore((s) => s.upsertConflict)
  const upsertForeshadow = useNovelStore((s) => s.upsertForeshadow)
  const upsertFaction = useNovelStore((s) => s.upsertFaction)
  const upsertLocation = useNovelStore((s) => s.upsertLocation)
  const upsertWorldElement = useNovelStore((s) => s.upsertWorldElement)
  const upsertInfoLayer = useNovelStore((s) => s.upsertInfoLayer)
  const removeCharacter = useNovelStore((s) => s.removeCharacter)
  const removeChapter = useNovelStore((s) => s.removeChapter)
  const removeConflict = useNovelStore((s) => s.removeConflict)
  const removeForeshadow = useNovelStore((s) => s.removeForeshadow)
  const removeFaction = useNovelStore((s) => s.removeFaction)
  const removeLocation = useNovelStore((s) => s.removeLocation)
  const removeWorldElement = useNovelStore((s) => s.removeWorldElement)
  const removeInfoLayer = useNovelStore((s) => s.removeInfoLayer)
  // ── C-3 与 MatrixView 共享的折叠 / 选中 / 章节滚动信号 ──
  const selectedNodeId = useNovelStore((s) => s.selectedNodeId)
  const collapsedGroups = useNovelStore((s) => s.collapsedGroups)
  const toggleCollapsedGroup = useNovelStore((s) => s.toggleCollapsedGroup)

  const handleAddConflict = useCallback(async () => {
    try {
      const conflict = await createConflict(projectId, {
        description: '新的冲突',
        type: 'interest',
        intensity: 5,
        stage: 'latent',
      })
      upsertConflict(conflict)
    } catch (err) {
      console.error('[NovelSidebar] 创建冲突失败:', err)
    }
  }, [projectId, upsertConflict])

  const handleAddForeshadow = useCallback(async () => {
    try {
      const foreshadow = await createForeshadow(projectId, {
        description: '新的伏笔',
        category: 'event',
        status: 'planned',
      })
      upsertForeshadow(foreshadow)
    } catch (err) {
      console.error('[NovelSidebar] 创建伏笔失败:', err)
    }
  }, [projectId, upsertForeshadow])

  const handleAddFaction = useCallback(async () => {
    try {
      const faction = await createFaction(projectId, {
        name: '新势力',
        description: '',
        type: 'organization',
        strength: 'medium',
        status: 'active',
      })
      upsertFaction(faction)
    } catch (err) {
      console.error('[NovelSidebar] 创建势力失败:', err)
    }
  }, [projectId, upsertFaction])

  const handleAddLocation = useCallback(async () => {
    try {
      const location = await createLocation(projectId, {
        name: '新地点',
        description: '',
        type: 'city',
        significance: 'minor',
        status: 'normal',
      })
      upsertLocation(location)
    } catch (err) {
      console.error('[NovelSidebar] 创建地点失败:', err)
    }
  }, [projectId, upsertLocation])

  const handleAddWorldElement = useCallback(async () => {
    try {
      const element = await createWorldElement(projectId, {
        category: 'history',
        name: '新世界观要素',
        description: '',
      })
      upsertWorldElement(element)
    } catch (err) {
      console.error('[NovelSidebar] 创建世界观要素失败:', err)
    }
  }, [projectId, upsertWorldElement])

  const handleAddInfoLayer = useCallback(async () => {
    try {
      const layer = await createInfoLayer(projectId, {
        infoDescription: '新的信息差',
        authorKnows: true,
        readerKnows: false,
      })
      upsertInfoLayer(layer)
    } catch (err) {
      console.error('[NovelSidebar] 创建信息差失败:', err)
    }
  }, [projectId, upsertInfoLayer])

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
          case 'faction':
            await deleteFaction(id)
            removeFaction(id)
            break
          case 'location':
            await deleteLocation(id)
            removeLocation(id)
            break
          case 'world_element':
            await deleteWorldElement(id)
            removeWorldElement(id)
            break
          case 'info_layer':
            await deleteInfoLayer(id)
            removeInfoLayer(id)
            break
        }
      } catch (err) {
        console.error('[NovelSidebar] 删除实体失败:', err)
      }
    },
    [removeCharacter, removeChapter, removeConflict, removeForeshadow, removeFaction, removeLocation, removeWorldElement, removeInfoLayer],
  )

  return (
    <div className="space-y-0.5 px-0.5">
      {/* 角色集合 */}
      <CollapsibleGroup
        kind="character"
        icon={Users}
        label="角色集合"
        count={characters.length}
        accent="text-blue-500"
        collapsed={collapsedGroups.includes('character')}
        onToggle={toggleCollapsedGroup}
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
              selected={selectedNodeId === c.id}
              onClick={() => onSelectEntity(c.id, 'character')}
              entityType="character"
              entityId={c.id}
              onDelete={() => handleDelete('character', c.id, c.name || '角色')}
            />
          ))
        )}
      </CollapsibleGroup>

      {/* 大纲树（全书大纲 / 卷 / 章）── 替换原"章节集合"分组 */}
      <div className="rounded-md">
        <div className="flex items-center gap-1.5 px-1.5 py-1">
          <BookOpen className="size-3.5 text-emerald-500 shrink-0" />
          <span className="text-xs font-medium text-text">大纲树</span>
          <Badge variant="secondary" className="ml-auto h-4 px-1 text-[10px] tabular-nums">
            {chapters.length}
          </Badge>
        </div>
        <div className="ml-1 pl-1 border-l border-border/60 mt-0.5 space-y-0.5">
          <OutlineTree
            project={project}
            volumes={volumes}
            chapters={chapters}
            onManualArrange={onManualArrange}
            onAiArrange={onAiArrange}
          />
        </div>
      </div>

      {/* 伏笔集合 */}
      <CollapsibleGroup
        kind="foreshadow"
        icon={Lightbulb}
        label="伏笔集合"
        count={foreshadows.length}
        accent="text-amber-500"
        collapsed={collapsedGroups.includes('foreshadow')}
        onToggle={toggleCollapsedGroup}
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
              selected={selectedNodeId === f.id}
              onClick={() => onSelectEntity(f.id, 'foreshadow')}
              entityType="foreshadow"
              entityId={f.id}
              onDelete={() => handleDelete('foreshadow', f.id, '伏笔')}
            />
          ))
        )}
      </CollapsibleGroup>

      {/* 冲突集合 */}
      <CollapsibleGroup
        kind="conflict"
        icon={Swords}
        label="冲突集合"
        count={conflicts.length}
        accent="text-rose-500"
        collapsed={collapsedGroups.includes('conflict')}
        onToggle={toggleCollapsedGroup}
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
              selected={selectedNodeId === c.id}
              onClick={() => onSelectEntity(c.id, 'conflict')}
              entityType="conflict"
              entityId={c.id}
              onDelete={() => handleDelete('conflict', c.id, '冲突')}
            />
          ))
        )}
      </CollapsibleGroup>

      {/* 势力集合 */}
      <CollapsibleGroup
        kind="faction"
        icon={Users}
        label="势力集合"
        count={factions.length}
        accent="text-violet-500"
        collapsed={collapsedGroups.includes('faction')}
        onToggle={toggleCollapsedGroup}
        onAdd={handleAddFaction}
        addLabel="新建势力"
      >
        {factions.length === 0 ? (
          <EmptyHint text="暂无势力" />
        ) : (
          factions.map((f) => (
            <EntityItem
              key={f.id}
              label={f.name || '未命名'}
              sublabel={f.type}
              selected={selectedNodeId === f.id}
              onClick={() => onSelectEntity(f.id, 'faction')}
              entityType="faction"
              entityId={f.id}
              onDelete={() => handleDelete('faction', f.id, f.name || '势力')}
            />
          ))
        )}
      </CollapsibleGroup>

      {/* 地点集合 */}
      <CollapsibleGroup
        kind="location"
        icon={MapPin}
        label="地点集合"
        count={locations.length}
        accent="text-cyan-500"
        collapsed={collapsedGroups.includes('location')}
        onToggle={toggleCollapsedGroup}
        onAdd={handleAddLocation}
        addLabel="新建地点"
      >
        {locations.length === 0 ? (
          <EmptyHint text="暂无地点" />
        ) : (
          locations.map((l) => (
            <EntityItem
              key={l.id}
              label={l.name || '未命名'}
              sublabel={l.type}
              selected={selectedNodeId === l.id}
              onClick={() => onSelectEntity(l.id, 'location')}
              entityType="location"
              entityId={l.id}
              onDelete={() => handleDelete('location', l.id, l.name || '地点')}
            />
          ))
        )}
      </CollapsibleGroup>

      {/* 世界观要素集合 */}
      <CollapsibleGroup
        kind="world_element"
        icon={Globe}
        label="世界观要素"
        count={worldElements.length}
        accent="text-indigo-500"
        collapsed={collapsedGroups.includes('world_element')}
        onToggle={toggleCollapsedGroup}
        onAdd={handleAddWorldElement}
        addLabel="新建世界观要素"
      >
        {worldElements.length === 0 ? (
          <EmptyHint text="暂无世界观要素" />
        ) : (
          worldElements.map((w) => (
            <EntityItem
              key={w.id}
              label={w.name || '未命名'}
              sublabel={w.category}
              selected={selectedNodeId === w.id}
              onClick={() => onSelectEntity(w.id, 'world_element')}
              entityType="world_element"
              entityId={w.id}
              onDelete={() => handleDelete('world_element', w.id, w.name || '世界观要素')}
            />
          ))
        )}
      </CollapsibleGroup>

      {/* 信息差集合（P3-2：伏笔↔信息差双向联动） */}
      <CollapsibleGroup
        kind="info_layer"
        icon={Layers}
        label="信息差集合"
        count={infoLayers.length}
        accent="text-teal-500"
        collapsed={collapsedGroups.includes('info_layer')}
        onToggle={toggleCollapsedGroup}
        onAdd={handleAddInfoLayer}
        addLabel="新建信息差"
      >
        {infoLayers.length === 0 ? (
          <EmptyHint text="暂无信息差" />
        ) : (
          infoLayers.map((l) => (
            <EntityItem
              key={l.id}
              label={l.infoDescription.length > 18 ? `${l.infoDescription.slice(0, 18)}...` : l.infoDescription}
              sublabel={l.readerKnows ? '读者已知' : '读者未知'}
              selected={selectedNodeId === l.id}
              onClick={() => onSelectEntity(l.id, 'info_layer')}
              entityType="info_layer"
              entityId={l.id}
              onDelete={() => handleDelete('info_layer', l.id, '信息差')}
            />
          ))
        )}
      </CollapsibleGroup>
    </div>
  )
}

// ── 可折叠分组 ──

interface CollapsibleGroupProps {
  /** 分组标识（用于 store 同步折叠状态） */
  kind: string
  icon: typeof Users
  label: string
  count: number
  accent: string
  collapsed: boolean
  onToggle: (kind: string) => void
  onAdd: () => void
  addLabel: string
  children: ReactElement | ReactElement[]
}

function CollapsibleGroup({
  kind,
  icon: Icon,
  label,
  count,
  accent,
  collapsed,
  onToggle,
  onAdd,
  addLabel,
  children,
}: CollapsibleGroupProps): ReactElement {
  const Chevron = collapsed ? ChevronRight : ChevronDown
  return (
    <div className="rounded-md">
      <div className="flex items-center group">
        <button
          type="button"
          onClick={() => onToggle(kind)}
          className="flex items-center gap-1.5 flex-1 min-w-0 px-1.5 py-1 rounded text-left hover:bg-muted transition-colors"
        >
          <Chevron className="size-3.5 text-muted-foreground shrink-0" />
          <Icon className={cn('size-3.5 shrink-0', accent)} />
          <span className="text-xs font-medium text-text truncate">{label}</span>
          <Badge variant="secondary" className="ml-auto h-4 px-1 text-[10px] tabular-nums">
            {count}
          </Badge>
        </button>
      </div>
      {!collapsed && (
        <div className="ml-3 pl-2 border-l border-border/60 mt-0.5 space-y-0.5">
          {Children.toArray(children)}
          <button
            key="add-button"
            type="button"
            onClick={onAdd}
            className="flex items-center gap-1.5 w-full px-1.5 py-1 rounded text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground transition-[color,background-color,transform] active:scale-[0.96]"
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
  selected?: boolean
  onClick: () => void
  /** 实体类型，用于构造拖拽数据 + 取色 */
  entityType: MatrixEntityKind
  entityId: string
  onDelete: () => void
}

function EntityItem({
  label,
  sublabel,
  selected = false,
  onClick,
  entityType,
  entityId,
  onDelete,
}: EntityItemProps): ReactElement {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `sidebar:${entityType}:${entityId}`,
    data: {
      source: 'sidebar',
      entityType,
      entityId,
      name: label,
      color: GROUP_META[entityType].color,
    } satisfies SidebarDragData,
  })
  const style: React.CSSProperties = {
    transform: transform ? CSS.Translate.toString(transform) : undefined,
    touchAction: 'none',
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onClick}
      className={cn(
        'group flex items-center gap-1.5 px-1.5 py-1 rounded text-left transition-colors cursor-grab active:cursor-grabbing',
        selected ? 'bg-primary/10' : 'hover:bg-muted',
        isDragging && 'opacity-30',
      )}
    >
      <GripVertical className="size-3 text-muted-foreground/40 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" aria-hidden="true" />
      <span className="size-1.5 rounded-full shrink-0" style={{ background: GROUP_META[entityType].color }} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className={cn('text-xs truncate', selected ? 'text-primary font-medium' : 'text-text')}>{label}</div>
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
        className="opacity-0 group-hover:opacity-100 transition-[opacity,color,transform] active:scale-[0.96] text-muted-foreground hover:text-destructive shrink-0 p-1 -m-1"
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
  characterHistory: NovelCharacterHistory[]
  selected?: boolean
  onSelectEntity: (id: string, type: NovelNodeType) => void
  onSelectChapter: (chapter: NovelChapter) => void
  onDelete: () => void
}

export function ChapterItem({
  chapter,
  characters,
  conflicts,
  foreshadows,
  characterHistory,
  selected = false,
  onSelectEntity,
  onSelectChapter,
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

  // 该章出场角色：基于角色变更历史（chapterNumber 匹配）筛选；
  // 若无历史记录则回退展示全部角色。
  const hasHistory = characterHistory.length > 0
  const chapterCharacters = useMemo(() => {
    if (!hasHistory) return characters
    const charIds = new Set(
      characterHistory
        .filter((h) => h.chapterNumber === chapter.chapterNumber)
        .map((h) => h.characterId),
    )
    return characters.filter((c) => charIds.has(c.id))
  }, [characters, characterHistory, chapter.chapterNumber, hasHistory])

  // 该章关联冲突：按参与者与本章出场角色交集筛选；
  // 若无历史记录则回退展示全部冲突。
  const chapterConflicts = useMemo(() => {
    if (!hasHistory) return conflicts
    const charIds = new Set(chapterCharacters.map((c) => c.id))
    return conflicts.filter((c) => {
      try {
        const p = JSON.parse(c.participants)
        if (!Array.isArray(p)) return false
        return p.some((id: unknown) => typeof id === 'string' && charIds.has(id))
      } catch {
        return false
      }
    })
  }, [conflicts, chapterCharacters, hasHistory])

  return (
    <div>
      <div
        className={cn(
          'group flex items-center gap-1.5 px-1.5 py-1 rounded text-left transition-colors cursor-pointer',
          selected ? 'bg-primary/10' : 'hover:bg-muted',
        )}
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
          onClick={() => onSelectChapter(chapter)}
        >
          <div className={cn('text-xs truncate', selected ? 'text-primary font-medium' : 'text-text')}>
            <span className="text-muted-foreground tabular-nums">第 {chapter.chapterNumber} 章</span> · {title}
          </div>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          title="删除"
          className="opacity-0 group-hover:opacity-100 transition-[opacity,color,transform] active:scale-[0.96] text-muted-foreground hover:text-destructive shrink-0 p-1 -m-1"
        >
          <Trash2 className="size-3" />
        </button>
      </div>

      {expanded && (
        <div className="ml-3 pl-2 border-l border-border/60 mt-0.5 space-y-1">
          {/* 出场角色 */}
          <div>
            <div className="text-[10px] text-muted-foreground px-1.5 py-0.5 tabular-nums">
              出场角色（{chapterCharacters.length}）
            </div>
            {chapterCharacters.length === 0 ? (
              <div className="text-[10px] text-muted-foreground/70 px-1.5 py-0.5">
                本章无出场角色
              </div>
            ) : (
              <div className="space-y-0.5">
                {chapterCharacters.map((c) => (
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
            <div className="text-[10px] text-muted-foreground px-1.5 py-0.5 tabular-nums">
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

          {/* 章节关联冲突 */}
          <div>
            <div className="text-[10px] text-muted-foreground px-1.5 py-0.5 tabular-nums">
              冲突（{chapterConflicts.length}）
            </div>
            {chapterConflicts.length === 0 ? (
              <div className="text-[10px] text-muted-foreground/70 px-1.5 py-0.5">
                本章无关联冲突
              </div>
            ) : (
              <div className="space-y-0.5">
                {chapterConflicts.map((c) => (
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

// ── 回收站对话框 ──

interface TrashDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 项目恢复后回调（用于刷新项目列表） */
  onRestored?: () => void
}

function TrashDialog({ open, onOpenChange, onRestored }: TrashDialogProps): ReactElement {
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
                    <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-muted-foreground">
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

// ── 空提示 ──

function EmptyHint({ text }: { text: string }): ReactElement {
  return <div className="text-[10px] text-muted-foreground/70 px-1.5 py-1">{text}</div>
}
