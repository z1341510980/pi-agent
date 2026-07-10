import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArchiveIcon, XIcon, ChevronDownIcon, ChevronUpIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

// ── 类型定义 ──

export interface CompactionEvent {
  /** 唯一 ID */
  id: string
  /** 触发时间戳 */
  timestamp: number
  /** 压缩前 token 数 */
  tokensBefore?: number
  /** 压缩后 token 数 */
  tokensAfter?: number
  /** 压缩的消息数 */
  messagesCompacted?: number
  /** 触发原因：manual（手动）/ auto（自动阈值触发） */
  reason: 'manual' | 'auto'
  /** 状态 */
  state: 'running' | 'success' | 'error'
  /** 错误信息（state=error 时） */
  errorMessage?: string
}

interface CompactionBannerProps {
  /** 最近的压缩事件（null 时隐藏横幅） */
  event: CompactionEvent | null
  /** 关闭横幅 */
  onDismiss: () => void
  /** 触发手动压缩 */
  onManualCompact?: () => void
}

// ── 主组件 ──

export function CompactionBanner({
  event,
  onDismiss,
  onManualCompact,
}: CompactionBannerProps): ReactElement | null {
  const [expanded, setExpanded] = useState(false)
  const [visible, setVisible] = useState(false)

  // 新事件到来时显示横幅
  useEffect(() => {
    if (!event) return
    setVisible(true)
    // 成功或错误状态 5 秒后自动折叠
    if (event.state !== 'running') {
      const t = window.setTimeout(() => setExpanded(false), 5000)
      return () => window.clearTimeout(t)
    }
    return undefined
  }, [event])

  if (!event || !visible) return null

  const reduction = event.tokensBefore && event.tokensAfter
    ? Math.max(0, event.tokensBefore - event.tokensAfter)
    : null
  const reductionPct = reduction && event.tokensBefore
    ? Math.round((reduction / event.tokensBefore) * 100)
    : null

  const stateConfig = {
    running: {
      bg: 'bg-accent/10 border-accent/30',
      text: 'text-accent',
      label: '正在压缩上下文...',
    },
    success: {
      bg: 'bg-success/10 border-success/30',
      text: 'text-success',
      label: '上下文已压缩',
    },
    error: {
      bg: 'bg-destructive/10 border-destructive/30',
      text: 'text-destructive',
      label: '压缩失败',
    },
  }[event.state]

  return (
    <div
      className={`mx-auto max-w-[720px] mb-3 rounded-lg border ${stateConfig.bg} px-3 py-2.5`}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2.5">
        <ArchiveIcon className={`size-4 shrink-0 ${stateConfig.text} ${event.state === 'running' ? 'animate-pulse' : ''}`} />

        <div className="flex-1 min-w-0 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`text-sm font-[760] ${stateConfig.text}`}>{stateConfig.label}</span>
            {event.reason === 'auto' && (
              <span className="text-xs text-muted-foreground shrink-0">自动触发</span>
            )}
            {reductionPct !== null && reduction !== null && (
              <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                减少 {reductionPct}% ({formatTokens(reduction)})
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {(event.tokensBefore || event.messagesCompacted) && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={() => setExpanded((v) => !v)}
                aria-label={expanded ? '收起详情' : '展开详情'}
                aria-expanded={expanded}
              >
                <AnimatePresence initial={false} mode="popLayout">
                  <motion.span
                    key={expanded ? 'up' : 'down'}
                    initial={{ opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
                    animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                    exit={{ opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
                    transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
                    className="flex items-center justify-center"
                  >
                    {expanded ? <ChevronUpIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />}
                  </motion.span>
                </AnimatePresence>
              </Button>
            )}
            {event.state !== 'running' && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={() => {
                  setVisible(false)
                  onDismiss()
                }}
                aria-label="关闭横幅"
              >
                <XIcon className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
      </div>

      {expanded && (
        <div className="mt-2 pt-2 border-t border-border/50 grid gap-1.5 text-xs">
          {event.tokensBefore && (
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">压缩前 Token</span>
              <code className="font-mono">{formatTokens(event.tokensBefore)}</code>
            </div>
          )}
          {event.tokensAfter && (
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">压缩后 Token</span>
              <code className="font-mono">{formatTokens(event.tokensAfter)}</code>
            </div>
          )}
          {event.messagesCompacted && (
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">压缩消息数</span>
              <code className="font-mono">{event.messagesCompacted}</code>
            </div>
          )}
          {event.state === 'error' && event.errorMessage && (
            <div className="text-destructive mt-1 break-all">{event.errorMessage}</div>
          )}
          {event.state === 'success' && onManualCompact && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="justify-start mt-1 h-7"
              onClick={() => {
                onManualCompact()
                setExpanded(false)
              }}
            >
              再次压缩
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

// ── 工具函数 ──

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`
  return String(tokens)
}
