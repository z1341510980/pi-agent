import { Children, useCallback, type ReactElement, type ReactNode } from 'react'
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
  Film,
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
  deleteNarrative,
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
  type NovelFaction,
  type NovelLocation,
  type NovelWorldElement,
  type NovelInformationLayer,
  type NovelItem,
  type NovelNarrative,
  createInfoLayer,
  deleteInfoLayer,
} from '@/api/novel-client'
import { OutlineTree } from '../outline-tree'
import { GROUP_META, type MatrixEntityKind, type SidebarDragData } from '../matrix/matrix-logic'
import { type DraggableEntityType } from './sidebar-constants'
import { EmptyHint } from './empty-hint'
import { BeatPlanGroup } from './beat-plan-group'
import { useBeatPlansLoader } from '@/hooks/use-beat-plans'

// ── 项目分组树 ──

/** 剧情类型中文标签（与矩阵 matrix-model 同源） */
const NARRATIVE_TYPE_LABELS: Record<string, string> = {
  advance: '剧情推进',
  turn: '转折',
  reversal: '反转',
  suspense: '悬念',
  resolve: '收束',
  setup: '铺垫',
  reveal: '揭示',
  misc: '其他事件',
}

export interface ProjectTreeProps {
  projectId: string
  project: NovelProject
  characters: NovelCharacter[]
  chapters: NovelChapter[]
  volumes: NovelVolume[]
  narratives: NovelNarrative[]
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
  narratives,
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
  // 节拍表共享数据源：挂在常驻的 ProjectTree 上（分组折叠即卸载，不能依赖它加载）
  const { reload: reloadBeats } = useBeatPlansLoader(projectId)
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
  const removeNarrative = useNovelDataStore((s) => s.removeNarrative)
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
      /** 调用方已自带更具体的确认弹窗（如章节行的重排提示）时跳过通用确认 */
      skipConfirm = false,
    ) => {
      if (!skipConfirm && !window.confirm(`确认删除「${label}」？此操作不可撤销。`)) return
      try {
        switch (type) {
          case 'character':
            await deleteCharacter(id)
            removeCharacter(id)
            break
          case 'chapter': {
            // 已发布章的 409 约束在前端预检查（后端仍兜底）；
            // 运行中的创作流程锁定由后端 409 返回，catch 里呈现给用户
            const target = chapters.find((c) => c.id === id)
            if (target?.status === 'published') {
              window.alert('已发布章节不能删除，请先进入修订或撤回流程。')
              return
            }
            try {
              await deleteChapter(id)
              removeChapter(id)
              // 删章会触发后端节拍重排（章号左移），重拉保持徽标同步
              void reloadBeats()
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              window.alert(`删除章节失败：${message}`)
              throw err
            }
            break
          }
          case 'narrative':
            await deleteNarrative(id)
            removeNarrative(id)
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
    [chapters, removeCharacter, removeChapter, removeNarrative, removeConflict, removeClue, removeForeshadow, removeFaction, removeLocation, removeWorldElement, removeInfoLayer, removeItem],
  )

  return (
    <div className="space-y-0.5 px-0.5">
      {/* 大纲树（全书大纲 / 卷 / 章）── 结构骨架，置顶 */}
      <CollapsibleGroup
        kind="outline"
        icon={BookOpen}
        label="大纲树"
        count={chapters.length}
        accent="text-emerald-500"
        collapsed={collapsedGroups.includes('outline')}
        onToggle={toggleCollapsedGroup}
        onAdd={() => {}}
        addLabel=""
        hideAdd
      >
        <OutlineTree
          project={project}
          volumes={volumes}
          chapters={chapters}
          onManualArrange={onManualArrange}
          onAiArrange={onAiArrange}
          onDeleteChapter={(ch) => void handleDelete('chapter', ch.id, ch.title || `第${ch.chapterNumber}章`, true)}
        />
      </CollapsibleGroup>

      {/* 节拍表（卷级戏剧结构规划，P0-1）── 紧跟大纲树，同属结构层 */}
      <BeatPlanGroup projectId={projectId} volumes={volumes} />

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

      {/* 剧情轨道（矩阵「剧情」行同源：编排/AI 编排生成的跨章事件线） */}
      <CollapsibleGroup
        kind="narrative"
        icon={Film}
        label="剧情"
        count={narratives.length}
        accent="text-teal-600"
        collapsed={collapsedGroups.includes('narrative')}
        onToggle={toggleCollapsedGroup}
        onAdd={() => {}}
        addLabel=""
        hideAdd
      >
        {narratives.length === 0 ? (
          <EmptyHint text="暂无剧情（AI 编排会自动生成，也可在矩阵中手动新建）" />
        ) : (
          narratives.map((n) => (
            <EntityItem
              key={n.id}
              label={n.description.length > 18 ? `${n.description.slice(0, 18)}...` : n.description}
              sublabel={NARRATIVE_TYPE_LABELS[n.type] ?? n.type}
              selected={selectedNodeId === n.id}
              onClick={() => onSelectEntity(n.id, 'narrative')}
              entityType="narrative"
              entityId={n.id}
              onDelete={() => handleDelete('narrative', n.id, '剧情')}
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

      {/* 线索集合 */}
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

      {/* 信息差集合 */}
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
  /** 隐藏底部"新建"按钮（如大纲树无需手动添加） */
  hideAdd?: boolean
  children: ReactNode
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
  hideAdd = false,
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
          <ChevronDown
            className={cn(
              'size-3.5 text-muted-foreground shrink-0 transition-transform duration-200 ease-out',
              collapsed && '-rotate-90',
            )}
          />
          <Icon className={cn('size-3.5 shrink-0', accent)} />
          <span className="text-xs font-medium text-text truncate">{label}</span>
          <Badge variant="secondary" className="ml-auto h-4 px-1 text-nano tabular-nums">
            {count}
          </Badge>
        </button>
      </div>
      {!collapsed && (
        <div className="ml-3 pl-2 border-l border-border/60 mt-0.5 space-y-0.5">
          {Children.toArray(children)}
          {!hideAdd && (
            <button
              key="add-button"
              type="button"
              onClick={onAdd}
              className="flex items-center gap-1.5 w-full px-1.5 py-1 rounded-lg text-micro text-muted-foreground hover:bg-muted hover:text-foreground transition-[color,background-color,transform] duration-200 ease-out active:scale-[0.96]"
            >
              <Plus className="size-3" />
              <span>{addLabel}</span>
            </button>
          )}
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
          <div className="text-nano text-muted-foreground truncate">{sublabel}</div>
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
