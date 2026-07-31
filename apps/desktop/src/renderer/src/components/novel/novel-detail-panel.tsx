import { useMemo, type ReactElement } from 'react'
import { Info, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useNovelDataStore } from '@/stores/novel-data-store'
import { useNovelUiStore } from '@/stores/novel-ui-store'
import {
  type NovelChapter,
  type NovelCharacter,
  type NovelClue,
  type NovelConflict,
  type NovelFaction,
  type NovelForeshadow,
  type NovelInformationLayer,
  type NovelItem,
  type NovelLocation,
  type NovelProject,
  type NovelVolume,
  type NovelWorldElement,
} from '@/api/novel-client'
import { entityTitle, NODE_TYPE_LABELS } from './detail-forms/shared'
import { ProjectForm } from './detail-forms/project-form'
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

// ── 主组件 ──

export interface NovelDetailPanelProps {
  /**
   * 创作流程进行中。
   *
   * 用于提示：本章的上下文在流程开始时就已构建并跨 Agent 缓存复用，
   * 此时在这里改实体不会影响正在生成的这一章。
   * 详情面板本身仍可正常查看与编辑 —— 写作者最需要核对设定的时刻恰是 Agent 写作的时刻。
   */
  creationActive?: boolean
}

export function NovelDetailPanel({ creationActive = false }: NovelDetailPanelProps = {}): ReactElement {
  const selectedNodeId = useNovelUiStore((s) => s.selectedNodeId)
  const selectedNodeType = useNovelUiStore((s) => s.selectedNodeType)
  const clearSelection = useNovelUiStore((s) => s.clearSelection)
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

  const entity = useMemo(() => {
    if (!selectedNodeId || !selectedNodeType) return null
    switch (selectedNodeType) {
      case 'project':
        return projects.find((p) => p.id === selectedNodeId) ?? null
      case 'character':
        return characters.find((c) => c.id === selectedNodeId) ?? null
      case 'chapter':
        return chapters.find((c) => c.id === selectedNodeId) ?? null
      case 'volume':
        return volumes.find((v) => v.id === selectedNodeId) ?? null
      case 'conflict':
        return conflicts.find((c) => c.id === selectedNodeId) ?? null
      case 'clue':
        return clues.find((c) => c.id === selectedNodeId) ?? null
      case 'foreshadow':
        return foreshadows.find((f) => f.id === selectedNodeId) ?? null
      case 'faction':
        return factions.find((f) => f.id === selectedNodeId) ?? null
      case 'location':
        return locations.find((l) => l.id === selectedNodeId) ?? null
      case 'world_element':
        return worldElements.find((w) => w.id === selectedNodeId) ?? null
      case 'info_layer':
        return infoLayers.find((l) => l.id === selectedNodeId) ?? null
      case 'item':
        return items.find((it) => it.id === selectedNodeId) ?? null
      default:
        return null
    }
  }, [selectedNodeId, selectedNodeType, projects, characters, chapters, volumes, conflicts, clues, foreshadows, factions, locations, worldElements, infoLayers, items])

  if (!entity || !selectedNodeType) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-surface-1 border-l border-border p-6 text-center">
        <Info className="size-6 text-muted-foreground mb-2" />
        <p className="text-sm text-muted-foreground">
          选择一个实体以查看详情
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-surface-1 border-l border-border">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <Badge variant="secondary" className="shrink-0">
            {NODE_TYPE_LABELS[selectedNodeType] ?? selectedNodeType}
          </Badge>
          <span className="text-sm font-medium text-text truncate">
            {entityTitle(entity, selectedNodeType)}
          </span>
        </div>
        <Button size="icon-sm" variant="ghost" onClick={clearSelection} aria-label="关闭">
          <X className="size-3.5" />
        </Button>
      </div>

      {/* 创作进行中的时效提示：改动不影响当前正在生成的章节 */}
      {creationActive && (
        <div className="shrink-0 px-3 py-2 border-b border-border bg-surface-2 text-micro leading-relaxed text-muted-foreground">
          创作进行中。本章上下文已在流程开始时构建，此处的修改要到下一次创作才会生效。
        </div>
      )}

      {/* 表单 */}
      <div className="flex-1 overflow-y-auto min-h-0 p-3">
        {selectedNodeType === 'project' && (
          <ProjectForm key={entity.id} entity={entity as NovelProject} />
        )}
        {selectedNodeType === 'character' && (
          <CharacterForm key={entity.id} entity={entity as NovelCharacter} />
        )}
        {selectedNodeType === 'chapter' && (
          <ChapterForm key={entity.id} entity={entity as NovelChapter} />
        )}
        {selectedNodeType === 'volume' && (
          <VolumeForm key={entity.id} entity={entity as NovelVolume} />
        )}
        {selectedNodeType === 'conflict' && (
          <ConflictForm key={entity.id} entity={entity as NovelConflict} />
        )}
        {selectedNodeType === 'clue' && (
          <ClueForm key={entity.id} entity={entity as NovelClue} />
        )}
        {selectedNodeType === 'foreshadow' && (
          <ForeshadowForm key={entity.id} entity={entity as NovelForeshadow} />
        )}
        {selectedNodeType === 'faction' && (
          <FactionForm key={entity.id} entity={entity as NovelFaction} />
        )}
        {selectedNodeType === 'location' && (
          <LocationForm key={entity.id} entity={entity as NovelLocation} />
        )}
        {selectedNodeType === 'world_element' && (
          <WorldElementForm key={entity.id} entity={entity as NovelWorldElement} />
        )}
        {selectedNodeType === 'info_layer' && (
          <InfoLayerForm key={entity.id} entity={entity as NovelInformationLayer} />
        )}
        {selectedNodeType === 'item' && (
          <ItemForm key={entity.id} entity={entity as NovelItem} />
        )}
      </div>
    </div>
  )
}
