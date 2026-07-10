import { memo, type ReactElement } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { FileText, X } from 'lucide-react'
import type { NovelChapter, ChapterStatus } from '@/api/novel-client'
import { cn } from '@/lib/utils'

export type ChapterNodeData = { entity: NovelChapter; onDelete?: () => void }
export type ChapterNodeType = Node<ChapterNodeData, 'chapter'>

const STATUS_STYLES: Record<ChapterStatus, { label: string; className: string; dot: string }> = {
  planned: { label: '已规划', className: 'bg-slate-500/10 text-slate-600 dark:text-slate-300', dot: 'bg-slate-400' },
  drafting: { label: '草稿中', className: 'bg-amber-500/10 text-amber-600 dark:text-amber-300', dot: 'bg-amber-500' },
  review: { label: '审核中', className: 'bg-blue-500/10 text-blue-600 dark:text-blue-300', dot: 'bg-blue-500' },
  published: { label: '已发布', className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300', dot: 'bg-emerald-500' },
  rejected: { label: '已驳回', className: 'bg-rose-500/10 text-rose-600 dark:text-rose-300', dot: 'bg-rose-500' },
}

function ChapterNodeImpl({ data, selected }: NodeProps<ChapterNodeType>): ReactElement {
  const { entity, onDelete } = data
  const status = STATUS_STYLES[entity.status] ?? STATUS_STYLES.planned
  return (
    <div
      className={cn(
        'group relative w-[200px] rounded-lg border bg-card text-card-foreground shadow-sm transition-[box-shadow]',
        'border-emerald-500/40 dark:border-emerald-400/40',
        selected && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-emerald-500" />
      <Handle type="target" position={Position.Left} className="!bg-emerald-500" />
      <Handle type="source" position={Position.Right} className="!bg-emerald-500" />

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

      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 bg-emerald-500/10 rounded-t-lg">
        <FileText className="size-3.5 text-emerald-500 dark:text-emerald-400 shrink-0" />
        <span className="tabular-nums text-xs font-medium text-emerald-600 dark:text-emerald-300">
          第 {entity.chapterNumber} 章
        </span>
        <span className={cn('ml-auto size-2 rounded-full', status.dot)} aria-hidden="true" />
      </div>
      <div className="px-3 py-2 space-y-1">
        <div className="text-sm font-semibold text-text truncate" title={entity.title}>
          {entity.title || `第 ${entity.chapterNumber} 章`}
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className={cn('rounded px-1.5 py-0.5', status.className)}>
            {status.label}
          </span>
          <span className="tabular-nums text-muted-foreground">{entity.wordCount} 字</span>
        </div>
        {entity.volume > 0 && (
          <div className="text-[10px] text-hint">卷 {entity.volume}</div>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-emerald-500" />
    </div>
  )
}

export const ChapterNode = memo(ChapterNodeImpl)
