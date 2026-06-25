import { useCallback, type ReactElement } from 'react'
import { useReactFlow } from '@xyflow/react'
import {
  UserPlus,
  FilePlus,
  Swords,
  Lightbulb,
  Maximize,
  ZoomIn,
  ZoomOut,
  Download,
  Upload,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useNovelStore } from '@/stores/novel-store'
import {
  createCharacter,
  createChapter,
  createConflict,
  createForeshadow,
  deleteProject,
  deleteCharacter,
  deleteChapter,
  deleteConflict,
  deleteForeshadow,
  deleteNodePosition,
  type NovelNodeTypeName,
} from '@/api/novel-client'

export interface NovelToolbarProps {
  /** 触发重新布局 */
  onRelayout: () => void
  /** 导出当前画布数据为 JSON */
  onExport?: () => void
  onImport?: () => void
}

interface AddButtonProps {
  icon: typeof UserPlus
  label: string
  onClick: () => void
  disabled?: boolean
}

function AddButton({ icon: Icon, label, onClick, disabled }: AddButtonProps): ReactElement {
  return (
    <Button size="sm" variant="ghost" onClick={onClick} disabled={disabled} title={`添加${label}`}>
      <Icon className="size-3.5" />
      <span className="hidden sm:inline">{label}</span>
    </Button>
  )
}

