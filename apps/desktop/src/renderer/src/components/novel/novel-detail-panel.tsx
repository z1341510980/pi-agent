import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { Clock, Eye, Info, MoreHorizontal, Pencil, Trash2, X } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useNovelDataStore } from '@/stores/novel-data-store'
import { useNovelUiStore, type NovelNodeType } from '@/stores/novel-ui-store'
import {
  deleteChapter,
  deleteCharacter,
  deleteClue,
  deleteConflict,
  deleteFaction,
  deleteForeshadow,
  deleteInfoLayer,
  deleteItem,
  deleteLocation,
  deleteNarrative,
  deleteProject,
  deleteVolume,
  deleteWorldElement,
  getEntityStoryTimeline,
  type NovelChapter,
  type NovelCharacter,
  type NovelClue,
  type NovelConflict,
  type NovelFaction,
  type NovelForeshadow,
  type NovelInformationLayer,
  type NovelItem,
  type NovelLocation,
  type NovelStoryEntityType,
  type NovelVolume,
  type NovelWorldElement
} from '@/api/novel-client'
import { entityTitle, NODE_TYPE_LABELS } from './detail-forms/shared'
import { DetailPanelEditProvider } from './detail-panel-edit-context'
import {
  EntityOverview,
  getDetailEntityPresentation,
  type DetailEntityType
} from './detail-overview'
// (ProjectForm moved to SettingsPanel; project type no longer rendered here)
import { CharacterForm } from './detail-forms/character-form'
import { ChapterForm, VolumeForm } from './detail-forms/chapter-form'
import { ConflictForm } from './detail-forms/conflict-form'
import { ClueForm } from './detail-forms/clue-form'
import { ForeshadowForm } from './detail-forms/foreshadow-form'
import { InfoLayerForm } from './detail-forms/info-layer-form'
import { FactionForm } from './detail-forms/faction-form'
import { LocationForm } from './detail-forms/location-form'
import { WorldElementForm } from './detail-forms/world-element-form'
import { ItemForm } from './detail-forms/item-form'

type PanelMode = 'overview' | 'edit'
type Selection = { id: string; type: DetailEntityType }
type PendingAction =
  | { kind: 'overview' }
  | { kind: 'close' }
  | { kind: 'selection'; next: Selection | null }

type SupportedStoryEntityType = Extract<DetailEntityType, NovelStoryEntityType>

const STORY_ENTITY_TYPES: readonly SupportedStoryEntityType[] = [
  'character',
  'chapter',
  'conflict',
  'clue',
  'foreshadow',
  'faction',
  'location',
  'world_element',
  'info_layer',
  'item'
]

function sameSelection(left: Selection | null, right: Selection | null): boolean {
  return left?.id === right?.id && left?.type === right?.type
}

function isDetailEntityType(type: NovelNodeType | null): type is DetailEntityType {
  return type != null && type !== 'group'
}

function isStoryEntityType(type: DetailEntityType): type is SupportedStoryEntityType {
  return (STORY_ENTITY_TYPES as readonly string[]).includes(type)
}

/**
 * 创作流程进行中。
 *
 * 详情面板仍可查看与编辑，但当前章节的生成上下文已经确定，改动在下一次创作生效。
 */
export interface NovelDetailPanelProps {
  creationActive?: boolean
}

