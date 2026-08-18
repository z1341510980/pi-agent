/**
 * 缓存诊断面板
 *
 * 展示小说系统的提示词缓存命中率指标：
 * - STATIC 层：系统提示词哈希（跨章节缓存命中）
 * - SEMI 层：章节上下文哈希（单章内缓存命中）
 * - DYNAMIC 层：对话消息（不缓存）
 *
 * 哈希稳定（绿色）= 前提满足；哈希变化（红色）= 前缀失效。
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { RefreshCw, CheckCircle2, AlertCircle, Hash, Brain, Zap, Database, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { useNovelDataStore } from '@/stores/novel-data-store'
import {
  getCacheDiagnostics,
  getCacheLayerReport,
  getObservabilityCache,
  type CacheDiagnostics,
  type CacheLayerReport,
  type ObservabilityCacheReport,
} from '@/api/novel-client'

// ── Agent 类型中文标签 ──

const AGENT_LABELS: Record<string, string> = {
  director: '导演',
  writer: '写作',
  reviewer: '审稿',
  memory: '记忆',
}

// ── 缓存协议中文标签 ──

const PROTOCOL_LABELS: Record<string, string> = {
  'anthropic-cache-control': 'Anthropic 显式断点',
  'openai-prompt-cache-key': 'OpenAI 缓存键路由',
  'automatic-prefix': '自动前缀缓存',
  none: '无缓存',
  unknown: '未知协议',
}

// ── 缓存层定义 ──

interface CacheLayer {
  name: string
  label: string
  description: string
  hitRate: number
  color: string
  icon: typeof Database
}

// ── 主组件 ──

export interface CacheMonitorPanelProps {
  /** 指定章节编号用于计算 SEMI 层哈希 */
  chapterNumber?: number
}

