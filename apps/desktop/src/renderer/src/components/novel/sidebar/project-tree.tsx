import { Children, useCallback, useMemo, useState, type ReactElement } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import {
  BookOpen,
  Plus,
  Users,
  Lightbulb,
  Swords,
  ChevronDown,
  Trash2,
  MapPin,
  Globe,
  GripVertical,
  Layers,
  Search,
  Gem,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { useNovelDataStore } from '@/stores/novel-data-store'
import { useNovelUiStore, type NovelNodeType } from '@/stores/novel-ui-store'
import {
  createConflict,
  createClue,
  createForeshadow,
  createFaction,
  createLocation,
  createWorldElement,
  createItem,
  deleteCharacter,
  deleteChapter,
  deleteConflict,
  deleteClue,
  deleteForeshadow,
  deleteFaction,
  deleteLocation,
  deleteWorldElement,
  deleteItem,
  type NovelProject,
  type NovelCharacter,
  type NovelChapter,
  type NovelVolume,
  type NovelConflict,
  type NovelClue,
  type NovelForeshadow,
  type NovelCharacterHistory,
  type NovelFaction,
  type NovelLocation,
  type NovelWorldElement,
  type NovelInformationLayer,
  type NovelItem,
  createInfoLayer,
  deleteInfoLayer,
} from '@/api/novel-client'
import { OutlineTree } from '../outline-tree'
import { GROUP_META, type MatrixEntityKind, type SidebarDragData } from '../matrix/matrix-logic'
import { type DraggableEntityType } from './sidebar-constants'
import { EmptyHint } from './empty-hint'

// ── 项目分组树 ──

export interface ProjectTreeProps {
  projectId: string
  project: NovelProject
  characters: NovelCharacter[]
  chapters: NovelChapter[]
  volumes: NovelVolume[]
  conflicts: NovelConflict[]
  clues: NovelClue[]
  foreshadows: NovelForeshadow[]
  factions: NovelFaction[]
  locations: NovelLocation[]
  worldElements: NovelWorldElement[]
  infoLayers: NovelInformationLayer[]
  items: NovelItem[]
  onSelectEntity: (id: string, type: NovelNodeType) => void
  onOpenCharacterDialog: () => void
  onManualArrange: (chapter: NovelChapter) => void
  onAiArrange: (chapter: NovelChapter) => void
}

export function ProjectTree({
  projectId,
  project,
  characters,
  chapters,
  volumes,
  conflicts,
  clues,
  foreshadows,
  factions,
  locations,
  worldElements,
  infoLayers,
  items,
  onSelectEntity,
  onOpenCharacterDialog,
  onManualArrange,
  onAiArrange,
}: ProjectTreeProps): ReactElement {
  const upsertConflict = useNovelDataStore((s) => s.upsertConflict)
  const upsertClue = useNovelDataStore((s) => s.upsertClue)
  const upsertForeshadow = useNovelDataStore((s) => s.upsertForeshadow)
  const upsertFaction = useNovelDataStore((s) => s.upsertFaction)
  const upsertLocation = useNovelDataStore((s) => s.upsertLocation)
  const upsertWorldElement = useNovelDataStore((s) => s.upsertWorldElement)
  const upsertInfoLayer = useNovelDataStore((s) => s.upsertInfoLayer)
  const upsertItem = useNovelDataStore((s) => s.upsertItem)
  const removeCharacter = useNovelDataStore((s) => s.removeCharacter)
  const removeChapter = useNovelDataStore((s) => s.removeChapter)
  const removeConflict = useNovelDataStore((s) => s.removeConflict)
  const removeClue = useNovelDataStore((s) => s.removeClue)
  const removeForeshadow = useNovelDataStore((s) => s.removeForeshadow)
  const removeFaction = useNovelDataStore((s) => s.removeFaction)
  const removeLocation = useNovelDataStore((s) => s.removeLocation)
  const removeWorldElement = useNovelDataStore((s) => s.removeWorldElement)
  const removeInfoLayer = useNovelDataStore((s) => s.removeInfoLayer)
  const removeItem = useNovelDataStore((s) => s.removeItem)
  // ── C-3 与 MatrixView 共享的折叠 / 选中 / 章节滚动信号 ──
  const selectedNodeId = useNovelUiStore((s) => s.selectedNodeId)
  const collapsedGroups = useNovelUiStore((s) => s.collapsedGroups)
  const toggleCollapsedGroup = useNovelUiStore((s) => s.toggleCollapsedGroup)

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

  const handleAddClue = useCallback(async () => {
    try {
      const clue = await createClue(projectId, {
        description: '新的线索',
        pointsTo: '待确认',
        progress: 0,
        currentStep: '',
        nextStep: '',
        isMisleading: false,
        chapterSpans: [],
      })
      upsertClue(clue)
    } catch (err) {
      console.error('[NovelSidebar] 创建线索失败:', err)
    }
  }, [projectId, upsertClue])

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

  const handleAddItem = useCallback(async () => {
    try {
      const item = await createItem(projectId, {
        name: '新物品',
        description: '',
        type: 'misc',
        status: 'active',
        abilities: '',
        origin: '',
        ownerId: null,
        firstChapter: null,
        chapterSpans: [],
      })
      upsertItem(item)
    } catch (err) {
      console.error('[NovelSidebar] 创建物品失败:', err)
    }
  }, [projectId, upsertItem])

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
          case 'clue':
            await deleteClue(id)
            removeClue(id)
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
          case 'item':
            await deleteItem(id)
            removeItem(id)
            break
        }
      } catch (err) {
        console.error('[NovelSidebar] 删除实体失败:', err)
      }
    },
    [removeCharacter, removeChapter, removeConflict, removeClue, removeForeshadow, removeFaction, removeLocation, removeWorldElement, removeInfoLayer, removeItem],
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

      {/* 线索集合：普通证据/调查进展，与需要回收的伏笔分开 */}
      <CollapsibleGroup
        kind="clue"
        icon={Search}
        label="线索集合"
        count={clues.length}
        accent="text-green-500"
        collapsed={collapsedGroups.includes('clue')}
        onToggle={toggleCollapsedGroup}
        onAdd={handleAddClue}
        addLabel="新建线索"
      >
        {clues.length === 0 ? (
          <EmptyHint text="暂无线索" />
        ) : (
          clues.map((clue) => (
            <EntityItem
              key={clue.id}
              label={clue.description.length > 18 ? `${clue.description.slice(0, 18)}...` : clue.description}
              sublabel={`${clue.progress}% · ${clue.isMisleading ? '误导' : '真实'}`}
              selected={selectedNodeId === clue.id}
              onClick={() => onSelectEntity(clue.id, 'clue')}
              entityType="clue"
              entityId={clue.id}
              onDelete={() => handleDelete('clue', clue.id, '线索')}
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

      {/* 物品集合 */}
      <CollapsibleGroup
        kind="item"
        icon={Gem}
        label="物品集合"
        count={items.length}
        accent="text-amber-600"
        collapsed={collapsedGroups.includes('item')}
        onToggle={toggleCollapsedGroup}
        onAdd={handleAddItem}
        addLabel="新建物品"
      >
        {items.length === 0 ? (
          <EmptyHint text="暂无物品" />
        ) : (
          items.map((it) => (
            <EntityItem
              key={it.id}
              label={it.name || '未命名'}
              sublabel={it.type}
              selected={selectedNodeId === it.id}
              onClick={() => onSelectEntity(it.id, 'item')}
              entityType="item"
              entityId={it.id}
              onDelete={() => handleDelete('item', it.id, it.name || '物品')}
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

export function CollapsibleGroup({
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
  return (
    <div className="rounded-lg">
      <div className="flex items-center group">
        <button
          type="button"
          onClick={() => onToggle(kind)}
          className="flex items-center gap-1.5 flex-1 min-w-0 px-1.5 py-1 rounded-lg text-left hover:bg-muted transition-colors duration-150 ease-out"
        >
          {/* chevron 旋转动画：始终用 ChevronDown，折叠时 rotate(-90deg)，200ms ease-out */}
          <ChevronDown
            className={cn(
              'size-3.5 text-muted-foreground shrink-0 transition-transform duration-200 ease-out',
              collapsed && '-rotate-90',
            )}
          />
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
            className="flex items-center gap-1.5 w-full px-1.5 py-1 rounded-lg text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground transition-[color,background-color,transform] duration-200 ease-out active:scale-[0.96]"
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

export interface EntityItemProps {
  label: string
  sublabel?: string
  selected?: boolean
  onClick: () => void
  /** 实体类型，用于构造拖拽数据 + 取色 */
  entityType: MatrixEntityKind
  entityId: string
  onDelete: () => void
}

export function EntityItem({
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
        'group flex items-center gap-1.5 px-1.5 py-1 rounded-lg text-left transition-colors duration-150 ease-out cursor-grab active:cursor-grabbing',
        selected ? 'bg-primary/[0.08]' : 'hover:bg-muted',
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

export interface ChapterItemProps {
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
          <ChevronDown
            className={cn(
              'size-3.5 transition-transform duration-200 ease-out',
              !expanded && '-rotate-90',
            )}
          />
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
