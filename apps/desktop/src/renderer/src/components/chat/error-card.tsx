import { useState, type ReactElement } from 'react'
import {
  AlertCircle,
  ChevronDown,
  Minimize2,
  RotateCcw,
  Settings,
  StopCircle,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { classifyStreamError, OWNERSHIP_LABELS, type ErrorOwnership } from '@/lib/error-classify'
import { cn } from '@/lib/utils'

export interface ErrorCardProps {
  message: string
  onRetry?: () => void
  retryLabel?: string
  onDismiss?: () => void
  /** 打开设置页（鉴权 / 模型 / 代理类问题的修复入口） */
  onOpenSettings?: () => void
  /** 压缩上下文（上下文超限的修复入口） */
  onCompact?: () => void
}

/**
 * ErrorCard：结构化错误卡片。
 *
 * 原来只有一行红字 + 一个永远显示的「重试」。现在把 `classifyStreamError` 的
 * 判断呈现出来：
 *
 * - **归属标签**告诉用户该找谁（模型服务 / 网络 / 应用 / Agent）
 * - **不可重试时不显示重试按钮** —— API Key 无效时给一个注定失败的按钮，
 *   比不给更糟
 * - **给一个能直接点的修复入口**（去设置 / 压缩上下文），而不是让用户自己猜
 * - **原始报错折叠**在「技术细节」里：需要它的人找得到，不需要的人不被它淹没
 *
 * 用户主动中断走中性配色 —— 那不是错误，用红框吓人没道理。
 */
export function ErrorCard({
  message,
  onRetry,
  retryLabel = '重试',
  onDismiss,
  onOpenSettings,
  onCompact
}: ErrorCardProps): ReactElement {
  const [detailOpen, setDetailOpen] = useState(false)
  const info = classifyStreamError(message)

  // 中断不是错误：用中性色，不用 destructive
  const tone = info.aborted
    ? {
        container: 'border-border bg-surface-2',
        icon: 'text-hint',
        title: 'text-text',
        button: 'text-text-secondary hover:bg-surface-3'
      }
    : {
        container: 'border-destructive/45 bg-destructive/8',
        icon: 'text-destructive',
        title: 'text-destructive',
        button: 'text-destructive hover:bg-destructive/15'
      }

  const Icon = info.aborted ? StopCircle : AlertCircle

  // 原始报错与标题重复时就不必再折叠一份
  const showDetail = info.raw.length > 0 && info.raw !== info.title

  return (
    <div className={cn('rounded-xl border px-3.5 py-3', tone.container)}>
      <div className="flex items-start gap-2.5">
        <Icon className={cn('mt-0.5 size-4 shrink-0', tone.icon)} aria-hidden />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className={cn('text-sm font-medium', tone.title)}>{info.title}</p>
            {!info.aborted && <OwnershipTag ownership={info.ownership} />}
            {!info.aborted && !info.retryable && (
              <span className="rounded bg-surface-3 px-1.5 py-0.5 text-nano text-hint">
                重试无效
              </span>
            )}
          </div>

          <p className="mt-1 text-caption leading-relaxed text-text-secondary">{info.hint}</p>

          <div className="mt-2 flex flex-wrap items-center gap-1">
            {info.retryable && onRetry && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onRetry}
                className={cn('h-7 gap-1 px-2 text-xs', tone.button)}
              >
                <RotateCcw className="size-3" />
                {retryLabel}
              </Button>
            )}
            {info.action === 'open-settings' && onOpenSettings && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onOpenSettings}
                className={cn('h-7 gap-1 px-2 text-xs', tone.button)}
              >
                <Settings className="size-3" />
                打开设置
              </Button>
            )}
            {info.action === 'compact' && onCompact && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onCompact}
                className={cn('h-7 gap-1 px-2 text-xs', tone.button)}
              >
                <Minimize2 className="size-3" />
                压缩上下文
              </Button>
            )}
            {showDetail && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDetailOpen((v) => !v)}
                aria-expanded={detailOpen}
                className="h-7 gap-1 px-2 text-xs text-hint hover:bg-surface-3 hover:text-text"
              >
                <ChevronDown
                  className={cn('size-3 transition-transform', detailOpen && 'rotate-180')}
                />
                技术细节
              </Button>
            )}
          </div>

          {detailOpen && showDetail && (
            <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-surface-1/70 px-2.5 py-2 font-mono text-nano leading-relaxed whitespace-pre-wrap break-words text-text-secondary">
              {info.raw}
            </pre>
          )}
        </div>

        {onDismiss && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onDismiss}
            aria-label="关闭错误提示"
            className={cn('size-7 shrink-0 p-0', tone.button)}
          >
            <X className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  )
}

/** 归属标签：不同来源用不同色，让人一眼分清「该找谁」 */
function OwnershipTag({ ownership }: { ownership: ErrorOwnership }): ReactElement {
  const toneByOwnership: Record<ErrorOwnership, string> = {
    provider: 'bg-orange-500/12 text-orange-700 dark:text-orange-300',
    network: 'bg-sky-500/12 text-sky-700 dark:text-sky-300',
    app: 'bg-violet-500/12 text-violet-700 dark:text-violet-300',
    agent: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
    unknown: 'bg-surface-3 text-hint'
  }

  return (
    <span className={cn('rounded px-1.5 py-0.5 text-nano', toneByOwnership[ownership])}>
      {OWNERSHIP_LABELS[ownership]}
    </span>
  )
}
