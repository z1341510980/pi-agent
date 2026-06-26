import { memo, type ReactElement } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { Users, X } from 'lucide-react'
import type { NovelFaction, NovelFactionType, NovelFactionStrength, NovelFactionStatus } from '@/api/novel-client'
import { cn } from '@/lib/utils'

export type FactionNodeData = { entity: NovelFaction; onDelete?: () => void }
export type FactionNodeType = Node<FactionNodeData, 'faction'>

const TYPE_LABELS: Record<NovelFactionType, string> = {
  organization: '组织',
  sect: '门派',
  kingdom: '王国',
  family: '家族',
  guild: '公会',
  cult: '邪教',
}

const STRENGTH_LABELS: Record<NovelFactionStrength, string> = {
  weak: '弱小',
  medium: '中等',
  strong: '强盛',
  overwhelming: '压倒性',
}

const STATUS_LABELS: Record<NovelFactionStatus, string> = {
  active: '活跃',
  declined: '衰落',
  destroyed: '覆灭',
  hidden: '隐秘',
}

const STRENGTH_COLOR: Record<NovelFactionStrength, string> = {
  weak: 'bg-slate-400',
  medium: 'bg-sky-500',
  strong: 'bg-violet-500',
  overwhelming: 'bg-rose-500',
}

function FactionNodeImpl({ data, selected }: NodeProps<FactionNodeType>): ReactElement {
  const { entity, onDelete } = data

  return (
    <div
      className={cn(
        'group relative w-[200px] rounded-lg border bg-card text-card-foreground shadow-sm transition-all',
        'border-violet-500/40 dark:border-violet-400/40',
        selected && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-violet-500" />
      <Handle type="target" position={Position.Left} className="!bg-violet-500" />
      <Handle type="source" position={Position.Right} className="!bg-violet-500" />

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

      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 bg-violet-500/10 rounded-t-lg">
        <Users className="size-3.5 text-violet-500 dark:text-violet-400 shrink-0" />
        <span className="text-xs font-medium text-violet-600 dark:text-violet-300">势力</span>
        <span className="ml-auto rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-600 dark:text-violet-300">
          {TYPE_LABELS[entity.type] ?? entity.type}
        </span>
      </div>
      <div className="px-3 py-2 space-y-1.5">
        <div className="text-xs font-medium text-text line-clamp-1" title={entity.name}>
          {entity.name}
        </div>
        {entity.description && (
          <div className="text-xs text-muted-foreground line-clamp-2" title={entity.description}>
            {entity.description}
          </div>
        )}
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-muted-foreground">实力</span>
          <span className="text-subtle">{STRENGTH_LABELS[entity.strength] ?? entity.strength}</span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full transition-all', STRENGTH_COLOR[entity.strength] ?? 'bg-violet-500')}
            style={{
              width: `${
                entity.strength === 'overwhelming' ? 100
                : entity.strength === 'strong' ? 75
                : entity.strength === 'medium' ? 50
                : 25
              }%`,
            }}
          />
        </div>
        <div className="flex items-center justify-between text-[10px] text-subtle">
          <span>状态: {STATUS_LABELS[entity.status] ?? entity.status}</span>
          {(entity.allies.length > 0 || entity.enemies.length > 0) && (
            <span title={`盟友 ${entity.allies.length} / 敌对 ${entity.enemies.length}`}>
              盟 {entity.allies.length} · 敌 {entity.enemies.length}
            </span>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-violet-500" />
    </div>
  )
}

export const FactionNode = memo(FactionNodeImpl)
