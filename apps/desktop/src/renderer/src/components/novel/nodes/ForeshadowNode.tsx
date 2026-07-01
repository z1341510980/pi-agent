import { memo, type ReactElement } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { Lightbulb, X } from 'lucide-react'
import type { NovelForeshadow, ForeshadowStatus } from '@/api/novel-client'
import { cn } from '@/lib/utils'

export type ForeshadowNodeData = { entity: NovelForeshadow; onDelete?: () => void }
export type ForeshadowNodeType = Node<ForeshadowNodeData, 'foreshadow'>

const STATUS_STYLES: Record<ForeshadowStatus, { label: string; className: string }> = {
  planned: { label: '已规划', className: 'bg-slate-500/10 text-slate-600 dark:text-slate-300' },
  planted: { label: '已埋设', className: 'bg-amber-500/10 text-amber-600 dark:text-amber-300' },
  reinforced: { label: '已强化', className: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-300' },
  partially_revealed: { label: '部分揭示', className: 'bg-blue-500/10 text-blue-600 dark:text-blue-300' },
  recovering: { label: '回收中', className: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-300' },
  recovered: { label: '已回收', className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300' },
  abandoned: { label: '已废弃', className: 'bg-rose-500/10 text-rose-600 dark:text-rose-300' },
}

function ForeshadowNodeImpl({ data, selected }: NodeProps<ForeshadowNodeType>): ReactElement {
  const { entity, onDelete } = data
  const status = STATUS_STYLES[entity.status] ?? STATUS_STYLES.planned
  return (
    <div
      className={cn(
        'group relative w-[200px] rounded-lg border bg-card text-card-foreground shadow-sm transition-[box-shadow]',
        'border-amber-500/40 dark:border-amber-400/40',
        selected && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-amber-500" />
      <Handle type="target" position={Position.Left} className="!bg-amber-500" />
      <Handle type="source" position={Position.Right} className="!bg-amber-500" />

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

      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 bg-amber-500/10 rounded-t-lg">
        <Lightbulb className="size-3.5 text-amber-500 dark:text-amber-400 shrink-0" />
        <span className="text-xs font-medium text-amber-600 dark:text-amber-300">伏笔</span>
        {entity.category && (
          <span className="ml-auto text-[10px] text-amber-700/80 dark:text-amber-200/80 truncate max-w-[80px]">
            {entity.category}
          </span>
        )}
      </div>
      <div className="px-3 py-2 space-y-1.5">
        <div className="text-xs text-text line-clamp-2" title={entity.description}>
          {entity.description}
        </div>
        <div className="flex items-center justify-between text-[10px]">
          <span className={cn('rounded px-1.5 py-0.5', status.className)}>
            {status.label}
          </span>
          {entity.recoverByChapter != null && (
            <span className="text-muted-foreground">回收于第 {entity.recoverByChapter} 章</span>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-amber-500" />
    </div>
  )
}

export const ForeshadowNode = memo(ForeshadowNodeImpl)
