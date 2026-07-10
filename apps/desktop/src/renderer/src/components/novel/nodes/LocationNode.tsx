import { memo, type ReactElement } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { MapPin, X } from 'lucide-react'
import type {
  NovelLocation,
  NovelLocationType,
  NovelLocationSignificance,
  NovelLocationStatus,
} from '@/api/novel-client'
import { cn } from '@/lib/utils'

export type LocationNodeData = { entity: NovelLocation; onDelete?: () => void }
export type LocationNodeType = Node<LocationNodeData, 'location'>

const TYPE_LABELS: Record<NovelLocationType, string> = {
  continent: '大陆',
  country: '国家',
  city: '城市',
  building: '建筑',
  dungeon: '地下城',
  region: '区域',
  wilderness: '荒野',
}

const SIGNIFICANCE_LABELS: Record<NovelLocationSignificance, string> = {
  minor: '次要',
  moderate: '中等',
  major: '重要',
  critical: '关键',
}

const STATUS_LABELS: Record<NovelLocationStatus, string> = {
  normal: '正常',
  destroyed: '毁灭',
  changed: '变迁',
  hidden: '隐秘',
}

const SIGNIFICANCE_COLOR: Record<NovelLocationSignificance, string> = {
  minor: 'bg-slate-400',
  moderate: 'bg-cyan-500',
  major: 'bg-amber-500',
  critical: 'bg-rose-500',
}

function LocationNodeImpl({ data, selected }: NodeProps<LocationNodeType>): ReactElement {
  const { entity, onDelete } = data

  return (
    <div
      className={cn(
        'group relative w-[200px] rounded-lg border bg-card text-card-foreground shadow-sm transition-[box-shadow]',
        'border-cyan-500/40 dark:border-cyan-400/40',
        selected && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-cyan-500" />
      <Handle type="target" position={Position.Left} className="!bg-cyan-500" />
      <Handle type="source" position={Position.Right} className="!bg-cyan-500" />

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

      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 bg-cyan-500/10 rounded-t-lg">
        <MapPin className="size-3.5 text-cyan-500 dark:text-cyan-400 shrink-0" />
        <span className="text-xs font-medium text-cyan-600 dark:text-cyan-300">地点</span>
        <span className="ml-auto rounded bg-cyan-500/10 px-1.5 py-0.5 text-[10px] text-cyan-600 dark:text-cyan-300">
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
          <span className="text-muted-foreground">重要程度</span>
          <span className="text-subtle">{SIGNIFICANCE_LABELS[entity.significance] ?? entity.significance}</span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full transition-[width]', SIGNIFICANCE_COLOR[entity.significance] ?? 'bg-cyan-500')}
            style={{
              width: `${
                entity.significance === 'critical' ? 100
                : entity.significance === 'major' ? 75
                : entity.significance === 'moderate' ? 50
                : 25
              }%`,
            }}
          />
        </div>
        <div className="flex items-center justify-between text-[10px] text-subtle">
          <span>状态: {STATUS_LABELS[entity.status] ?? entity.status}</span>
          {entity.firstChapter != null && <span className="tabular-nums">首现: 第 {entity.firstChapter} 章</span>}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-cyan-500" />
    </div>
  )
}

export const LocationNode = memo(LocationNodeImpl)
