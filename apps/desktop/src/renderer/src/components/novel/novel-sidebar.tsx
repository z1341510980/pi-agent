import { Children, useCallback, useMemo, useState, type ReactElement } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
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
} from '@/api/novel-client'
import { CharacterCreateDialog } from './character-create-dialog'
import { OutlineTree } from './outline-tree'

// ── 通用节点类型（用于拖拽） ──

type DraggableEntityType = 'character' | 'chapter' | 'foreshadow' | 'conflict' | 'faction' | 'location' | 'world_element'

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
  const volumes = useNovelStore((s) => s.volumes)
  const conflicts = useNovelStore((s) => s.conflicts)
  const foreshadows = useNovelStore((s) => s.foreshadows)
  const factions = useNovelStore((s) => s.factions)
  const locations = useNovelStore((s) => s.locations)
  const worldElements = useNovelStore((s) => s.worldElements)
  const selectNode = useNovelStore((s) => s.selectNode)

  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [characterDialogOpen, setCharacterDialogOpen] = useState(false)
  const [form, setForm] = useState({ title: '', genre: '', synopsis: '', targetWords: '300000' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 大纲树编排入口占位（D-3 接入实际创作流程）
  const handleManualArrange = useCallback((_chapter: NovelChapter) => {
    // D-3 将接入手动编排流程
    console.log('[NovelSidebar] 手动编排（D-3 待接入）:', _chapter.id)
  }, [])
  const handleAiArrange = useCallback((_chapter: NovelChapter) => {
    // D-4 将接入 AI 编排流程
    console.log('[NovelSidebar] AI编排（D-4 待接入）:', _chapter.id)
  }, [])

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
                  project={currentProject}
                  characters={characters}
                  chapters={chapters}
                  volumes={volumes}
                  conflicts={conflicts}
                  foreshadows={foreshadows}
                  factions={factions}
                  locations={locations}
                  worldElements={worldElements}
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
  project: NovelProject
  characters: NovelCharacter[]
  chapters: NovelChapter[]
  volumes: NovelVolume[]
  conflicts: NovelConflict[]
  foreshadows: NovelForeshadow[]
  factions: NovelFaction[]
  locations: NovelLocation[]
  worldElements: NovelWorldElement[]
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
  onSelectEntity,
  onOpenCharacterDialog,
  onManualArrange,
  onAiArrange,
}: ProjectTreeProps): ReactElement {
  const upsertChapter = useNovelStore((s) => s.upsertChapter)
  const upsertConflict = useNovelStore((s) => s.upsertConflict)
  const upsertForeshadow = useNovelStore((s) => s.upsertForeshadow)
  const upsertFaction = useNovelStore((s) => s.upsertFaction)
  const upsertLocation = useNovelStore((s) => s.upsertLocation)
  const upsertWorldElement = useNovelStore((s) => s.upsertWorldElement)
  const removeCharacter = useNovelStore((s) => s.removeCharacter)
  const removeChapter = useNovelStore((s) => s.removeChapter)
  const removeConflict = useNovelStore((s) => s.removeConflict)
  const removeForeshadow = useNovelStore((s) => s.removeForeshadow)
  const removeFaction = useNovelStore((s) => s.removeFaction)
  const removeLocation = useNovelStore((s) => s.removeLocation)
  const removeWorldElement = useNovelStore((s) => s.removeWorldElement)
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
        category: '事件',
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
        }
      } catch (err) {
        console.error('[NovelSidebar] 删除实体失败:', err)
      }
    },
    [removeCharacter, removeChapter, removeConflict, removeForeshadow, removeFaction, removeLocation, removeWorldElement],
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
              onDragStart={(e) => setDragData(e, 'character', c.id)}
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
          <Badge variant="secondary" className="ml-auto h-4 px-1 text-[10px]">
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
              onDragStart={(e) => setDragData(e, 'foreshadow', f.id)}
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
              onDragStart={(e) => setDragData(e, 'conflict', c.id)}
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
              onDragStart={(e) => setDragData(e, 'faction', f.id)}
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
              onDragStart={(e) => setDragData(e, 'location', l.id)}
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
              onDragStart={(e) => setDragData(e, 'world_element', w.id)}
              onDelete={() => handleDelete('world_element', w.id, w.name || '世界观要素')}
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
          <Badge variant="secondary" className="ml-auto h-4 px-1 text-[10px]">
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
  selected?: boolean
  onClick: () => void
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void
  onDelete: () => void
}

function EntityItem({
  label,
  sublabel,
  selected = false,
  onClick,
  onDragStart,
  onDelete,
}: EntityItemProps): ReactElement {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      className={cn(
        'group flex items-center gap-1.5 px-1.5 py-1 rounded text-left transition-colors cursor-pointer',
        selected ? 'bg-primary/10' : 'hover:bg-muted',
      )}
    >
      <span className="size-1 rounded-full bg-muted-foreground/40 shrink-0" aria-hidden="true" />
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
  characterHistory: NovelCharacterHistory[]
  selected?: boolean
  onSelectEntity: (id: string, type: NovelNodeType) => void
  onSelectChapter: (chapter: NovelChapter) => void
  onDelete: () => void
}

function ChapterItem({
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
        draggable
        onDragStart={(e) => setDragData(e, 'chapter', chapter.id)}
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
          {/* 出场角色 */}
          <div>
            <div className="text-[10px] text-muted-foreground px-1.5 py-0.5">
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

          {/* 章节关联冲突 */}
          <div>
            <div className="text-[10px] text-muted-foreground px-1.5 py-0.5">
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

// ── 空提示 ──

function EmptyHint({ text }: { text: string }): ReactElement {
  return <div className="text-[10px] text-muted-foreground/70 px-1.5 py-1">{text}</div>
}
