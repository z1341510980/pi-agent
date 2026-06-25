import type { ReactElement } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { User } from 'lucide-react'
import type { NovelCharacter } from '@/api/novel-client'
import { cn } from '@/lib/utils'

export type CharacterNodeData = { entity: NovelCharacter }
export type CharacterNodeType = Node<CharacterNodeData, 'character'>

export function CharacterNode({ data, selected }: NodeProps<CharacterNodeType>): ReactElement {
  const { entity } = data
  return (
    <div
      className={cn(
        'w-[200px] rounded-lg border bg-card text-card-foreground shadow-sm transition-all',
        'border-blue-500/40 dark:border-blue-400/40',
        selected && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-blue-500" />
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 bg-blue-500/10 rounded-t-lg">
        <User className="size-3.5 text-blue-500 dark:text-blue-400 shrink-0" />
        <span className="text-xs font-medium text-blue-600 dark:text-blue-300">角色</span>
      </div>
      <div className="px-3 py-2 space-y-1">
        <div className="text-sm font-semibold text-text truncate" title={entity.name}>
          {entity.name}
        </div>
        {entity.identity && (
          <div className="text-xs text-muted-foreground truncate" title={entity.identity}>
            {entity.identity}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1">
          {entity.arcStage && (
            <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-600 dark:text-blue-300">
              弧光: {entity.arcStage}
            </span>
          )}
        </div>
        {entity.currentState && (
          <div className="text-xs text-subtle line-clamp-2" title={entity.currentState}>
            {entity.currentState}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-blue-500" />
    </div>
  )
}
