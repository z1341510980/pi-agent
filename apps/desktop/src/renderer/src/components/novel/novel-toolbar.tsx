import { useCallback, type ChangeEvent, type ReactElement } from 'react'
import { useReactFlow } from '@xyflow/react'
import {
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
  deleteCharacter,
  deleteConflict,
  deleteForeshadow,
  deleteNodePosition,
  type NovelEdgeType,
  type NovelNodeTypeName,
} from '@/api/novel-client'

// ── 手动连线可选的关系类型 ──
// 注：自动边类型（appearance/involvement/member/hierarchy/association/foreshadow/base）
// 由布局函数按实体语义派生，不在此处选择。此处仅列出用户在画布上手动拉线时
// 可能用到的语义化关系类型。
const RELATION_TYPES: { value: NovelEdgeType; label: string }[] = [
  { value: 'mentor', label: '师徒' },
  { value: 'kinship', label: '亲属' },
  { value: 'rivalry', label: '敌对' },
  { value: 'alliance', label: '同盟' },
  { value: 'subordinate', label: '隶属' },
  { value: 'trigger', label: '触发' },
  { value: 'causality', label: '因果' },
  { value: 'relationship', label: '关系' },
]

export interface NovelToolbarProps {
  /** 触发重新布局 */
  onRelayout: () => void
  /** 导出当前画布数据为 JSON */
  onExport?: () => void
  onImport?: () => void
}
export function NovelToolbar({
  onRelayout,
  onExport,
  onImport,
}: NovelToolbarProps): ReactElement {
  const currentProjectId = useNovelStore((s) => s.currentProjectId)
  const selectedNodeId = useNovelStore((s) => s.selectedNodeId)
  const selectedNodeType = useNovelStore((s) => s.selectedNodeType)
  const clearSelection = useNovelStore((s) => s.clearSelection)
  const removeCharacter = useNovelStore((s) => s.removeCharacter)
  const removeConflict = useNovelStore((s) => s.removeConflict)
  const removeForeshadow = useNovelStore((s) => s.removeForeshadow)
  const removeNodePosition = useNovelStore((s) => s.removeNodePosition)
  const canvasEdgeType = useNovelStore((s) => s.canvasEdgeType)
  const setCanvasEdgeType = useNovelStore((s) => s.setCanvasEdgeType)

  const { zoomIn, zoomOut, fitView } = useReactFlow()

  const noProject = !currentProjectId
  const hasSelection = !!selectedNodeId && !!selectedNodeType

  const handleEdgeTypeChange = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => {
      setCanvasEdgeType(e.target.value as NovelEdgeType)
    },
    [setCanvasEdgeType],
  )

  // ── 删除当前选中节点 ──
  // 画布已收敛为纯实体关系图，不再渲染 project/chapter 节点，
  // 因此删除分支仅保留实体类型。
  const handleDeleteSelected = useCallback(async () => {
    if (!currentProjectId || !selectedNodeId || !selectedNodeType) return
    // group 节点不对应持久化实体
    if (selectedNodeType === 'group') return
    if (!window.confirm('确认删除此节点？相关数据将被永久移除。')) return
    try {
      switch (selectedNodeType) {
        case 'character':
          await deleteCharacter(selectedNodeId)
          removeCharacter(selectedNodeId)
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
  }, [currentProjectId, selectedNodeId, selectedNodeType, removeCharacter, removeConflict, removeForeshadow, removeNodePosition, clearSelection])

  return (
    <div className="flex items-center gap-1 px-3 h-11 border-b border-border bg-surface-1 shrink-0">
      {/* 关系类型选择器：决定手动连线的边类型 */}
      <div className="flex items-center gap-1">
        <label htmlFor="novel-canvas-edge-type" className="text-xs text-text-secondary">
          关系类型
        </label>
        <select
          id="novel-canvas-edge-type"
          value={canvasEdgeType}
          onChange={handleEdgeTypeChange}
          disabled={noProject}
          className="h-7 rounded border border-border bg-surface-2 px-1.5 text-xs text-text-primary disabled:opacity-50"
          title="选择手动连线的关系类型"
        >
          {RELATION_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
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