export function NovelDetailPanel({
  creationActive = false
}: NovelDetailPanelProps = {}): ReactElement {
  const selectedNodeId = useNovelUiStore((s) => s.selectedNodeId)
  const selectedNodeType = useNovelUiStore((s) => s.selectedNodeType)
  const selectNode = useNovelUiStore((s) => s.selectNode)
  const clearSelection = useNovelUiStore((s) => s.clearSelection)

  const currentProjectId = useNovelDataStore((s) => s.currentProjectId)
  const projects = useNovelDataStore((s) => s.projects)
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
  const narratives = useNovelDataStore((s) => s.narratives)

  const removeProject = useNovelDataStore((s) => s.removeProject)
  const removeCharacter = useNovelDataStore((s) => s.removeCharacter)
  const removeChapter = useNovelDataStore((s) => s.removeChapter)
  const removeVolume = useNovelDataStore((s) => s.removeVolume)
  const removeConflict = useNovelDataStore((s) => s.removeConflict)
  const removeClue = useNovelDataStore((s) => s.removeClue)
  const removeForeshadow = useNovelDataStore((s) => s.removeForeshadow)
  const removeFaction = useNovelDataStore((s) => s.removeFaction)
  const removeLocation = useNovelDataStore((s) => s.removeLocation)
  const removeWorldElement = useNovelDataStore((s) => s.removeWorldElement)
  const removeInfoLayer = useNovelDataStore((s) => s.removeInfoLayer)
  const removeItem = useNovelDataStore((s) => s.removeItem)
  const removeNarrative = useNovelDataStore((s) => s.removeNarrative)
  const upsertChapter = useNovelDataStore((s) => s.upsertChapter)

  const selected = useMemo<Selection | null>(() => {
    return selectedNodeId && isDetailEntityType(selectedNodeType)
      ? { id: selectedNodeId, type: selectedNodeType }
      : null
  }, [selectedNodeId, selectedNodeType])
  const [activeSelection, setActiveSelection] = useState<Selection | null>(null)
  const [mode, setMode] = useState<PanelMode>('overview')
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  useEffect(() => {
    if (sameSelection(selected, activeSelection)) return

    if (activeSelection && mode === 'edit' && hasUnsavedChanges) {
      setPendingAction({ kind: 'selection', next: selected })
      selectNode(activeSelection.id, activeSelection.type)
      return
    }

    setActiveSelection(selected)
    setMode('overview')
    setHasUnsavedChanges(false)
  }, [activeSelection, hasUnsavedChanges, mode, selectNode, selected])

  const entity = useMemo(() => {
    if (!activeSelection) return null
    const { id, type } = activeSelection
    switch (type) {
      case 'project':
        return projects.find((project) => project.id === id) ?? null
      case 'character':
        return characters.find((character) => character.id === id) ?? null
      case 'chapter':
        return chapters.find((chapter) => chapter.id === id) ?? null
      case 'volume':
        return volumes.find((volume) => volume.id === id) ?? null
      case 'conflict':
        return conflicts.find((conflict) => conflict.id === id) ?? null
      case 'clue':
        return clues.find((clue) => clue.id === id) ?? null
      case 'foreshadow':
        return foreshadows.find((foreshadow) => foreshadow.id === id) ?? null
      case 'faction':
        return factions.find((faction) => faction.id === id) ?? null
      case 'location':
        return locations.find((location) => location.id === id) ?? null
      case 'world_element':
        return worldElements.find((element) => element.id === id) ?? null
      case 'info_layer':
        return infoLayers.find((layer) => layer.id === id) ?? null
      case 'item':
        return items.find((item) => item.id === id) ?? null
      case 'narrative':
        return narratives.find((narrative) => narrative.id === id) ?? null
    }
  }, [
    activeSelection,
    characters,
    chapters,
    clues,
    conflicts,
    factions,
    foreshadows,
    infoLayers,
    items,
    locations,
    narratives,
    projects,
    volumes,
    worldElements
  ])

  const storyEntityType =
    activeSelection && isStoryEntityType(activeSelection.type) ? activeSelection.type : null
  const timelineQuery = useQuery({
    queryKey: ['entity-story-timeline', currentProjectId, storyEntityType, activeSelection?.id],
    queryFn: async () => {
      if (!currentProjectId || !storyEntityType || !activeSelection)
        throw new Error('缺少实体时间线参数')
      return getEntityStoryTimeline(currentProjectId, storyEntityType, activeSelection.id)
    },
    enabled: Boolean(currentProjectId && storyEntityType && activeSelection)
  })

  const completeAction = useCallback(
    (action: PendingAction) => {
      setHasUnsavedChanges(false)
      setPendingAction(null)

      if (action.kind === 'overview') {
        setMode('overview')
        return
      }
      if (action.kind === 'close') {
        clearSelection()
        setActiveSelection(null)
        setMode('overview')
        return
      }

      selectNode(action.next?.id ?? null, action.next?.type ?? null)
      setActiveSelection(action.next)
      setMode('overview')
    },
    [clearSelection, selectNode]
  )

  const requestAction = useCallback(
    (action: PendingAction) => {
      if (mode === 'edit' && hasUnsavedChanges) {
        setPendingAction(action)
        return
      }
      completeAction(action)
    },
    [completeAction, hasUnsavedChanges, mode]
  )

  const handleDelete = useCallback(async () => {
    if (!activeSelection) return
    setDeleting(true)
    setDeleteError(null)

    try {
      switch (activeSelection.type) {
        case 'project':
          await deleteProject(activeSelection.id)
          removeProject(activeSelection.id)
          break
        case 'character':
          await deleteCharacter(activeSelection.id)
          removeCharacter(activeSelection.id)
          break
        case 'chapter':
          await deleteChapter(activeSelection.id)
          removeChapter(activeSelection.id)
          break
        case 'volume':
          await deleteVolume(activeSelection.id)
          removeVolume(activeSelection.id)
          chapters
            .filter((chapter) => chapter.volumeId === activeSelection.id)
            .forEach((chapter) => {
              upsertChapter({ ...chapter, volumeId: null })
            })
          break
        case 'conflict':
          await deleteConflict(activeSelection.id)
          removeConflict(activeSelection.id)
          break
        case 'clue':
          await deleteClue(activeSelection.id)
          removeClue(activeSelection.id)
          break
        case 'foreshadow':
          await deleteForeshadow(activeSelection.id)
          removeForeshadow(activeSelection.id)
          break
        case 'faction':
          await deleteFaction(activeSelection.id)
          removeFaction(activeSelection.id)
          break
        case 'location':
          await deleteLocation(activeSelection.id)
          removeLocation(activeSelection.id)
          break
        case 'world_element':
          await deleteWorldElement(activeSelection.id)
          removeWorldElement(activeSelection.id)
          break
        case 'info_layer':
          await deleteInfoLayer(activeSelection.id)
          removeInfoLayer(activeSelection.id)
          break
        case 'item':
          await deleteItem(activeSelection.id)
          removeItem(activeSelection.id)
          break
        case 'narrative':
          await deleteNarrative(activeSelection.id)
          removeNarrative(activeSelection.id)
          break
      }

      clearSelection()
      setActiveSelection(null)
      setMode('overview')
      setDeleteOpen(false)
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : '删除失败，请稍后重试')
    } finally {
      setDeleting(false)
    }
  }, [
    activeSelection,
    chapters,
    clearSelection,
    removeCharacter,
    removeChapter,
    removeClue,
    removeConflict,
    removeFaction,
    removeForeshadow,
    removeInfoLayer,
    removeItem,
    removeLocation,
    removeNarrative,
    removeProject,
    removeVolume,
    removeWorldElement,
    upsertChapter
  ])

  if (!entity || !activeSelection) {
    return (
      <div className="pi-side-panel flex h-full flex-col items-center justify-center gap-3 bg-surface-1 p-6 text-center">
        <div className="flex size-10 items-center justify-center rounded-lg bg-surface-2 shadow-[var(--shadow-border)]">
          <Info className="size-4 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium text-text">未选择实体</p>
          <p className="text-micro leading-relaxed text-muted-foreground">
            在左侧边栏或时间线矩阵中点击任一实体，即可在此查看详情。
          </p>
        </div>
      </div>
    )
  }

  const typeLabel = NODE_TYPE_LABELS[activeSelection.type] ?? activeSelection.type
  const title = entityTitle(entity, activeSelection.type) || '（未命名）'
  const timeline = timelineQuery.data
  // changes/events 用可选链而非 `timeline?.changes.length`：
  // 后端返回部分字段（或测试里 mock 了别的响应形状）时，只护住 timeline
  // 会在这里直接抛 TypeError 把整个详情面板打白。
  const changeCount = timeline?.changes?.length ?? 0
  const eventCount = timeline?.events?.length ?? 0
  const presentation = getDetailEntityPresentation(activeSelection.type)
  const EntityIcon = presentation.icon

  return (
    <div className="pi-side-panel flex h-full flex-col bg-surface-1">
      <header className="relative z-10 flex shrink-0 items-start gap-2.5 border-b border-border/75 bg-surface-1 px-3 py-3 shadow-[0_1px_0_rgba(0,0,0,0.02)]">
        <span
          className={`flex size-9 shrink-0 items-center justify-center rounded-lg shadow-[inset_0_0_0_1px_color-mix(in_srgb,currentColor_12%,transparent)] ${presentation.tone}`}
        >
          <EntityIcon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-nano font-medium tracking-[0.05em] text-muted-foreground">
              {typeLabel}
            </span>
            {mode === 'edit' && hasUnsavedChanges && (
              <span className="shrink-0 text-nano font-medium text-amber-700 dark:text-amber-400">
                未保存
              </span>
            )}
          </div>
          <h2
            className="mt-0.5 truncate text-heading font-semibold leading-snug text-text"
            title={title}
          >
            {title}
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <div
            role="tablist"
            aria-label="详情视图模式"
            className="flex h-8 items-center rounded-lg bg-surface-2 p-0.5 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-border)_66%,transparent)]"
          >
            <Button
              type="button"
              role="tab"
              aria-selected={mode === 'overview'}
              size="xs"
              variant="ghost"
              onClick={() => requestAction({ kind: 'overview' })}
              className={`h-7 gap-1 rounded-md px-1.5 text-nano ${
                mode === 'overview'
                  ? 'bg-surface-1 text-text shadow-[0_1px_2px_rgba(0,0,0,0.08)] hover:bg-surface-1'
                  : 'text-muted-foreground hover:bg-transparent hover:text-text'
              }`}
            >
              <Eye className="size-3" />
              概览
            </Button>
            <Button
              type="button"
              role="tab"
              aria-selected={mode === 'edit'}
              size="xs"
              variant="ghost"
              onClick={() => setMode('edit')}
              className={`h-7 gap-1 rounded-md px-1.5 text-nano ${
                mode === 'edit'
                  ? 'bg-surface-1 text-text shadow-[0_1px_2px_rgba(0,0,0,0.08)] hover:bg-surface-1'
                  : 'text-muted-foreground hover:bg-transparent hover:text-text'
              }`}
            >
              <Pencil className="size-3" />
              编辑
            </Button>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="更多操作"
                className="size-8 text-muted-foreground hover:text-text"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => {
                  setDeleteError(null)
                  setDeleteOpen(true)
                }}
              >
                <Trash2 className="size-3.5" />
                删除{typeLabel}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => requestAction({ kind: 'close' })}
            aria-label="关闭详情"
            className="size-8 text-muted-foreground hover:text-text"
          >
            <X className="size-4" />
          </Button>
        </div>
      </header>

      {creationActive && (
        <div className="flex shrink-0 gap-1.5 border-b border-border bg-amber-500/8 px-3 py-2">
          <Clock className="mt-px size-3 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
          <p className="text-nano leading-relaxed text-muted-foreground">
            创作进行中。本章上下文已在流程开始时构建，此处的修改要到下一次创作才会生效。
          </p>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {mode === 'overview' ? (
          <EntityOverview
            entity={entity as unknown as Record<string, unknown>}
            entityType={activeSelection.type}
            timeline={timeline}
            timelineLoading={timelineQuery.isLoading}
          />
        ) : (
          <DetailPanelEditProvider onDirtyChange={setHasUnsavedChanges}>
            <div className="px-3 pb-3 pt-2.5">
              {activeSelection.type === 'character' && (
                <CharacterForm key={entity.id} entity={entity as NovelCharacter} />
              )}
              {activeSelection.type === 'chapter' && (
                <ChapterForm key={entity.id} entity={entity as NovelChapter} />
              )}
              {activeSelection.type === 'volume' && (
                <VolumeForm key={entity.id} entity={entity as NovelVolume} />
              )}
              {activeSelection.type === 'conflict' && (
                <ConflictForm key={entity.id} entity={entity as NovelConflict} />
              )}
              {activeSelection.type === 'clue' && (
                <ClueForm key={entity.id} entity={entity as NovelClue} />
              )}
              {activeSelection.type === 'foreshadow' && (
                <ForeshadowForm key={entity.id} entity={entity as NovelForeshadow} />
              )}
              {activeSelection.type === 'faction' && (
                <FactionForm key={entity.id} entity={entity as NovelFaction} />
              )}
              {activeSelection.type === 'location' && (
                <LocationForm key={entity.id} entity={entity as NovelLocation} />
              )}
              {activeSelection.type === 'world_element' && (
                <WorldElementForm key={entity.id} entity={entity as NovelWorldElement} />
              )}
              {activeSelection.type === 'info_layer' && (
                <InfoLayerForm key={entity.id} entity={entity as NovelInformationLayer} />
              )}
              {activeSelection.type === 'item' && (
                <ItemForm key={entity.id} entity={entity as NovelItem} />
              )}
            </div>
          </DetailPanelEditProvider>
        )}
      </div>

      <Dialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open) setPendingAction(null)
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>放弃未保存的修改？</DialogTitle>
            <DialogDescription>
              当前实体使用手动保存。继续操作会丢弃尚未保存的表单内容。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingAction(null)}>
              继续编辑
            </Button>
            <Button
              variant="destructive"
              onClick={() => pendingAction && completeAction(pendingAction)}
            >
              放弃修改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!deleting) setDeleteOpen(open)
        }}
      >
        <DialogContent showCloseButton={!deleting}>
          <DialogHeader>
            <DialogTitle>删除「{title}」？</DialogTitle>
            <DialogDescription>
              {activeSelection.type === 'project' ? '项目会移入回收站。' : '此操作不可撤销。'}
              {changeCount > 0 && ` 将清理 ${changeCount} 条账本实录。`}
              {eventCount > 0 && ` 关联的 ${eventCount} 个事件会保留其他实体仍在使用的部分。`}
            </DialogDescription>
          </DialogHeader>
          {deleteError && <p className="text-xs leading-relaxed text-destructive">{deleteError}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={deleting} onClick={() => setDeleteOpen(false)}>
              取消
            </Button>
            <Button variant="destructive" disabled={deleting} onClick={() => void handleDelete()}>
              <Trash2 className="size-3.5" />
              {deleting ? '删除中...' : '确认删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
