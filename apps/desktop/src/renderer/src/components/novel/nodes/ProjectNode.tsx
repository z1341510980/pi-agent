import { memo, type ReactElement } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { BookOpen, X } from 'lucide-react'
import type { NovelProject } from '@/api/novel-client'
import { cn } from '@/lib/utils'

export type ProjectNodeData = { entity: NovelProject; onDelete?: () => void }
export type ProjectNodeType = Node<ProjectNodeData, 'project'>

const STAGE_LABELS: Record<string, string> = {
  setup: '铺垫',
  rising: '上升',
  climax: '高潮',
  falling: '回落',
  resolution: '结局',
}

const STATUS_LABELS: Record<string, string> = {
  active: '进行中',
  paused: '已暂停',
  completed: '已完成',
}

function ProjectNodeImpl({ data, selected }: NodeProps<ProjectNodeType>): ReactElement {
  const { entity, onDelete } = data
  const progress = entity.targetWords > 0
    ? Math.min(100, Math.round((entity.currentChapter / Math.max(1, entity.targetWords / 3000)) * 100))
    : 0

  return (
    <div
      className={cn(
        'group relative w-[220px] rounded-lg border bg-card text-card-foreground shadow-md transition-[box-shadow]',
        'border-violet-500/40 dark:border-violet-400/40',
        selected && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-violet-500" />
      <Handle type="target" position={Position.Left} className="!bg-violet-500" />
      <Handle type="source" position={Position.Right} className="!bg-violet-500" />

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

      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 bg-violet-500/10 rounded-t-lg">
        <BookOpen className="size-4 text-violet-500 dark:text-violet-400 shrink-0" />
        <span className="text-xs font-medium text-violet-600 dark:text-violet-300">项目</span>
        <span
          className={cn(
            'ml-auto size-2 rounded-full',
            entity.status === 'active' && 'bg-success',
            entity.status === 'paused' && 'bg-amber-500',
            entity.status === 'completed' && 'bg-primary',
          )}
          aria-hidden="true"
        />
      </div>
      <div className="px-3 py-2 space-y-1.5">
        <div className="text-sm font-semibold text-text truncate" title={entity.title}>
          {entity.title}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-subtle">
          <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-violet-600 dark:text-violet-300">
            {entity.genre}
          </span>
          <span>·</span>
          <span>{STAGE_LABELS[entity.currentStage] ?? entity.currentStage}</span>
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="tabular-nums">第 {entity.currentChapter} 章</span>
          <span>{STATUS_LABELS[entity.status] ?? entity.status}</span>
        </div>
        {entity.targetWords > 0 && (
          <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-violet-500 transition-[width]"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-violet-500" />
    </div>
  )
}

export const ProjectNode = memo(ProjectNodeImpl)
