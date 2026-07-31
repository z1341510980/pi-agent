import { memo, type ReactElement } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { Globe, X } from 'lucide-react'
import type { NovelWorldElement, NovelWorldElementCategory } from '@/api/novel-client'
import { cn } from '@/lib/utils'

export type WorldElementNodeData = { entity: NovelWorldElement; onDelete?: () => void }
export type WorldElementNodeType = Node<WorldElementNodeData, 'world_element'>

const CATEGORY_LABELS: Record<NovelWorldElementCategory, string> = {
  power_system: '力量体系',
  history: '历史',
  culture: '文化',
  religion: '宗教',
  technology: '科技',
  economy: '经济',
  geography: '地理',
}

const CATEGORY_COLOR: Record<NovelWorldElementCategory, string> = {
  power_system: 'bg-rose-500',
  history: 'bg-amber-500',
  culture: 'bg-pink-500',
  religion: 'bg-violet-500',
  technology: 'bg-sky-500',
  economy: 'bg-emerald-500',
  geography: 'bg-teal-500',
}

function WorldElementNodeImpl({ data, selected }: NodeProps<WorldElementNodeType>): ReactElement {
  const { entity, onDelete } = data
  const attrCount = Object.keys(entity.attributes ?? {}).length

  return (
    <div
      className={cn(
        'group relative w-[200px] rounded-lg border bg-card text-card-foreground shadow-sm transition-[box-shadow]',
        'border-indigo-500/40 dark:border-indigo-400/40',
        selected && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-indigo-500" />
      <Handle type="target" position={Position.Left} className="!bg-indigo-500" />
      <Handle type="source" position={Position.Right} className="!bg-indigo-500" />

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

      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 bg-indigo-500/10 rounded-t-lg">
        <Globe className="size-3.5 text-indigo-500 dark:text-indigo-400 shrink-0" />
        <span className="text-xs font-medium text-indigo-600 dark:text-indigo-300">世界观</span>
        <span className="ml-auto rounded bg-indigo-500/10 px-1.5 py-0.5 text-nano text-indigo-600 dark:text-indigo-300">
          {CATEGORY_LABELS[entity.category] ?? entity.category}
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
        <div className="flex items-center gap-1.5">
          <span className={cn('size-1.5 rounded-full', CATEGORY_COLOR[entity.category] ?? 'bg-indigo-500')} />
          <span className="text-nano text-subtle">
            {CATEGORY_LABELS[entity.category] ?? entity.category}
          </span>
          {attrCount > 0 && (
            <span className="ml-auto tabular-nums text-nano text-muted-foreground" title="附加属性数量">
              {attrCount} 属性
            </span>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-indigo-500" />
    </div>
  )
}

export const WorldElementNode = memo(WorldElementNodeImpl)
