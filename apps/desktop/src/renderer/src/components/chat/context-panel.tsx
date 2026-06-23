import type { ReactElement } from 'react'
import { useMemo } from 'react'
import {
  ArchiveIcon,
  Loader2Icon,
  FileTextIcon,
  BrainIcon,
  FolderOpenIcon,
  ActivityIcon,
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

/** 关联文件 */
export interface AssociatedFile {
  /** 文件路径（绝对或相对） */
  path: string
  /** 触发文件操作的工具名 */
  toolName: string
  /** 操作时间戳 */
  timestamp: number
}

/** 记忆摘要数据 */
export interface MemorySummaryData {
  /** LLM 生成的摘要 */
  summary: string
  /** 关键决策 */
  keyDecisions: string[]
  /** 主题标签 */
  topics: string[]
  /** 更新时间戳 */
  updatedAt: number
}

/** 活动日志条目 */
export interface ActivityEntry {
  /** 活动描述 */
  label: string
  /** 附加信息 */
  meta?: string
  /** 时间戳 */
  timestamp: number
}

interface ContextPanelProps {
  stats: ContextStats
  isOnline?: boolean
  isCompacting?: boolean
  onCompact?: () => void
  onOpenSettings?: () => void
  onViewDetails?: () => void
  /** 当前工作区路径 */
  workspacePath?: string
  /** 关联文件列表 */
  associatedFiles?: AssociatedFile[]
  /** 记忆摘要 */
  memorySummary?: MemorySummaryData | null
  /** 活动日志 */
  activities?: ActivityEntry[]
}

// ── 默认配置 ──

const DEFAULT_GENERATION_LIMIT = 50
const MAX_ACTIVITIES = 8
const MAX_ASSOCIATED_FILES = 6

// ── 主组件 ──

export function ContextPanel({
  stats,
  isCompacting = false,
  onCompact,
  onViewDetails,
  workspacePath,
  associatedFiles = [],
  memorySummary = null,
  activities = [],
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

  const recentActivities = useMemo(() => {
    return [...activities]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_ACTIVITIES)
  }, [activities])

  const recentFiles = useMemo(() => {
    return [...associatedFiles]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_ASSOCIATED_FILES)
  }, [associatedFiles])

  return (
    <section className="grid gap-2.5 min-h-0 overflow-auto p-4 align-content-start" aria-label="上下文状态">
      {/* ── 顶部标题 ── */}
      <header className="flex items-center justify-between">
        <h2 className="text-xs font-medium text-text m-0">上下文</h2>
      </header>

      {/* ── 工作区路径 ── */}
      {workspacePath && (
        <div className="bg-card-bg rounded-md p-2.5 grid gap-1">
          <div className="flex items-center gap-1.5">
            <FolderOpenIcon className="size-3 text-subtle" />
            <span className="text-[11px] font-medium text-text">工作区</span>
          </div>
          <p className="text-[10px] text-subtle m-0 truncate" title={workspacePath}>
            {shortenPath(workspacePath)}
          </p>
          <p className="text-[9px] text-subtle/70 m-0">文件工具的读写根目录</p>
        </div>
      )}

      {/* ── 会话用量统计 ── */}
      <div className="bg-card-bg rounded-md p-2.5 grid gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-text">当前上下文占用</span>
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
          <ProgressBar label="上下文窗口" current={stats.tokensUsed} max={stats.contextWindow} percentage={tokenPct} variant="primary" />
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
        {recentFiles.length > 0 ? (
          <ul className="grid gap-0.5">
            {recentFiles.map((file, index) => (
              <li key={`${file.path}-${index}`} className="flex items-center justify-between gap-2 text-[10px] text-subtle">
                <span className="truncate" title={file.path}>{shortenPath(file.path)}</span>
                <span className="shrink-0 text-[9px] text-subtle/70">{file.toolName}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[10px] text-subtle m-0">当前会话暂无关联文件</p>
        )}
      </div>

      {/* ── 记忆摘要 ── */}
      <div className="bg-card-bg rounded-md p-2.5 grid gap-1.5">
        <div className="flex items-center gap-1.5">
          <BrainIcon className="size-3 text-subtle" />
          <span className="text-[11px] font-medium text-text">记忆摘要</span>
        </div>
        {memorySummary ? (
          <div className="grid gap-1">
            <p className="text-[10px] text-text-secondary m-0 line-clamp-3">{memorySummary.summary}</p>
            {memorySummary.topics.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {memorySummary.topics.slice(0, 4).map((topic) => (
                  <span key={topic} className="text-[9px] px-1 py-px rounded bg-surface-3 text-subtle">
                    {topic}
                  </span>
                ))}
              </div>
            )}
            {memorySummary.keyDecisions.length > 0 && (
              <ul className="grid gap-0.5">
                {memorySummary.keyDecisions.slice(0, 3).map((decision, i) => (
                  <li key={i} className="text-[10px] text-subtle m-0 truncate">
                    · {decision}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <p className="text-[10px] text-subtle m-0">暂无记忆数据</p>
        )}
      </div>

      {/* ── 活动日志 ── */}
      <div className="bg-card-bg rounded-md p-2.5 grid gap-1.5">
        <div className="flex items-center gap-1.5">
          <ActivityIcon className="size-3 text-subtle" />
          <span className="text-[11px] font-medium text-text">活动日志</span>
        </div>
        {recentActivities.length > 0 ? (
          <ul className="grid gap-0.5">
            {recentActivities.map((activity, index) => (
              <li key={index} className="flex items-center justify-between gap-2 text-[10px] text-subtle">
                <span className="truncate">{activity.label}</span>
                <span className="shrink-0">{activity.meta ?? formatRelativeTime(activity.timestamp)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[10px] text-subtle m-0">暂无活动记录</p>
        )}
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

// ── 工具函数 ──

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

function shortenPath(fullPath: string): string {
  const segments = fullPath.replace(/\\/g, '/').split('/')
  if (segments.length >= 3) {
    return '.../' + segments.slice(-2).join('/')
  }
  return fullPath
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}
