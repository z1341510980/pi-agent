/**
 * 缓存诊断面板
 *
 * 展示小说系统的提示词缓存命中率指标：
 * - STATIC 层：系统提示词哈希（跨章节缓存命中）
 * - SEMI 层：章节上下文哈希（单章内缓存命中）
 * - DYNAMIC 层：对话消息（不缓存）
 *
 * 哈希稳定（绿色）= 缓存命中；哈希变化（红色）= 缓存失效。
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw, CheckCircle2, AlertCircle, Hash, Brain, Zap, Database } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { useNovelStore } from '@/stores/novel-store'
import { getCacheDiagnostics, type CacheDiagnostics } from '@/api/novel-client'

// ── Agent 类型中文标签 ──

const AGENT_LABELS: Record<string, string> = {
  director: '导演',
  writer: '写作',
  reviewer: '审稿',
  reviser: '修订',
  memory: '记忆',
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
  const currentProjectId = useNovelStore((s) => s.currentProjectId)
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
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="flex items-center gap-1 text-muted-foreground">
                      <layer.icon className="size-2.5" />
                      {layer.name} · {layer.label}
                    </span>
                    <span className="text-muted-foreground">
                      {layer.name === 'DYNAMIC' ? '不缓存' : `${layer.hitRate}%`}
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn('h-full transition-all', layer.color)}
                      style={{ width: `${layer.name === 'DYNAMIC' ? 100 : layer.hitRate}%` }}
                    />
                  </div>
                  <p className="text-[9px] text-hint leading-tight">{layer.description}</p>
                </div>
              ))}
            </div>

            {/* 系统提示词哈希表 */}
            <div className="space-y-2">
              <span className="text-xs font-medium text-text">系统提示词哈希（STATIC）</span>
              <div className="space-y-1">
                {Object.entries(data.systemPromptHashes).map(([agentType, hash]) => {
                  const stable = isHashStable(agentType, hash)
                  return (
                    <div
                      key={agentType}
                      className="flex items-center gap-2 rounded-md border border-border/60 bg-background/50 px-2 py-1.5"
                    >
                      <Badge variant="outline" className="text-[10px] shrink-0">
                        {AGENT_LABELS[agentType] ?? agentType}
                      </Badge>
                      <code className="flex-1 text-[10px] font-mono text-muted-foreground truncate" title={hash}>
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
                  <Badge variant="outline" className="text-[10px] shrink-0">
                    第 {chapterNumber ?? '?'} 章
                  </Badge>
                  <code className="flex-1 text-[10px] font-mono text-muted-foreground truncate" title={data.chapterContextHash}>
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
            <div className="text-[9px] text-hint text-center pt-1">
              更新于 {new Date(data.timestamp).toLocaleTimeString('zh-CN')}
            </div>
          </>
        )}
      </div>
    </div>
  )
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
