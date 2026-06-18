import { Brain, ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'

export interface ThinkingBlockProps {
  content: string
  isStreaming: boolean
}

/**
 * ThinkingBlock：思考块（可折叠）
 *
 * 显示 REASONING_/THINKING_ 事件的内容
 * 流式时默认展开，完成后默认折叠
 */
export function ThinkingBlock({ content, isStreaming }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(isStreaming)

  return (
    <div className="rounded-lg border border-border bg-muted/30">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:bg-muted/50"
      >
        <Brain className="h-3.5 w-3.5" />
        <span>
          {isStreaming ? '思考中...' : '思考过程'}
        </span>
        <ChevronDown
          className={cn(
            'ml-auto h-3.5 w-3.5 transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </button>
      {expanded && (
        <div className="border-t border-border px-3 py-2">
          <pre className="whitespace-pre-wrap text-xs text-muted-foreground">
            {content}
          </pre>
        </div>
      )}
    </div>
  )
}