export function NovelToolbar({
  onRelayout,
  onExport,
  onImport,
}: NovelToolbarProps): ReactElement {
  const currentProjectId = useNovelStore((s) => s.currentProjectId)
  const upsertCharacter = useNovelStore((s) => s.upsertCharacter)
  const upsertChapter = useNovelStore((s) => s.upsertChapter)
  const upsertConflict = useNovelStore((s) => s.upsertConflict)
  const upsertForeshadow = useNovelStore((s) => s.upsertForeshadow)
  const chapters = useNovelStore((s) => s.chapters)
  const selectedNodeId = useNovelStore((s) => s.selectedNodeId)
  const selectedNodeType = useNovelStore((s) => s.selectedNodeType)
  const clearSelection = useNovelStore((s) => s.clearSelection)
  const removeProject = useNovelStore((s) => s.removeProject)
  const removeCharacter = useNovelStore((s) => s.removeCharacter)
  const removeChapter = useNovelStore((s) => s.removeChapter)
  const removeConflict = useNovelStore((s) => s.removeConflict)
  const removeForeshadow = useNovelStore((s) => s.removeForeshadow)
  const removeNodePosition = useNovelStore((s) => s.removeNodePosition)

  const { zoomIn, zoomOut, fitView } = useReactFlow()

  const noProject = !currentProjectId
  const hasSelection = !!selectedNodeId && !!selectedNodeType

  const handleAddCharacter = useCallback(async () => {
    if (!currentProjectId) return
    try {
      const character = await createCharacter(currentProjectId, {
        name: `新角色 ${Date.now().toString().slice(-4)}`,
      })
      upsertCharacter(character)
    } catch {
      // 静默失败（可在通知中心提示）
    }
  }, [currentProjectId, upsertCharacter])

  const handleAddChapter = useCallback(async () => {
    if (!currentProjectId) return
    const nextNumber = chapters.length > 0
      ? Math.max(...chapters.map((c) => c.chapterNumber)) + 1
      : 1
    try {
      const chapter = await createChapter(currentProjectId, {
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
  }, [currentProjectId, chapters, upsertChapter])

  const handleAddConflict = useCallback(async () => {
    if (!currentProjectId) return
    try {
      const conflict = await createConflict(currentProjectId, {
        description: '新的冲突',
        type: 'interest',
        intensity: 5,
        stage: 'latent',
      })
      upsertConflict(conflict)
    } catch {
      // 静默失败
    }
  }, [currentProjectId, upsertConflict])

  const handleAddForeshadow = useCallback(async () => {
    if (!currentProjectId) return
    try {
      const foreshadow = await createForeshadow(currentProjectId, {
        description: '新的伏笔',
        category: '事件',
        status: 'planned',
      })
      upsertForeshadow(foreshadow)
    } catch {
      // 静默失败
    }
  }, [currentProjectId, upsertForeshadow])

  // ── 删除当前选中节点 ──
  const handleDeleteSelected = useCallback(async () => {
    if (!currentProjectId || !selectedNodeId || !selectedNodeType) return
    // group 节点不对应持久化实体
    if (selectedNodeType === 'group') return
    if (!window.confirm('确认删除此节点？相关数据将被永久移除。')) return
    try {
      switch (selectedNodeType) {
        case 'project':
          await deleteProject(selectedNodeId)
          removeProject(selectedNodeId)
          break
        case 'character':
          await deleteCharacter(selectedNodeId)
          removeCharacter(selectedNodeId)
          break
        case 'chapter':
          await deleteChapter(selectedNodeId)
          removeChapter(selectedNodeId)
          break
        case 'conflict':
          await deleteConflict(selectedNodeId)
          removeConflict(selectedNodeId)
          break
        case 'foreshadow':
          await deleteForeshadow(selectedNodeId)
          removeForeshadow(selectedNodeId)
          break
        default:
          return
      }
      // 删除节点位置（best-effort）
      try {
        await deleteNodePosition(currentProjectId, selectedNodeType as NovelNodeTypeName, selectedNodeId)
      } catch {
        // 位置删除失败不阻塞主流程
      }
      removeNodePosition(selectedNodeType as NovelNodeTypeName, selectedNodeId)
      clearSelection()
    } catch {
      // 静默失败
    }
  }, [currentProjectId, selectedNodeId, selectedNodeType, removeProject, removeCharacter, removeChapter, removeConflict, removeForeshadow, removeNodePosition, clearSelection])

  return (
    <div className="flex items-center gap-1 px-3 h-11 border-b border-border bg-surface-1 shrink-0">
      {/* 添加实体 */}
      <div className="flex items-center gap-0.5">
        <AddButton icon={UserPlus} label="角色" onClick={handleAddCharacter} disabled={noProject} />
        <AddButton icon={FilePlus} label="章节" onClick={handleAddChapter} disabled={noProject} />
        <AddButton icon={Swords} label="冲突" onClick={handleAddConflict} disabled={noProject} />
        <AddButton icon={Lightbulb} label="伏笔" onClick={handleAddForeshadow} disabled={noProject} />
      </div>

      <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

      {/* 删除选中节点 + 重新排列 */}
      <div className="flex items-center gap-0.5">
        <Button
          size="sm"
          variant="ghost"
          onClick={handleDeleteSelected}
          disabled={!hasSelection}
          title="删除选中节点"
          className={cn(!hasSelection && 'opacity-50')}
        >
          <Trash2 className="size-3.5" />
          <span className="hidden sm:inline">删除</span>
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onRelayout}
          title="重新排列"
          disabled={noProject}
        >
          <Maximize className="size-3.5" />
        </Button>
      </div>

      <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

      {/* 缩放控制 */}
      <div className="flex items-center gap-0.5">
        <Button size="icon-sm" variant="ghost" onClick={() => zoomIn({ duration: 200 })} title="放大">
          <ZoomIn className="size-3.5" />
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={() => zoomOut({ duration: 200 })} title="缩小">
          <ZoomOut className="size-3.5" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => fitView({ padding: 0.2, duration: 300 })}
          title="适应视图"
        >
          <Maximize className="size-3.5" />
        </Button>
      </div>

      {/* 右侧：导出/导入 */}
      <div className="ml-auto flex items-center gap-0.5">
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onImport}
          title="导入"
          className={cn(!onImport && 'hidden')}
        >
          <Upload className="size-3.5" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onExport}
          title="导出"
          className={cn(!onExport && 'hidden')}
        >
          <Download className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}