export function CacheMonitorPanel({ chapterNumber }: CacheMonitorPanelProps): ReactElement {
  const currentProjectId = useNovelDataStore((s) => s.currentProjectId)
  const [refreshKey, setRefreshKey] = useState(0)
  /** 上一次的哈希快照，用于对比是否变化 */
  const prevHashesRef = useRef<Record<string, string>>({})

  const diagnosticsQuery = useQuery({
    queryKey: ['novel-cache-diagnostics', currentProjectId, chapterNumber, refreshKey],
    queryFn: async () => {
      if (!currentProjectId) return null
      return getCacheDiagnostics(currentProjectId, chapterNumber)
    },
    enabled: !!currentProjectId,
    refetchInterval: 30_000,
  })

  const data = diagnosticsQuery.data

  // 分层命中报告：哈希稳定只是前提，这里看缓存有没有真的被读到
  const layerQuery = useQuery({
    queryKey: ['novel-cache-layer-report', currentProjectId, chapterNumber, refreshKey],
    queryFn: async () => {
      if (!currentProjectId) return null
      return getCacheLayerReport(currentProjectId, { chapterNumber })
    },
    enabled: !!currentProjectId,
    refetchInterval: 60_000,
  })

  // Provider 实测命中：来自观测日志 cache_read 统计；定时刷新保留旧数据避免闪烁
  const obsQuery = useQuery({
    queryKey: ['novel-observability-cache', currentProjectId, chapterNumber, refreshKey],
    queryFn: () => getObservabilityCache(currentProjectId!, { chapterNumber, limit: 200 }),
    enabled: !!currentProjectId,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  })
  const obs = obsQuery.data

  // 记录上一次哈希用于对比
  useEffect(() => {
    if (data) {
      const current: Record<string, string> = { ...data.systemPromptHashes }
      if (data.chapterContextHash) {
        current['__chapter_context__'] = data.chapterContextHash
      }
      prevHashesRef.current = current
    }
  }, [data])

  const handleRefresh = (): void => {
    setRefreshKey((k) => k + 1)
  }

  // 判断哈希是否稳定（与上次相同 = 缓存命中）
  const isHashStable = (key: string, hash: string): boolean => {
    const prev = prevHashesRef.current[key]
    if (prev == null) return true // 首次加载视为稳定
    return prev === hash
  }

  // 计算缓存层命中率（简化估算）
  const staticHitRate = computeStaticHitRate(data, prevHashesRef.current)
  const semiHitRate = data?.chapterContextHash
    ? isHashStable('__chapter_context__', data.chapterContextHash) ? 100 : 0
    : 0

  const cacheLayers: CacheLayer[] = [
    {
      name: 'STATIC',
      label: '系统提示词',
      description: '世界规则、风格指南、角色定义（跨章节缓存）',
      hitRate: staticHitRate,
      color: 'bg-emerald-500',
      icon: Database,
    },
    {
      name: 'SEMI',
      label: '章节上下文',
      description: '当前故事状态、叙事任务、约束（单章内缓存）',
      hitRate: semiHitRate,
      color: 'bg-blue-500',
      icon: Hash,
    },
    {
      name: 'DYNAMIC',
      label: '对话消息',
      description: '工具调用结果、生成内容（不缓存，追加到末尾）',
      hitRate: 0,
      color: 'bg-amber-500',
      icon: Zap,
    },
  ]

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
          <span className="text-sm font-semibold text-text">缓存诊断</span>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={handleRefresh}
          title="刷新"
          disabled={diagnosticsQuery.isFetching}
        >
          <RefreshCw className={cn('size-3.5', diagnosticsQuery.isFetching && 'animate-spin')} />
        </Button>
      </div>

      {/* 内容 */}
      <div className="flex-1 overflow-y-auto min-h-0 p-3 space-y-4">
        {diagnosticsQuery.isLoading && (
          <p className="text-xs text-muted-foreground text-center py-4">加载中...</p>
        )}
        {diagnosticsQuery.error && (
          <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
            加载失败：{diagnosticsQuery.error instanceof Error ? diagnosticsQuery.error.message : '未知错误'}
          </div>
        )}

        {data && (
          <>
            {/* 缓存层条形图 */}
            <div className="space-y-2">
              <span className="text-xs font-medium text-text">缓存层级</span>
              {cacheLayers.map((layer) => (
                <div key={layer.name} className="space-y-1">
                  <div className="flex items-center justify-between text-nano">
                    <span className="flex items-center gap-1 text-muted-foreground">
                      <layer.icon className="size-2.5" />
                      {layer.name} · {layer.label}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {layer.name === 'DYNAMIC' ? '不缓存' : `${layer.hitRate}%`}
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn('h-full transition-[width] duration-300', layer.color)}
                      style={{ width: `${layer.name === 'DYNAMIC' ? 100 : layer.hitRate}%` }}
                    />
                  </div>
                  <p className="text-nano text-hint leading-tight">{layer.description}</p>
                </div>
              ))}
            </div>

            {/* 实际命中（Provider 实测） */}
            <ObservabilityHitSection report={obs} />

            {/* 系统提示词哈希表 */}
            <div className="space-y-2">
              <span className="text-xs font-medium text-text">系统提示词哈希（STATIC）</span>
              <p className="text-nano text-hint leading-tight">
                哈希稳定只是命中前提，实际命中见上方「实际命中」区块
              </p>
              <div className="space-y-1">
                {Object.entries(data.systemPromptHashes).map(([agentType, hash]) => {
                  const stable = isHashStable(agentType, hash)
                  return (
                    <div
                      key={agentType}
                      className="flex items-center gap-2 rounded-md border border-border/60 bg-background/50 px-2 py-1.5"
                    >
                      <Badge variant="outline" className="text-nano shrink-0">
                        {AGENT_LABELS[agentType] ?? agentType}
                      </Badge>
                      <code className="flex-1 text-nano font-mono text-muted-foreground truncate" title={hash}>
                        {hash}
                      </code>
                      {stable ? (
                        <CheckCircle2 className="size-3 text-success shrink-0" />
                      ) : (
                        <AlertCircle className="size-3 text-destructive shrink-0" />
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            {/* 章节上下文哈希 */}
            {data.chapterContextHash && (
              <div className="space-y-2">
                <span className="text-xs font-medium text-text">章节上下文哈希（SEMI）</span>
                <div className="flex items-center gap-2 rounded-md border border-border/60 bg-background/50 px-2 py-1.5">
                  <Badge variant="outline" className="text-nano shrink-0">
                    第 {chapterNumber ?? '?'} 章
                  </Badge>
                  <code className="flex-1 text-nano font-mono text-muted-foreground truncate" title={data.chapterContextHash}>
                    {data.chapterContextHash}
                  </code>
                  {isHashStable('__chapter_context__', data.chapterContextHash) ? (
                    <CheckCircle2 className="size-3 text-success shrink-0" />
                  ) : (
                    <AlertCircle className="size-3 text-destructive shrink-0" />
                  )}
                </div>
              </div>
            )}

            {/* 时间戳 */}
            <div className="text-nano text-hint text-center pt-1">
              更新于 {new Date(data.timestamp).toLocaleTimeString('zh-CN')}
            </div>
          </>
        )}

        {/* 分层命中实测 */}
        <CacheLayerSection report={layerQuery.data} loading={layerQuery.isLoading} />
      </div>
    </div>
  )
}

// ── 分层命中实测 ──

const VERDICT_META: Record<
  NonNullable<CacheLayerReport['verdict']>,
  { label: string; className: string }
> = {
  healthy: { label: '分层复用正常', className: 'text-success' },
  partial: { label: '仅部分命中', className: 'text-amber-600 dark:text-amber-400' },
  miss: { label: '几乎未命中', className: 'text-destructive' },
  no_data: { label: '数据不足', className: 'text-muted-foreground' },
}

const AGENT_SHORT: Record<string, string> = {
  director: '导演',
  writer: '写作',
  reviewer: '审稿',
  reviser: '修订',
  memory: '记忆',
}

function CacheLayerSection({
  report,
  loading,
}: {
  report: CacheLayerReport | null | undefined
  loading: boolean
}): ReactElement | null {
  if (loading) {
    return <p className="text-xs text-muted-foreground text-center py-2">分层命中测算中...</p>
  }
  if (!report) return null

  const meta = VERDICT_META[report.verdict]
  const pct = report.overallCoverage != null ? Math.round(report.overallCoverage * 100) : null

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-text">分层命中实测</span>
        <span className={cn('text-nano font-medium', meta.className)}>{meta.label}</span>
      </div>

      <p className="text-nano text-hint leading-relaxed">
        上方哈希只说明前缀是否稳定；这里用同一条日志反解字符/token 比，
        再比对实测 cache_read 与可缓存前缀（system + shared + identity）的期望值。
      </p>

      {pct != null && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-nano">
            <span className="text-muted-foreground">后续 Agent 平均覆盖率</span>
            <span className="tabular-nums text-muted-foreground">{pct}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full transition-[width] duration-300',
                report.verdict === 'healthy' ? 'bg-emerald-500'
                  : report.verdict === 'partial' ? 'bg-amber-500' : 'bg-red-500',
              )}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </div>
        </div>
      )}

      {report.potentialSavedTokens > 0 && (
        <div className="rounded-md bg-muted/50 px-2 py-1.5 text-nano text-muted-foreground">
          若分层完整命中，本次采样（{report.sampledLogs} 条调用）可少送约{' '}
          <span className="tabular-nums font-medium text-text">
            {formatTokenAmount(report.potentialSavedTokens)}
          </span>{' '}
          input token（上界估算）
        </div>
      )}

      {/* 逐章结论 */}
      <div className="space-y-1">
        {report.chapters.map((chapter) => (
          <div
            key={chapter.chapterNumber}
            className="rounded-md border border-border/60 bg-background/50 px-2 py-1.5 space-y-1"
          >
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-nano shrink-0">
                第 {chapter.chapterNumber} 章
              </Badge>
              <span className={cn('text-nano flex-1', VERDICT_META[chapter.verdict].className)}>
                {chapter.summary}
              </span>
            </div>
            {chapter.calls.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {chapter.calls.map((call) => (
                  <span
                    key={`${call.agentType}-${call.order}`}
                    className="text-nano tabular-nums text-hint rounded bg-muted/60 px-1"
                    title={`可缓存前缀 ${call.cacheablePrefixChars} 字符，期望命中 ${call.expectedCacheReadTokens ?? '-'} token，实测 ${call.cacheReadTokens} token`}
                  >
                    {AGENT_SHORT[call.agentType] ?? call.agentType}
                    {call.coverage != null ? ` ${Math.round(call.coverage * 100)}%` : ' -'}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 需要人工判断的提示 */}
      {report.notes.map((note) => (
        <div key={note} className="flex gap-1.5 rounded-md bg-amber-500/8 px-2 py-1.5">
          <Info className="size-3 shrink-0 mt-px text-amber-600 dark:text-amber-400" />
          <p className="text-nano leading-relaxed text-muted-foreground">{note}</p>
        </div>
      ))}
    </div>
  )
}

// ── 实际命中（Provider 实测）──

function ObservabilityHitSection({
  report,
}: {
  report: ObservabilityCacheReport | null | undefined
}): ReactElement | null {
  if (!report) return null

  const meta = VERDICT_META[report.verdict]
  const pct = report.overallCoverage != null ? Math.round(report.overallCoverage * 100) : null

  return (
    <div className="space-y-2">
      <span className="text-xs font-medium text-text">实际命中（Provider 实测）</span>

      {/* 总体结论 + 指纹稳定性 */}
      <div className="flex items-center justify-between rounded-md border border-border/60 bg-background/50 px-2 py-1.5">
        <span className={cn('text-nano font-medium', meta.className)}>
          {meta.label}
          {pct != null && ` · 覆盖 ${pct}%`}
        </span>
        <span
          className="text-nano text-muted-foreground tabular-nums"
          title="不同指纹数 / 统计调用数"
        >
          指纹 {report.fingerprintStability.distinctFingerprints}/{report.fingerprintStability.totalCalls}
        </span>
      </div>

      {/* 协议分布 */}
      <div className="space-y-1">
        <span className="text-nano text-hint">协议分布</span>
        {Object.entries(report.protocolDistribution).map(([protocol, count]) => (
          <div
            key={protocol}
            className="flex items-center justify-between rounded-md border border-border/60 bg-background/50 px-2 py-1.5 text-nano"
          >
            <span className="text-muted-foreground">{PROTOCOL_LABELS[protocol] ?? protocol}</span>
            <span className="tabular-nums text-muted-foreground">{count} 次</span>
          </div>
        ))}
      </div>

      {report.notes.map((note) => (
        <p key={note} className="text-nano text-hint leading-relaxed">{note}</p>
      ))}
    </div>
  )
}

function formatTokenAmount(n: number): string {
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)} 万`
  return String(n)
}

/** 计算 STATIC 层命中率：所有 Agent 哈希中稳定的比例 */
function computeStaticHitRate(
  data: CacheDiagnostics | null | undefined,
  prev: Record<string, string>,
): number {
  if (!data) return 0
  const entries = Object.entries(data.systemPromptHashes)
  if (entries.length === 0) return 0
  const stableCount = entries.filter(([k, v]) => prev[k] == null || prev[k] === v).length
  return Math.round((stableCount / entries.length) * 100)
}
