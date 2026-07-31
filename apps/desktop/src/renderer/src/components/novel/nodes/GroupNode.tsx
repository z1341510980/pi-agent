import { memo, useState, type ReactElement } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { ChevronDown, ChevronRight, Users, Lightbulb, Swords, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── 数据类型 ──

export type GroupEntityType = 'character' | 'chapter' | 'conflict' | 'foreshadow'

export interface GroupEntity {
  id: string
  name: string
}

export type GroupNodeData = {
  title: string
  entityType: GroupEntityType
  entities: GroupEntity[]
  onDelete?: () => void
}

export type GroupNodeType = Node<GroupNodeData, 'group'>

// ── 实体类型样式映射 ──

const ENTITY_STYLES: Record<GroupEntityType, {
  icon: typeof Users
  label: string
  border: string
  bg: string
  text: string
  dot: string
}> = {
  character: {
    icon: Users,
    label: '角色',
    border: 'border-blue-500/40 dark:border-blue-400/40',
    bg: 'bg-blue-500/10',
    text: 'text-blue-600 dark:text-blue-300',
    dot: '!bg-blue-500',
  },
  foreshadow: {
    icon: Lightbulb,
    label: '伏笔',
    border: 'border-amber-500/40 dark:border-amber-400/40',
    bg: 'bg-amber-500/10',
    text: 'text-amber-600 dark:text-amber-300',
    dot: '!bg-amber-500',
  },
  conflict: {
    icon: Swords,
    label: '冲突',
    border: 'border-rose-500/40 dark:border-rose-400/40',
    bg: 'bg-rose-500/10',
    text: 'text-rose-600 dark:text-rose-300',
    dot: '!bg-rose-500',
  },
  chapter: {
    icon: FileText,
    label: '章节',
    border: 'border-emerald-500/40 dark:border-emerald-400/40',
    bg: 'bg-emerald-500/10',
    text: 'text-emerald-600 dark:text-emerald-300',
    dot: '!bg-emerald-500',
  },
}

const MAX_VISIBLE = 5

function GroupNodeImpl({ data, selected }: NodeProps<GroupNodeType>): ReactElement {
  const { title, entityType, entities } = data
  const [expanded, setExpanded] = useState(false)
  const style = ENTITY_STYLES[entityType]
  const Icon = style.icon
  const visibleEntities = expanded ? entities.slice(0, MAX_VISIBLE) : []
  const overflow = entities.length - visibleEntities.length

  return (
    <div
      className={cn(
        'group relative w-[220px] rounded-lg border bg-card text-card-foreground shadow-sm transition-[box-shadow]',
        style.border,
        selected && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
      )}
    >
      {/* 四向 Handle */}
      <Handle type="target" position={Position.Top} className={style.dot} />
      <Handle type="target" position={Position.Left} className={style.dot} />
      <Handle type="source" position={Position.Right} className={style.dot} />
      <Handle type="source" position={Position.Bottom} className={style.dot} />

      {/* 头部 */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setExpanded((v) => !v)
        }}
        className="flex w-full items-center gap-2 border-b border-border/60 px-3 py-1.5 rounded-t-lg hover:bg-muted/30 active:scale-[0.96]"
        title={expanded ? '点击折叠' : '点击展开'}
      >
        <Icon className={cn('size-3.5 shrink-0', style.text)} />
        <span className={cn('text-xs font-medium', style.text)}>{style.label}集合</span>
        <span className="ml-auto tabular-nums rounded bg-muted px-1.5 py-0.5 text-nano text-muted-foreground">
          {entities.length}
        </span>
        {expanded ? (
          <ChevronDown className="size-3 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 text-muted-foreground" />
        )}
      </button>

      {/* 标题 */}
      <div className="px-3 py-1.5">
        <div className="text-sm font-semibold text-text truncate" title={title}>
          {title}
        </div>
      </div>

      {/* 展开后的实体列表 */}
      {expanded && (
        <div className="px-3 pb-2 space-y-0.5">
          {visibleEntities.map((e) => (
            <div
              key={e.id}
              className="text-xs text-muted-foreground truncate py-0.5"
              title={e.name}
            >
              · {e.name}
            </div>
          ))}
          {overflow > 0 && (
            <div className="text-nano text-subtle">
              +{overflow} 更多
            </div>
          )}
          {entities.length === 0 && (
            <div className="text-nano text-subtle">暂无实体</div>
          )}
        </div>
      )}
    </div>
  )
}

export const GroupNode = memo(GroupNodeImpl)
