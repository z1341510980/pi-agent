import { Copy, RefreshCw, Reply } from 'lucide-react'
import { toast } from '@/hooks/use-toast'

interface MessageHoverToolbarProps {
  messageId: string
  content: string
  onRetry?: (id: string) => void
  onQuote?: (id: string) => void
}

/**
 * MessageHoverToolbar：消息 hover 时浮现的操作工具栏（Stage 2 Task 2.2）
 *
 * 参考 AionUi `MessageText`：静态时干净，悬停给操作。
 * - 位置：absolute -top-3 right-2，浮在气泡上方
 * - 默认 opacity-0，父容器加 `group` 时 group-hover 显示
 * - 按钮：copy（必有）/ retry（可选）/ quote（可选）
 */
export function MessageHoverToolbar({
  messageId,
  content,
  onRetry,
  onQuote
}: MessageHoverToolbarProps) {
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      toast({ title: '已复制' })
    } catch {
      toast({ title: '复制失败', variant: 'destructive' })
    }
  }

  return (
    <div className="absolute -top-3 right-2 flex items-center gap-0.5 rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] p-0.5 opacity-0 shadow-md transition-opacity group-hover:opacity-100">
      <button onClick={handleCopy} className="rounded p-1 hover:bg-[var(--fill-2)]" title="复制">
        <Copy className="h-3 w-3 text-[var(--t-secondary)]" />
      </button>
      {onRetry && (
        <button
          onClick={() => onRetry(messageId)}
          className="rounded p-1 hover:bg-[var(--fill-2)]"
          title="重发"
        >
          <RefreshCw className="h-3 w-3 text-[var(--t-secondary)]" />
        </button>
      )}
      {onQuote && (
        <button
          onClick={() => onQuote(messageId)}
          className="rounded p-1 hover:bg-[var(--fill-2)]"
          title="引用"
        >
          <Reply className="h-3 w-3 text-[var(--t-secondary)]" />
        </button>
      )}
    </div>
  )
}
