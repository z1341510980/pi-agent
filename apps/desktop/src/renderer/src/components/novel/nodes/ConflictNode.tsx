import { memo, type ReactElement } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { Swords, X } from 'lucide-react'
import type { NovelConflict, ConflictType, ConflictStage } from '@/api/novel-client'
import { cn } from '@/lib/utils'

export type ConflictNodeData = { entity: NovelConflict; onDelete?: () => void }
export type ConflictNodeType = Node<ConflictNodeData, 'conflict'>

const TYPE_LABELS: Record<ConflictType, string> = {
  inner: '内心',
  relationship: '关系',
  faction: '阵营',
  interest: '利益',
  moral: '道德',
  identity: '身份',
  emotional: '情感',
  world_rule: '世界规则',
  survival: '生存',
}

const STAGE_LABELS: Record<ConflictStage, string> = {
  latent: '潜伏',
  emerging: '浮现',
  escalating: '升级',
  erupting: '爆发',
  reversing: '逆转',
  resolved: '已解决',
  transformed: '转化',
}

function ConflictNodeImpl({ data, selected }: NodeProps<ConflictNodeType>): ReactElement {
  const { entity, onDelete } = data
  const intensityPct = Math.min(100, (entity.intensity / 10) * 100)
  const intensityColor =
    entity.intensity >= 8 ? 'bg-rose-500'
    : entity.intensity >= 5 ? 'bg-amber-500'
    : 'bg-yellow-500'

  return (
    <div
      className={cn(
        'group relative w-[200px] rounded-lg border bg-card text-card-foreground shadow-sm transition-all',
        'border-rose-500/40 dark:border-rose-400/40',
        selected && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-rose-500" />
      <Handle type="target" position={Position.Left} className="!bg-rose-500" />
      <Handle type="source" position={Position.Right} className="!bg-rose-500" />

      {/* 删除按钮（hover 显示） */}
      {onDelete && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          title="删除节点"
          className="absolute top-1 right-1 z-10 flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
        >
          <X className="size-3" />
        </button>
      )}

      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 bg-rose-500/10 rounded-t-lg">
        <Swords className="size-3.5 text-rose-500 dark:text-rose-400 shrink-0" />
        <span className="text-xs font-medium text-rose-600 dark:text-rose-300">冲突</span>
        <span className="ml-auto rounded bg-rose-500/10 px-1.5 py-0.5 text-[10px] text-rose-600 dark:text-rose-300">
          {TYPE_LABELS[entity.type] ?? entity.type}
        </span>
      </div>
      <div className="px-3 py-2 space-y-1.5">
        <div className="text-xs text-text line-clamp-2" title={entity.description}>
          {entity.description}
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-0.5">
            <span>强度</span>
            <span>{entity.intensity}/10</span>
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
            <div className={cn('h-full transition-all', intensityColor)} style={{ width: `${intensityPct}%` }} />
          </div>
        </div>
        <div className="text-[10px] text-subtle">
          阶段: {STAGE_LABELS[entity.stage] ?? entity.stage}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-rose-500" />
    </div>
  )
}

export const ConflictNode = memo(ConflictNodeImpl)
