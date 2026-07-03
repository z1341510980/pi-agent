import { memo, type ReactElement } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { Swords, X, Flame, Zap, AlertTriangle } from 'lucide-react'
import type { NovelConflict, ConflictType, ConflictStage, ClimaxType } from '@/api/novel-client'
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

const CLIMAX_TYPE_LABELS: Record<ClimaxType, string> = {
  emotional: '情感',
  fate: '命运',
  character: '性格',
  combat: '打斗',
  theme: '主题',
  composite: '复合',
}

function ConflictNodeImpl({ data, selected }: NodeProps<ConflictNodeType>): ReactElement {
  const { entity, onDelete } = data
  const intensityPct = Math.min(100, (entity.intensity / 10) * 100)
  const intensityColor =
    entity.intensity >= 8 ? 'bg-rose-500'
    : entity.intensity >= 5 ? 'bg-amber-500'
    : 'bg-yellow-500'

  const hasClimax = entity.climaxChapter != null || entity.climaxType != null
  const hasTwistPotential = entity.twistPotential != null && entity.twistPotential >= 7

  return (
    <div
      className={cn(
        'group relative w-[200px] rounded-lg border bg-card text-card-foreground shadow-sm transition-[box-shadow]',
        'border-rose-500/40 dark:border-rose-400/40',
        hasClimax && 'border-amber-500/60 dark:border-amber-400/60',
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
          className="absolute top-1 right-1 z-10 flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 pointer-events-none transition-opacity before:absolute before:-inset-[10px] before:content-[''] hover:bg-destructive/10 hover:text-destructive active:scale-[0.96] group-hover:pointer-events-auto group-hover:opacity-100"
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
            <span className="tabular-nums">{entity.intensity}/10</span>
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
            <div className={cn('h-full transition-[width]', intensityColor)} style={{ width: `${intensityPct}%` }} />
          </div>
        </div>
        <div className="text-[10px] text-subtle">
          阶段: {STAGE_LABELS[entity.stage] ?? entity.stage}
        </div>

        {/* 高潮信息 */}
        {hasClimax && (
          <div className="flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-300">
            <Flame className="size-3 shrink-0" />
            {entity.climaxChapter != null && <span>第{entity.climaxChapter}章</span>}
            {entity.climaxType != null && (
              <span>{CLIMAX_TYPE_LABELS[entity.climaxType] ?? entity.climaxType}高潮</span>
            )}
          </div>
        )}

        {/* 突转潜力提示 */}
        {hasTwistPotential && (
          <div className="flex items-center gap-1 rounded bg-purple-500/10 px-1.5 py-0.5 text-[10px] text-purple-600 dark:text-purple-300" title="突转潜力高，适合安排突转">
            <Zap className="size-3 shrink-0" />
            <span>突转潜力 {entity.twistPotential}/10</span>
          </div>
        )}

        {/* 赌注 */}
        {entity.stakes && (
          <div className="flex items-start gap-1 text-[10px] text-muted-foreground" title={entity.stakes}>
            <AlertTriangle className="size-3 shrink-0 mt-0.5" />
            <span className="line-clamp-2">赌注：{entity.stakes}</span>
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-rose-500" />
    </div>
  )
}

export const ConflictNode = memo(ConflictNodeImpl)
