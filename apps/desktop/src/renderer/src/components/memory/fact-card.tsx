import { Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** 事实数据类型（与后端 Fact 对齐） */
export interface FactItem {
  id: string
  content: string
  tags: string[]
  source: string
  confidence: number
  createdAt: number
  updatedAt: number
  accessCount: number
  lastAccessedAt: number
}

export interface FactCardProps {
  fact: FactItem
  onDelete?: (id: string) => void
  compact?: boolean
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function confidenceLabel(c: number): { text: string; color: string } {
  if (c >= 0.8) return { text: '高', color: 'text-success' }
  if (c >= 0.5) return { text: '中', color: 'text-accent' }
  return { text: '低', color: 'text-muted-foreground' }
}

export function FactCard({ fact, onDelete, compact }: FactCardProps) {
  const conf = confidenceLabel(fact.confidence)

  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5 text-xs grid gap-2">
      <div className="flex items-start justify-between gap-2">
        <p className="text-text leading-relaxed m-0 flex-1 min-w-0 break-words">
          {fact.content}
        </p>
        {onDelete && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="shrink-0 text-muted-foreground hover:text-danger"
            aria-label="删除事实"
            onClick={() => onDelete(fact.id)}
          >
            <Trash2 className="size-3" />
          </Button>
        )}
      </div>

      {!compact && (
        <div className="flex flex-wrap items-center gap-1.5">
          {fact.tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
              {tag}
            </Badge>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 text-muted-foreground">
        <span className={cn('font-medium', conf.color)}>
          置信度: {conf.text}
        </span>
        {!compact && (
          <>
            <span>来源: {fact.source}</span>
            <span>{formatTime(fact.createdAt)}</span>
          </>
        )}
      </div>
    </div>
  )
}
