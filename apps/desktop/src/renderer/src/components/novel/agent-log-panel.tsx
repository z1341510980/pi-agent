/**
 * Agent 调用日志面板
 *
 * 展示每次 Agent 调用的完整上下文记录：
 * - 日志列表：Agent 类型 / 章节号 / 状态 / 耗时 / 结果长度 / 时间
 * - 支持按章节号、Agent 类型过滤
 * - 点击单条日志可展开查看完整提示词三层结构：
 *   STATIC（系统提示词）+ SEMI（章节上下文）+ DYNAMIC（任务指令）+ 工具 + 结果
 *
 * 用途：调试提示词构建、排查 Agent 行为、审计创作流程
 */

import { useMemo, useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  RefreshCw,
  Trash2,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Clock,
  Hash,
  Wrench,
  FileText,
  Brain,
  Layers,
  AlertCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { useNovelDataStore } from '@/stores/novel-data-store'
import {
  listAgentLogs,
  getAgentLog,
  deleteAgentLogs,
  type NovelAgentLogSummary,
  type NovelAgentLog,
} from '@/api/novel-client'

// ── Agent 类型颜色与标签 ──

const AGENT_STYLE: Record<string, { label: string; badge: string }> = {
  director: { label: '导演', badge: 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/40' },
  writer: { label: '写作', badge: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40' },
  reviewer: { label: '审稿', badge: 'bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/40' },
  reviser: { label: '修订', badge: 'bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/40' },
  memory: { label: '记忆', badge: 'bg-gray-500/15 text-gray-700 dark:text-gray-300 border-gray-500/40' },
}

const STATUS_STYLE: Record<string, { label: string; icon: typeof CheckCircle2; color: string }> = {
  success: { label: '成功', icon: CheckCircle2, color: 'text-success' },
  error: { label: '失败', icon: XCircle, color: 'text-destructive' },
  cancelled: { label: '取消', icon: AlertCircle, color: 'text-muted-foreground' },
}

const AGENT_TYPE_FILTERS = ['', 'director', 'writer', 'reviewer', 'memory']

// ── 工具函数 ──

function formatTime(ts: number): string {
  const d = new Date(ts * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${s}s`
}

/** 格式化 token 数：>1000 显示为 k，>1_000_000 显示为 M */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return String(tokens)
}

/** 计算单条日志的缓存命中率：cacheRead / (cacheRead + input) */
function cacheHitRate(log: NovelAgentLogSummary): number | null {
  const promptTokens = log.cacheReadTokens + log.inputTokens
  if (promptTokens === 0) return null // 无 usage 数据
  return (log.cacheReadTokens / promptTokens) * 100
}

// ── 详情展开行 ──

interface LogDetailProps {
  id: string
}

function LogDetail({ id }: LogDetailProps): ReactElement {
  const detailQuery = useQuery({
    queryKey: ['novel-agent-log-detail', id],
    queryFn: () => getAgentLog(id),
    enabled: !!id,
  })

  if (detailQuery.isLoading) {
    return <div className="px-3 py-2 text-xs text-muted-foreground">加载详情...</div>
  }
  if (detailQuery.error) {
    return (
      <div className="px-3 py-2 text-xs text-destructive">
        加载失败：{detailQuery.error instanceof Error ? detailQuery.error.message : '未知错误'}
      </div>
    )
  }

  const log = detailQuery.data as NovelAgentLog | undefined
  if (!log) return <div className="px-3 py-2 text-xs text-muted-foreground">无数据</div>

  const sections: Array<{
    key: string
    label: string
    icon: typeof Brain
    color: string
    content: string
    length: number
  }> = [
    {
      key: 'system',
      label: 'STATIC · 系统提示词',
      icon: Brain,
      color: 'text-emerald-600 dark:text-emerald-400',
      content: log.systemPrompt,
      length: log.systemPrompt.length,
    },
    {
      key: 'context',
      label: 'SEMI · 章节上下文',
      icon: Layers,
      color: 'text-blue-600 dark:text-blue-400',
      content: log.chapterContext,
      length: log.chapterContext.length,
    },
    {
      key: 'task',
      label: 'DYNAMIC · 任务指令',
      icon: FileText,
      color: 'text-amber-600 dark:text-amber-400',
      content: log.taskInput,
      length: log.taskInput.length,
    },
    {
      key: 'result',
      label: 'Agent 输出结果',
      icon: Hash,
      color: 'text-primary',
      content: log.result,
      length: log.resultLength,
    },
  ]

  return (
    <div className="border-t border-border bg-background/40 px-3 py-2 space-y-2">
      {/* 元信息 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-nano text-muted-foreground tabular-nums">
        <span className="flex items-center gap-1">
          <Clock className="size-2.5" />
          耗时 {formatDuration(log.durationMs)}
        </span>
        <span className="flex items-center gap-1">
          <Wrench className="size-2.5" />
          工具 {log.toolNames.length} 个
        </span>
        {log.userInstructions.length > 0 && (
          <span className="text-primary">用户指令 {log.userInstructions.length} 条</span>
        )}
        {log.error && (
          <span className="text-destructive">错误：{log.error.slice(0, 100)}</span>
        )}
      </div>

      {/* LLM usage 诊断：input/output/cache read/cache write tokens */}
      {(log.inputTokens > 0 || log.cacheReadTokens > 0 || log.cacheWriteTokens > 0) && (
        <div className="rounded-md bg-surface-2 border border-border p-2 space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-nano font-medium text-text">LLM Usage 诊断</span>
            {log.llmProvider && (
              <span className="text-nano text-muted-foreground tabular-nums">
                {log.llmProvider}/{log.llmModel}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 flex-wrap text-nano tabular-nums">
            <span className="text-muted-foreground">
              input <span className="text-text font-medium">{formatTokens(log.inputTokens)}</span>
            </span>
            <span className="text-muted-foreground">
              output <span className="text-text font-medium">{formatTokens(log.outputTokens)}</span>
            </span>
            <span className="text-emerald-600 dark:text-emerald-400">
              cache read <span className="font-medium">{formatTokens(log.cacheReadTokens)}</span>
            </span>
            <span className="text-blue-600 dark:text-blue-400">
              cache write <span className="font-medium">{formatTokens(log.cacheWriteTokens)}</span>
            </span>
            {(() => {
              const promptTokens = log.cacheReadTokens + log.inputTokens
              if (promptTokens === 0) return null
              const rate = (log.cacheReadTokens / promptTokens) * 100
              return (
                <span className={cn(
                  'font-medium px-1 rounded',
                  rate >= 50 ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10'
                    : rate >= 20 ? 'text-amber-600 dark:text-amber-400 bg-amber-500/10'
                      : 'text-destructive bg-destructive/10',
                )}>
                  命中率 {rate.toFixed(1)}%
                </span>
              )
            })()}
          </div>
        </div>
      )}

      {/* 工具列表 */}
      {log.toolNames.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {log.toolNames.map((name) => (
            <Badge key={name} variant="outline" className="text-nano h-4 px-1">
              {name}
            </Badge>
          ))}
        </div>
      )}

      {/* 用户创作指令 */}
      {log.userInstructions.length > 0 && (
        <div className="rounded-md bg-primary/5 border border-primary/20 p-2">
          <div className="text-nano font-medium text-primary mb-1">用户在检查点期间发送的指令</div>
          <ol className="list-decimal list-inside text-micro text-text space-y-0.5">
            {log.userInstructions.map((msg, i) => (
              <li key={i}>{msg}</li>
            ))}
          </ol>
        </div>
      )}

      {/* 提示词三层结构 + 结果 */}
      {sections.map((section) => (
        <PromptSection key={section.key} section={section} />
      ))}
    </div>
  )
}

interface PromptSectionProps {
  section: {
    label: string
    icon: typeof Brain
    color: string
    content: string
    length: number
  }
}

function PromptSection({ section }: PromptSectionProps): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [showFull, setShowFull] = useState(false)
  const Icon = section.icon
  const preview = section.content.slice(0, 200)
  const hasMore = section.content.length > 200

  return (
    <div className="rounded-md border border-border overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center gap-1.5 px-2 py-1.5 bg-surface-1 hover:bg-surface-2 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <Icon className={cn('size-3', section.color)} />
        <span className="text-micro font-medium text-text">{section.label}</span>
        <span className="ml-auto text-nano text-muted-foreground tabular-nums">{section.length} 字符</span>
      </button>
      {expanded && (
        <div className="px-2 py-1.5">
          <pre className="text-nano leading-relaxed text-text-secondary whitespace-pre-wrap break-words font-mono max-h-80 overflow-y-auto">
            {showFull ? section.content : preview}
          </pre>
          {hasMore && (
            <Button
              size="sm"
              variant="link"
              className="h-5 px-0 text-nano"
              onClick={() => setShowFull((v) => !v)}
            >
              {showFull ? '收起' : `查看全部 ${section.length} 字符`}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

// ── 主组件 ──

export interface AgentLogPanelProps {
  chapterNumber?: number
}

export function AgentLogPanel({ chapterNumber }: AgentLogPanelProps): ReactElement {
  const currentProjectId = useNovelDataStore((s) => s.currentProjectId)
  const [refreshKey, setRefreshKey] = useState(0)
  const [agentFilter, setAgentFilter] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const logsQuery = useQuery({
    queryKey: ['novel-agent-logs', currentProjectId, chapterNumber, agentFilter, refreshKey],
    queryFn: async () => {
      if (!currentProjectId) return [] as NovelAgentLogSummary[]
      return listAgentLogs(currentProjectId, {
        chapterNumber,
        agentType: agentFilter || undefined,
        limit: 100,
      })
    },
    enabled: !!currentProjectId,
    refetchInterval: 10_000,
  })

  const logs = logsQuery.data ?? []

  const handleRefresh = (): void => {
    setRefreshKey((k) => k + 1)
  }

  const handleDeleteAll = async (): Promise<void> => {
    if (!currentProjectId) return
    if (!window.confirm('确定要删除该项目下所有 Agent 调用日志吗？此操作不可撤销。')) return
    try {
      await deleteAgentLogs(currentProjectId)
      setRefreshKey((k) => k + 1)
    } catch (err) {
      console.error('[AgentLogPanel] 删除日志失败:', err)
    }
  }

  const toggleExpand = (id: string): void => {
    setExpandedId((prev) => (prev === id ? null : id))
  }

  const stats = useMemo(() => {
    const total = logs.length
    const errors = logs.filter((l) => l.status === 'error').length
    const totalDuration = logs.reduce((sum, l) => sum + l.durationMs, 0)
    const totalResult = logs.reduce((sum, l) => sum + l.resultLength, 0)
    // 缓存命中率：cacheReadTokens / (cacheReadTokens + inputTokens)
    // 只统计有 usage 数据的记录（inputTokens > 0 或 cacheReadTokens > 0）
    const withUsage = logs.filter((l) => l.inputTokens > 0 || l.cacheReadTokens > 0)
    const totalInput = withUsage.reduce((sum, l) => sum + l.inputTokens, 0)
    const totalCacheRead = withUsage.reduce((sum, l) => sum + l.cacheReadTokens, 0)
    const totalCacheWrite = withUsage.reduce((sum, l) => sum + l.cacheWriteTokens, 0)
    const totalOutput = withUsage.reduce((sum, l) => sum + l.outputTokens, 0)
    const totalPromptTokens = totalInput + totalCacheRead
    const cacheHitRate = totalPromptTokens > 0 ? (totalCacheRead / totalPromptTokens) * 100 : 0
    const missCount = withUsage.filter((l) => l.cacheReadTokens === 0).length
    return {
      total,
      errors,
      totalDuration,
      totalResult,
      totalInput,
      totalCacheRead,
      totalCacheWrite,
      totalOutput,
      cacheHitRate,
      missCount,
      withUsageCount: withUsage.length,
    }
  }, [logs])

  if (!currentProjectId) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center">
        <p className="text-xs text-muted-foreground">请先选择项目</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-surface-1">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
        <div className="flex items-center gap-2">
          <Brain className="size-4 text-primary" />
          <span className="text-sm font-semibold text-text">Agent 调用日志</span>
          <Badge variant="secondary" className="text-nano h-4 px-1 tabular-nums">{stats.total}</Badge>
          {stats.errors > 0 && (
            <Badge variant="destructive" className="text-nano h-4 px-1 tabular-nums">{stats.errors} 失败</Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={handleRefresh}
            title="刷新"
            disabled={logsQuery.isFetching}
          >
            <RefreshCw className={cn('size-3.5', logsQuery.isFetching && 'animate-spin')} />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={handleDeleteAll}
            title="删除全部日志"
            disabled={logs.length === 0}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* 过滤栏 */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border overflow-x-auto">
        {AGENT_TYPE_FILTERS.map((type) => (
          <button
            key={type || 'all'}
            type="button"
            onClick={() => setAgentFilter(type)}
            className={cn(
              'shrink-0 px-2 py-0.5 rounded text-nano transition-colors',
              agentFilter === type
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted/50 text-muted-foreground hover:bg-muted',
            )}
          >
            {type ? (AGENT_STYLE[type]?.label ?? type) : '全部'}
          </button>
        ))}
        {chapterNumber != null && (
          <span className="ml-auto shrink-0 text-nano text-muted-foreground tabular-nums">
            第 {chapterNumber} 章
          </span>
        )}
      </div>

      {/* 汇总信息 */}
      {logs.length > 0 && (
        <div className="px-3 py-1.5 text-nano text-muted-foreground border-b border-border bg-background/30 tabular-nums space-y-1">
          <div className="flex items-center gap-3">
            <span>总耗时 {formatDuration(stats.totalDuration)}</span>
            <span>总输出 {stats.totalResult} 字符</span>
            <span>平均 {logs.length > 0 ? formatDuration(Math.round(stats.totalDuration / logs.length)) : '-'}</span>
          </div>
          {stats.withUsageCount > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-muted-foreground/80">缓存诊断</span>
              <span className={cn(
                'font-medium',
                stats.cacheHitRate >= 50 ? 'text-emerald-600 dark:text-emerald-400'
                  : stats.cacheHitRate >= 20 ? 'text-amber-600 dark:text-amber-400'
                    : 'text-destructive',
              )}>
                命中率 {stats.cacheHitRate.toFixed(1)}%
              </span>
              <span className="text-muted-foreground/70">
                ({formatTokens(stats.totalCacheRead)} / {formatTokens(stats.totalInput + stats.totalCacheRead)})
              </span>
              {stats.missCount > 0 && (
                <span className="text-destructive/80">miss {stats.missCount} 次</span>
              )}
              <span className="text-muted-foreground/70">写入 {formatTokens(stats.totalCacheWrite)}</span>
              <span className="text-muted-foreground/70">输出 {formatTokens(stats.totalOutput)}</span>
            </div>
          )}
        </div>
      )}

      {/* 日志列表 */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {logsQuery.isLoading && (
          <p className="text-xs text-muted-foreground text-center py-4">加载中...</p>
        )}
        {logsQuery.error && (
          <div className="m-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
            加载失败：{logsQuery.error instanceof Error ? logsQuery.error.message : '未知错误'}
          </div>
        )}
        {!logsQuery.isLoading && logs.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
            <Brain className="size-6 text-muted-foreground/50 mb-2" />
            <p className="text-xs text-muted-foreground">暂无日志记录</p>
            <p className="text-nano text-muted-foreground/70 mt-1">
              启动多 Agent 创作流程后，每次 Agent 调用的完整上下文将自动记录
            </p>
          </div>
        )}
        <div className="divide-y divide-border">
          {logs.map((log) => {
            const agentStyle = AGENT_STYLE[log.displayAgentType] ?? AGENT_STYLE[log.agentType]
            const statusStyle = STATUS_STYLE[log.status] ?? STATUS_STYLE.success
            const StatusIcon = statusStyle.icon
            const isExpanded = expandedId === log.id
            const hitRate = cacheHitRate(log)
            return (
              <div key={log.id} className="bg-surface-1">
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-surface-2 transition-colors text-left"
                  onClick={() => toggleExpand(log.id)}
                >
                  {isExpanded ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
                  <StatusIcon className={cn('size-3 shrink-0', statusStyle.color)} />
                  <Badge
                    variant="outline"
                    className={cn('text-nano h-4 px-1 shrink-0', agentStyle?.badge)}
                  >
                    {log.displayAgentName || agentStyle?.label || log.agentType}
                  </Badge>
                  <span className="text-nano text-muted-foreground shrink-0 tabular-nums">
                    第 {log.chapterNumber} 章
                  </span>
                  <span className="text-nano text-muted-foreground shrink-0 tabular-nums">
                    {formatDuration(log.durationMs)}
                  </span>
                  <span className="text-nano text-muted-foreground shrink-0 tabular-nums">
                    {log.resultLength} 字
                  </span>
                  {hitRate !== null && (
                    <span
                      className={cn(
                        'text-nano shrink-0 tabular-nums font-medium px-1 rounded',
                        hitRate >= 50
                          ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10'
                          : hitRate >= 20
                            ? 'text-amber-600 dark:text-amber-400 bg-amber-500/10'
                            : 'text-destructive bg-destructive/10',
                      )}
                      title={`input ${formatTokens(log.inputTokens)} / cache read ${formatTokens(log.cacheReadTokens)} / cache write ${formatTokens(log.cacheWriteTokens)}${log.llmProvider ? ` / ${log.llmProvider}/${log.llmModel}` : ''}`}
                    >
                      {hitRate === 0 ? 'cache miss' : `缓存 ${hitRate.toFixed(0)}%`}
                    </span>
                  )}
                  {log.toolNames.length > 0 && (
                    <span className="text-nano text-muted-foreground shrink-0 tabular-nums">
                      {log.toolNames.length} 工具
                    </span>
                  )}
                  <span className="ml-auto text-nano text-muted-foreground shrink-0 tabular-nums">
                    {formatTime(log.createdAt)}
                  </span>
                </button>
                {isExpanded && <LogDetail id={log.id} />}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
