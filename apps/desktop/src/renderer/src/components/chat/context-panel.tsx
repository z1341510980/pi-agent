import type { ReactElement } from 'react'
import { useMemo } from 'react'
import {
  ArchiveIcon,
  Loader2Icon,
  FileTextIcon,
  BrainIcon,
} from 'lucide-react'

// ── 类型定义 ──

export interface ContextStats {
  tokensUsed: number
  contextWindow: number
  messageCount: number
  toolCallCount: number
  compactionCount: number
  generationCount?: number
  generationLimit?: number
}

interface ContextPanelProps {
  stats: ContextStats
  isOnline?: boolean
  isCompacting?: boolean
  onCompact?: () => void
  onOpenSettings?: () => void
  onViewDetails?: () => void
}

// ── 默认配置 ──

const DEFAULT_GENERATION_LIMIT = 50

/** 活动日志条目 */
const ACTIVITIES: { label: string; meta?: string }[] = [
  { label: '调用 design.generate', meta: '2 分钟前' },
  { label: '读取知识库', meta: '1 条' },
  { label: '压缩上下文', meta: '刚刚' },
]

// ── 主组件 ──

export function ContextPanel({
  stats,
  isCompacting = false,
  onCompact,
  onViewDetails,
}: ContextPanelProps): ReactElement {
  const tokenPct = useMemo(() => {
    if (stats.contextWindow <= 0) return 0
    return Math.min(100, Math.round((stats.tokensUsed / stats.contextWindow) * 100))
  }, [stats.tokensUsed, stats.contextWindow])

  const generationCount = stats.generationCount ?? stats.toolCallCount
  const generationLimit = stats.generationLimit ?? DEFAULT_GENERATION_LIMIT
  const generationPct = useMemo(() => {
    if (generationLimit <= 0) return 0
    return Math.min(100, Math.round((generationCount / generationLimit) * 100))
  }, [generationCount, generationLimit])

  return (
    <section className="grid gap-2.5 min-h-0 overflow-auto p-4 align-content-start" aria-label="上下文状态">
      {/* ── 顶部标题 ── */}
      <header className="flex items-center justify-between">
        <h2 className="text-xs font-medium text-text m-0">上下文</h2>
      </header>

      {/* ── 会话用量统计 ── */}
      <div className="bg-card-bg rounded-md p-2.5 grid gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-text">本次会话用量</span>
          {onViewDetails && (
            <span
              role="button"
              tabIndex={0}
              onClick={onViewDetails}
              onKeyDown={(e) => { if (e.key === 'Enter') onViewDetails() }}
              className="text-[10px] text-primary hover:underline cursor-pointer"
            >
              查看明细
            </span>
          )}
        </div>
        <div className="grid gap-1.5">
          <ProgressBar label="Tokens" current={stats.tokensUsed} max={stats.contextWindow} percentage={tokenPct} variant="primary" />
          <ProgressBar label="生成次数" current={generationCount} max={generationLimit} percentage={generationPct} variant="accent" />
        </div>
        <div className="flex items-center gap-2 text-[10px] text-subtle">
          <span>消息 {stats.messageCount}</span>
          <span aria-hidden="true">·</span>
          <span>工具 {stats.toolCallCount}</span>
          <span aria-hidden="true">·</span>
          <span>压缩 {stats.compactionCount} 次</span>
        </div>
      </div>

      {/* ── 关联文件 ── */}
      <div className="bg-card-bg rounded-md p-2.5 grid gap-1.5">
        <div className="flex items-center gap-1.5">
          <FileTextIcon className="size-3 text-subtle" />
          <span className="text-[11px] font-medium text-text">关联文件</span>
        </div>
        <p className="text-[10px] text-subtle m-0">当前会话暂无关联文件</p>
      </div>

      {/* ── 记忆摘要 ── */}
      <div className="bg-card-bg rounded-md p-2.5 grid gap-1.5">
        <div className="flex items-center gap-1.5">
          <BrainIcon className="size-3 text-subtle" />
          <span className="text-[11px] font-medium text-text">记忆摘要</span>
        </div>
        <p className="text-[10px] text-subtle m-0">暂无记忆数据</p>
      </div>

      {/* ── 活动日志 ── */}
      <div className="bg-card-bg rounded-md p-2.5 grid gap-1.5">
        <span className="text-[11px] font-medium text-text">活动日志</span>
        <ul className="grid gap-0.5">
          {ACTIVITIES.map((activity, index) => (
            <li key={index} className="flex items-center justify-between gap-2 text-[10px] text-subtle">
              <span className="truncate">{activity.label}</span>
              <span className="shrink-0">{activity.meta}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* ── 上下文压缩 ── */}
      {onCompact && (
        <div className="bg-card-bg rounded-md p-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="grid gap-0 min-w-0">
              <p className="text-[10px] text-text m-0">
                {isCompacting ? '正在压缩…' : `已压缩 ${stats.compactionCount} 次`}
              </p>
            </div>
            <span
              role="button"
              tabIndex={0}
              onClick={onCompact}
              className="shrink-0 inline-flex items-center gap-0.5 rounded px-1 py-px text-[10px] text-subtle border border-border hover:bg-surface-3 hover:text-text transition-colors cursor-pointer disabled:opacity-50"
              aria-label="手动压缩上下文"
            >
              {isCompacting ? (
                <Loader2Icon className="size-2.5 animate-spin" />
              ) : (
                <ArchiveIcon className="size-2.5" />
              )}
              {isCompacting ? '压缩中' : '压缩'}
            </span>
          </div>
        </div>
      )}
    </section>
  )
}

// ── 子组件 ──

function ProgressBar({
  label,
  current,
  max,
  percentage,
  variant,
}: {
  label: string
  current: number
  max: number
  percentage: number
  variant: 'primary' | 'accent'
}): ReactElement {
  const barColor = variant === 'primary' ? 'bg-primary' : 'bg-success'

  return (
    <div className="grid gap-0.5" role="group" aria-label={`${label} 用量`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-text-secondary">{label}</span>
        <span className="text-[10px] text-subtle">
          {formatNumber(current)} / {formatNumber(max)}
        </span>
      </div>
      <div
        className="h-0.5 bg-surface-3 rounded-[1px] overflow-hidden"
        role="progressbar"
        aria-valuenow={percentage}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className={`h-full transition-all duration-300 ${barColor}`} style={{ width: `${percentage}%` }} />
      </div>
    </div>
  )
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}
