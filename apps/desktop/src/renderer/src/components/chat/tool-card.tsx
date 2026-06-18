import type { ReactElement } from 'react'
import { Badge } from '@/components/ui/badge'
import type { ToolExecution, ToolExecutionState } from '@/hooks/use-tool-executions'

interface ToolCardProps {
  execution: ToolExecution
}

interface StateMeta {
  label: string
  dotClass: string
  badgeVariant: 'default' | 'secondary' | 'destructive' | 'outline'
}

const STATE_META: Record<ToolExecutionState, StateMeta> = {
  pending: {
    label: '等待确认',
    dotClass: 'bg-accent shadow-[0_0_0_4px_rgba(242,193,78,0.16)]',
    badgeVariant: 'secondary',
  },
  running: {
    label: '执行中',
    dotClass: 'bg-accent shadow-[0_0_0_4px_rgba(242,193,78,0.16)] animate-pulse',
    badgeVariant: 'default',
  },
  success: {
    label: '完成',
    dotClass: 'bg-success shadow-[0_0_0_4px_rgba(47,209,124,0.16)]',
    badgeVariant: 'outline',
  },
  error: {
    label: '失败',
    dotClass: 'bg-danger shadow-[0_0_0_4px_rgba(255,107,107,0.16)]',
    badgeVariant: 'destructive',
  },
  denied: {
    label: '已拒绝',
    dotClass: 'bg-muted',
    badgeVariant: 'outline',
  },
}

function formatTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-CN', { hour12: false })
}

function durationMs(exec: ToolExecution): string {
  if (!exec.startedAt || !exec.endedAt) return ''
  const ms = exec.endedAt - exec.startedAt
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function ToolCard({ execution }: ToolCardProps): ReactElement {
  const meta = STATE_META[execution.state]
  const dur = durationMs(execution)

  return (
    <article className="bg-surface-1 border border-border rounded-lg px-3.5 py-3 grid gap-1.5">
      <header className="flex items-center gap-2 min-w-0">
        <span className={`shrink-0 size-[9px] rounded-full ${meta.dotClass}`} />
        <code className="text-sm font-mono font-[760] break-anywhere min-w-0 truncate">
          {execution.toolName}
        </code>
        <Badge variant={meta.badgeVariant} className="ml-auto shrink-0">
          {meta.label}
        </Badge>
      </header>

      {execution.reason && execution.state === 'pending' && (
        <p className="text-muted text-xs leading-snug m-0">{execution.reason}</p>
      )}

      <footer className="flex items-center gap-3 text-subtle text-[11px] font-mono">
        {execution.startedAt && (
          <time>{formatTime(execution.startedAt)}</time>
        )}
        {dur && <span>· {dur}</span>}
        <span className="truncate">· {execution.toolCallId.slice(0, 8)}</span>
      </footer>
    </article>
  )
}

interface ToolCardListProps {
  executions: ToolExecution[]
  emptyHint?: string
}

export function ToolCardList({ executions, emptyHint = '暂无工具调用' }: ToolCardListProps): ReactElement {
  if (executions.length === 0) {
    return (
      <p className="text-subtle text-xs text-center py-6 m-0">{emptyHint}</p>
    )
  }

  return (
    <div className="grid gap-2">
      {executions.map((exec) => (
        <ToolCard key={exec.toolCallId} execution={exec} />
      ))}
    </div>
  )
}
