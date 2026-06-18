import { CheckCircle2, Loader2, XCircle, Wrench } from 'lucide-react'
import type { ToolCallInfo } from './types'
import { cn } from '@/lib/utils'

export interface ToolCallCardProps {
  toolCall: ToolCallInfo
}

/**
 * ToolCallCard：工具调用卡片
 *
 * 显示工具名、参数、状态、部分结果
 * 状态：running（旋转图标）/ success（勾选）/ error（叉号）
 */
export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const { toolName, status, args, partialResult } = toolCall

  const StatusIcon =
    status === 'running'
      ? Loader2
      : status === 'success'
        ? CheckCircle2
        : status === 'error'
          ? XCircle
          : Wrench

  const statusColor =
    status === 'running'
      ? 'text-blue-500'
      : status === 'success'
        ? 'text-green-500'
        : status === 'error'
          ? 'text-destructive'
          : 'text-muted-foreground'

  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <StatusIcon
          className={cn(
            'h-3.5 w-3.5',
            statusColor,
            status === 'running' && 'animate-spin',
          )}
        />
        <span className="font-mono font-medium">{toolName}</span>
        <span className={cn('ml-auto', statusColor)}>
          {status === 'running' ? '执行中' : status === 'success' ? '完成' : status === 'error' ? '失败' : '等待'}
        </span>
      </div>

      {/* 参数 */}
      {args !== undefined && (
        <div className="mt-2 border-t border-border pt-2">
          <div className="text-muted-foreground">参数</div>
          <pre className="mt-1 overflow-auto rounded bg-muted/50 p-2 text-[11px]">
            {typeof args === 'string' ? args : JSON.stringify(args, null, 2)}
          </pre>
        </div>
      )}

      {/* 部分结果 */}
      {partialResult !== undefined && (
        <div className="mt-2 border-t border-border pt-2">
          <div className="text-muted-foreground">部分结果</div>
          <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted/50 p-2 text-[11px]">
            {typeof partialResult === 'string'
              ? partialResult
              : JSON.stringify(partialResult, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
