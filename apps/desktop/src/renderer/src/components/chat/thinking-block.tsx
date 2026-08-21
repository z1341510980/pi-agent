import { ChevronDown, ChevronRight, Clock } from 'lucide-react'
import { useEffect, useState, type ReactElement } from 'react'
import type { ThinkingBlock as ThinkingBlockData } from './types'
import { cn } from '@/lib/utils'

export interface ThinkingBlockProps extends ThinkingBlockData {}

/** 格式化耗时（ms → 可读字符串） */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  return `${minutes}m${seconds}s`
}

/**
 * ThinkingBlock：思考行（对齐 dsh ReasoningRow）
 *
 * 设计要点（DeepSeek 会话流）：
 *   - 无卡片边框：一条 24px 单行 —— [16px 图标] gap6 [标题 14/24] · [摘要省略]
 *   - 流式时标题"思考中"，完成后"已深度思考（耗时）"
 *   - 展开体：14/24 三级灰，左缩进 22px 与图标对齐
 *   - 运行中整行带背景扫光（dsh-sweep-host）
 *   - 流式默认展开，结束自动折叠
 */
export function ThinkingBlock({ content, isStreaming, startedAt, endedAt }: ThinkingBlockProps): ReactElement {
  const [expanded, setExpanded] = useState(isStreaming)

  // 流式时实时刷新耗时
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!isStreaming) return
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [isStreaming])

  // 耗时
  const durationMs = startedAt ? (endedAt ?? now) - startedAt : null
  const durationLabel =
    durationMs != null && durationMs >= 0 && !isStreaming ? formatDuration(durationMs) : null

  // 标题：流式"思考中"，完成"已深度思考"
  const title = isStreaming ? '思考中' : '已深度思考'

  // 摘要：内容首行
  const summary = content.trim().split('\n')[0] || ''

  return (
    <div className="flex min-w-0 flex-col" data-state={isStreaming ? 'running' : 'done'}>
      {/* 折叠头 */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={cn(
          'dsh-sweep-host group/think -mx-1 flex w-[calc(100%+8px)] items-center rounded-md px-1 py-1 text-left',
          'transition-colors hover:bg-accent'
        )}
        data-running={isStreaming ? 'true' : undefined}
        aria-expanded={expanded}
      >
        {/* 引导图标：hover 时由右箭头切换为下箭头 */}
        <span className="relative mr-1.5 inline-flex size-4 shrink-0 items-center justify-center text-subtle">
          <ChevronRight
            className={cn(
              'absolute size-4 transition-opacity duration-100 group-hover/think:opacity-0',
              expanded && 'opacity-0 group-hover/think:opacity-0'
            )}
            aria-hidden="true"
          />
          <ChevronDown
            className={cn(
              'absolute size-4 opacity-0 transition-opacity duration-100 group-hover/think:opacity-100',
              expanded && 'opacity-100'
            )}
            aria-hidden="true"
          />
        </span>

        {/* 标题 */}
        <span className="shrink-0 text-sm leading-6 text-text-secondary">{title}</span>

        {/* 耗时 */}
        {durationLabel && (
          <span className="ml-2 flex shrink-0 items-center gap-1 text-xs leading-5 text-hint">
            <Clock className="size-3" aria-hidden="true" />
            {durationLabel}
          </span>
        )}

        {/* 分隔点 + 摘要（仅折叠且非流式时显示） */}
        {!expanded && !isStreaming && (
          <>
            <span className="mx-2 size-0.5 shrink-0 rounded-full bg-hint" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-sm leading-6 text-subtle">
              {summary}
            </span>
          </>
        )}
      </button>

      {/* 展开体 */}
      {expanded && (
        <div className="py-1 pl-[22px] pr-1">
          <pre className="m-0 font-sans whitespace-pre-wrap break-words text-sm leading-6 text-subtle">
            {content}
          </pre>
        </div>
      )}
    </div>
  )
}
