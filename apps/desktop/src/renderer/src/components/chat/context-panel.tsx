import type { ReactElement } from 'react'
import { useMemo } from 'react'
import {
  ArchiveIcon,
  Loader2Icon,
  FileTextIcon,
  BrainIcon,
  FolderOpenIcon,
  ZapIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ActivityIcon,
} from 'lucide-react'

// ── 类型定义 ──

export interface ContextStats {
  /** 当前上下文窗口实际占用的 token 数（来自 LLM usage.totalTokens） */
  tokensUsed: number
  /** 上下文窗口大小（模型限制） */
  contextWindow: number
  /** 消息数量 */
  messageCount: number
  /** 工具调用次数 */
  toolCallCount: number
  /** 压缩次数 */
  compactionCount: number
  /** LLM 生成次数 */
  generationCount?: number
  /** 生成次数上限 */
  generationLimit?: number
  /** 累计输入 tokens */
  totalInputTokens?: number
  /** 累计输出 tokens */
  totalOutputTokens?: number
  /** 当前模型 */
  model?: string
  /** 当前 provider */
  provider?: string
}

/** 关联文件 */
export interface AssociatedFile {
  path: string
  toolName: string
  timestamp: number
}

/** 记忆摘要数据 */
export interface MemorySummaryData {
  summary: string
  keyDecisions: string[]
  topics: string[]
  updatedAt: number
}

/** 活动日志条目 */
export interface ActivityEntry {
  label: string
  meta?: string
  timestamp: number
}

interface ContextPanelProps {
  stats: ContextStats
  isOnline?: boolean
  isCompacting?: boolean
  onCompact?: () => void
  onOpenSettings?: () => void
  onViewDetails?: () => void
  workspacePath?: string
  associatedFiles?: AssociatedFile[]
  memorySummary?: MemorySummaryData | null
  activities?: ActivityEntry[]
}

// ── 默认配置 ──

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

  // 上下文占用等级颜色
  const contextLevel = useMemo(() => {
    if (tokenPct >= 90) return 'critical'
    if (tokenPct >= 70) return 'warning'
    return 'normal'
  }, [tokenPct])

  return (
    <section className="grid gap-2.5 min-h-0 overflow-auto p-4 align-content-start" aria-label="上下文状态">
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
        </div>
      )}

      {/* ── 上下文 & 会话用量 & 压缩（整合卡片）── */}
      <div className="bg-card-bg rounded-md p-2.5 grid gap-2.5">
        {/* 标题行 */}
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-text">上下文 & 用量</span>
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

        {/* 上下文占用进度条 */}
        <div className="grid gap-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-text-secondary">上下文占用</span>
            <span className={`text-[10px] ${contextLevel === 'critical' ? 'text-error' : contextLevel === 'warning' ? 'text-warning' : 'text-subtle'}`}>
              {formatNumber(stats.tokensUsed)} / {formatNumber(stats.contextWindow)}
              <span className="text-[9px] ml-1">({tokenPct}%)</span>
            </span>
          </div>
          <div
            className="h-1.5 bg-surface-3 rounded-[2px] overflow-hidden"
            role="progressbar"
            aria-valuenow={tokenPct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={`h-full transition-[width,background-color] duration-500 ${contextLevel === 'critical' ? 'bg-error' : contextLevel === 'warning' ? 'bg-warning' : 'bg-primary'}`}
              style={{ width: `${tokenPct}%` }}
            />
          </div>
        </div>

        {/* Token 用量统计 */}
        <div className="grid grid-cols-2 gap-2">
          <div className="flex items-center gap-1.5 rounded bg-surface-2 px-2 py-1.5">
            <ArrowDownIcon className="size-3 text-primary shrink-0" />
            <div className="grid gap-0 min-w-0">
              <span className="text-[9px] text-subtle leading-tight">输入 Tokens</span>
              <span className="text-[11px] font-medium text-text leading-tight">
                {formatNumber(stats.totalInputTokens ?? stats.tokensUsed)}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1.5 rounded bg-surface-2 px-2 py-1.5">
            <ArrowUpIcon className="size-3 text-success shrink-0" />
            <div className="grid gap-0 min-w-0">
              <span className="text-[9px] text-subtle leading-tight">输出 Tokens</span>
              <span className="text-[11px] font-medium text-text leading-tight">
                {formatNumber(stats.totalOutputTokens ?? 0)}
              </span>
            </div>
          </div>
        </div>

        {/* 统计指标行 */}
        <div className="flex items-center gap-2 text-[10px] text-subtle flex-wrap tabular-nums">
          <span className="inline-flex items-center gap-0.5">
            <ZapIcon className="size-2.5" />
            {stats.generationCount ?? 0} 次生成
          </span>
          <span aria-hidden="true">·</span>
          <span>{stats.messageCount} 消息</span>
          <span aria-hidden="true">·</span>
          <span>{stats.toolCallCount} 工具</span>
        </div>

        {/* 模型信息 */}
        {stats.model && (
          <div className="text-[9px] text-subtle/70 truncate">
            {stats.provider}/{stats.model}
          </div>
        )}

        {/* 压缩操作 */}
        {onCompact && (
          <div className="flex items-center justify-between gap-2 pt-1 border-t border-border">
            <span className="text-[10px] text-text-secondary">
              {isCompacting ? '正在压缩…' : `已压缩 ${stats.compactionCount} 次`}
            </span>
            <span
              role="button"
              tabIndex={0}
              onClick={onCompact}
              onKeyDown={(e) => { if (e.key === 'Enter') onCompact() }}
              className="shrink-0 inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-subtle border border-border hover:bg-surface-3 hover:text-text transition-colors cursor-pointer"
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
        )}
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
      <div className="bg-card-bg rounded-md p-2.5 grid gap-1.5 min-w-0">
        <div className="flex items-center gap-1.5">
          <ActivityIcon className="size-3 text-subtle" />
          <span className="text-[11px] font-medium text-text">活动日志</span>
        </div>
        {recentActivities.length > 0 ? (
          <ul className="grid gap-0.5 min-w-0">
            {recentActivities.map((activity, index) => (
              <li key={index} className="flex items-center justify-between gap-2 text-[10px] text-subtle min-w-0">
                <span className="truncate min-w-0">{activity.label}</span>
                <span className="shrink-0 text-[9px]">{activity.meta ?? formatRelativeTime(activity.timestamp)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[10px] text-subtle m-0">暂无活动记录</p>
        )}
      </div>
    </section>
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
  if (diff < 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}
