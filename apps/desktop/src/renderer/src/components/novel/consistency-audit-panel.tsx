/**
 * 跨章节一致性审计面板
 *
 * 调用 GET /api/plugins/novel/projects/:id/consistency-report，
 * 展示健康度评分 + 4 项分项检查（伏笔回收率 / 钩子悬挂 / 孤儿实体 / 时间线矛盾）。
 *
 * 设计要点：
 * - 数据用 useQuery 拉取，staleTime 30s，refetchInterval 60s（定时刷新不显示 loading，符合用户偏好）
 * - 健康度评分用 SVG 环形进度条，按分数分级配色（绿/黄/红）
 * - 4 个分项卡片可折叠，默认展开有问题的项
 * - 颜色语义：success（绿，无问题）/ warning（黄，需关注）/ danger（红，有问题）
 */

import { useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  RefreshCw,
  ChevronDown,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Anchor,
  Ghost,
  TrendingUp,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useNovelDataStore } from '@/stores/novel-data-store'
import {
  getConsistencyReport,
  type ForeshadowAudit,
  type HookAudit,
  type OrphanEntityAudit,
  type TimelineAudit,
} from '@/api/novel-client'

// ── 健康度分级配色 ──

interface HealthStyle {
  color: string      // 环形颜色
  textClass: string  // 文字颜色
  bgClass: string    // 背景颜色
  label: string
}

function healthStyle(score: number): HealthStyle {
  if (score >= 80) {
    return {
      color: '#15a877',
      textClass: 'text-success',
      bgClass: 'bg-success/10',
      label: '良好',
    }
  }
  if (score >= 60) {
    return {
      color: '#f59e0b',
      textClass: 'text-amber-500',
      bgClass: 'bg-amber-500/10',
      label: '需关注',
    }
  }
  return {
    color: '#e8463a',
    textClass: 'text-danger',
    bgClass: 'bg-danger/10',
    label: '有问题',
  }
}

// ── 环形健康度评分 ──

function HealthRing({ score, color }: { score: number; color: string }): ReactElement {
  const radius = 36
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (score / 100) * circumference
  return (
    <div className="relative size-24 shrink-0">
      <svg className="size-full -rotate-90" viewBox="0 0 80 80">
        <circle
          cx="40"
          cy="40"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="6"
          className="text-border"
        />
        <circle
          cx="40"
          cy="40"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 0.5s ease' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold tabular-nums text-text">{score}</span>
        <span className="text-[10px] text-subtle">健康度</span>
      </div>
    </div>
  )
}

// ── 可折叠分项卡片 ──

interface AuditCardProps {
  title: string
  icon: ReactElement
  /** 头部右侧摘要文字 */
  summary: string
  /** 是否默认展开 */
  defaultOpen: boolean
  /** 是否有问题（影响头部图标颜色） */
  hasIssue: boolean
  children: ReactElement
}

function AuditCard({
  title,
  icon,
  summary,
  defaultOpen,
  hasIssue,
  children,
}: AuditCardProps): ReactElement {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-md border border-border bg-surface-1 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-2 text-left',
          'transition-colors hover:bg-surface-2',
        )}
      >
        <span className={cn('shrink-0', hasIssue ? 'text-danger' : 'text-success')}>
          {icon}
        </span>
        <span className="text-xs font-medium text-text flex-1 truncate">{title}</span>
        <span className="text-[11px] text-subtle tabular-nums">{summary}</span>
        <ChevronDown
          className={cn(
            'size-3.5 text-subtle transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && (
        <div className="px-3 pb-3 pt-0 border-t border-border/50 text-xs">
          {children}
        </div>
      )}
    </div>
  )
}

// ── 分项：伏笔回收率 ──

function ForeshadowSection({ foreshadow }: { foreshadow: ForeshadowAudit }): ReactElement {
  const hasIssue = foreshadow.expired.length > 0 || foreshadow.urgent.length > 0
  const recoveryPct = (foreshadow.recoveryRate * 100).toFixed(1)
  return (
    <AuditCard
      title="伏笔回收率"
      icon={<TrendingUp className="size-3.5" />}
      summary={`${recoveryPct}% · ${foreshadow.byStatus.recovered}/${foreshadow.total}`}
      defaultOpen={hasIssue}
      hasIssue={hasIssue}
    >
      <div className="mt-2 space-y-2">
        {/* 状态分布 */}
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(foreshadow.byStatus)
            .filter(([, count]) => count > 0)
            .map(([status, count]) => (
              <span
                key={status}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-surface-2 text-text-secondary"
              >
                <span className="font-medium">{statusLabel(status)}</span>
                <span className="tabular-nums text-subtle">{count}</span>
              </span>
            ))}
        </div>

        {foreshadow.expired.length > 0 && (
          <div className="rounded bg-danger/10 p-2">
            <div className="text-[11px] font-medium text-danger mb-1">
              即将过期（{foreshadow.expired.length}）
            </div>
            <ul className="space-y-0.5">
              {foreshadow.expired.slice(0, 5).map((f) => (
                <li key={f.id} className="flex items-center gap-2 text-[11px]">
                  <span className="flex-1 truncate text-text-secondary">{f.description}</span>
                  <span className="tabular-nums text-danger">gap {f.gap}</span>
                </li>
              ))}
              {foreshadow.expired.length > 5 && (
                <li className="text-[10px] text-subtle">+{foreshadow.expired.length - 5} 条...</li>
              )}
            </ul>
          </div>
        )}

        {foreshadow.urgent.length > 0 && (
          <div className="rounded bg-amber-500/10 p-2">
            <div className="text-[11px] font-medium text-amber-600 mb-1">
              急需回收（{foreshadow.urgent.length}）
            </div>
            <ul className="space-y-0.5">
              {foreshadow.urgent.slice(0, 5).map((f) => (
                <li key={f.id} className="flex items-center gap-2 text-[11px]">
                  <span className="flex-1 truncate text-text-secondary">{f.description}</span>
                  <span className="tabular-nums text-amber-600">gap {f.gap}</span>
                </li>
              ))}
              {foreshadow.urgent.length > 5 && (
                <li className="text-[10px] text-subtle">+{foreshadow.urgent.length - 5} 条...</li>
              )}
            </ul>
          </div>
        )}

        {!hasIssue && foreshadow.total > 0 && (
          <div className="text-[11px] text-success flex items-center gap-1">
            <CheckCircle2 className="size-3" />
            所有伏笔状态正常
          </div>
        )}
        {foreshadow.total === 0 && (
          <div className="text-[11px] text-subtle">暂无伏笔记录</div>
        )}
      </div>
    </AuditCard>
  )
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    planned: '计划',
    planted: '已埋',
    reinforced: '已强化',
    partially_revealed: '部分揭示',
    recovering: '回收中',
    recovered: '已回收',
    abandoned: '已废弃',
  }
  return map[status] ?? status
}

// ── 分项：钩子悬挂 ──

function HookSection({ hooks }: { hooks: HookAudit }): ReactElement {
  const hasIssue = hooks.hanging.length > 0
  const fulfilledPct = (hooks.fulfilledRate * 100).toFixed(1)
  return (
    <AuditCard
      title="钩子悬挂"
      icon={<Anchor className="size-3.5" />}
      summary={`${fulfilledPct}% · 悬挂 ${hooks.hanging.length}`}
      defaultOpen={hasIssue}
      hasIssue={hasIssue}
    >
      <div className="mt-2 space-y-2">
        {hooks.hanging.length > 0 ? (
          <ul className="space-y-1">
            {hooks.hanging.slice(0, 8).map((h) => (
              <li key={h.id} className="flex items-start gap-2 text-[11px]">
                <AlertTriangle className="size-3 text-amber-500 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="truncate text-text-secondary">{h.description}</div>
                  <div className="text-[10px] text-subtle tabular-nums">
                    第 {h.thrownAt} 章抛出 · 悬挂 {h.gap} 章 · {h.hookType}
                  </div>
                </div>
              </li>
            ))}
            {hooks.hanging.length > 8 && (
              <li className="text-[10px] text-subtle">+{hooks.hanging.length - 8} 个...</li>
            )}
          </ul>
        ) : hooks.total > 0 ? (
          <div className="text-[11px] text-success flex items-center gap-1">
            <CheckCircle2 className="size-3" />
            钩子兑现情况良好
          </div>
        ) : (
          <div className="text-[11px] text-subtle">暂无钩子记录</div>
        )}
      </div>
    </AuditCard>
  )
}

// ── 分项：孤儿实体 ──

function OrphanSection({ orphans }: { orphans: OrphanEntityAudit }): ReactElement {
  const count =
    orphans.characters.length + orphans.factions.length + orphans.locations.length
  const hasIssue = count > 0
  return (
    <AuditCard
      title="孤儿实体"
      icon={<Ghost className="size-3.5" />}
      summary={`${count} 个 · 角色 ${orphans.characters.length} / 势力 ${orphans.factions.length} / 地点 ${orphans.locations.length}`}
      defaultOpen={hasIssue}
      hasIssue={hasIssue}
    >
      <div className="mt-2 space-y-2">
        {count > 0 ? (
          <>
            {orphans.characters.length > 0 && (
              <div>
                <div className="text-[11px] font-medium text-text-secondary mb-1">角色</div>
                <ul className="space-y-0.5">
                  {orphans.characters.slice(0, 5).map((c) => (
                    <li key={c.id} className="flex items-center gap-2 text-[11px]">
                      <span className="flex-1 truncate text-text">{c.name}</span>
                      <span className="tabular-nums text-subtle">
                        缺第 {c.missingChapters.join(',')} 章
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {orphans.factions.length > 0 && (
              <div>
                <div className="text-[11px] font-medium text-text-secondary mb-1">势力</div>
                <ul className="space-y-0.5">
                  {orphans.factions.slice(0, 5).map((f) => (
                    <li key={f.id} className="flex items-center gap-2 text-[11px]">
                      <span className="flex-1 truncate text-text">{f.name}</span>
                      <span className="tabular-nums text-subtle">
                        缺第 {f.missingChapters.join(',')} 章
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {orphans.locations.length > 0 && (
              <div>
                <div className="text-[11px] font-medium text-text-secondary mb-1">地点</div>
                <ul className="space-y-0.5">
                  {orphans.locations.slice(0, 5).map((l) => (
                    <li key={l.id} className="flex items-center gap-2 text-[11px]">
                      <span className="flex-1 truncate text-text">{l.name}</span>
                      <span className="tabular-nums text-subtle">
                        缺第 {l.missingChapters.join(',')} 章
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <div className="text-[11px] text-success flex items-center gap-1">
            <CheckCircle2 className="size-3" />
            编排实体均在正文出现
          </div>
        )}
      </div>
    </AuditCard>
  )
}

// ── 分项：时间线矛盾 ──

function TimelineSection({ timeline }: { timeline: TimelineAudit }): ReactElement {
  const hasIssue = !timeline.monotonic
  return (
    <AuditCard
      title="时间线矛盾"
      icon={<Clock className="size-3.5" />}
      summary={timeline.monotonic ? '单调递增' : `${timeline.violations.length} 处违反`}
      defaultOpen={hasIssue}
      hasIssue={hasIssue}
    >
      <div className="mt-2 space-y-2">
        {timeline.violations.length > 0 ? (
          <ul className="space-y-1">
            {timeline.violations.slice(0, 8).map((v, i) => (
              <li key={i} className="flex items-start gap-2 text-[11px]">
                <AlertTriangle className="size-3 text-danger mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="text-text-secondary">
                    第 <span className="tabular-nums text-text">{v.chapter}</span> 章
                  </span>
                  <span className="text-subtle mx-1">←</span>
                  <span className="text-text-secondary">
                    第 <span className="tabular-nums text-text">{v.previousChapter}</span> 章
                  </span>
                  <div className="text-[10px] tabular-nums text-danger">
                    {v.timeOffset} &lt; {v.previousOffset}
                  </div>
                </div>
              </li>
            ))}
            {timeline.violations.length > 8 && (
              <li className="text-[10px] text-subtle">
                +{timeline.violations.length - 8} 处...
              </li>
            )}
          </ul>
        ) : (
          <div className="text-[11px] text-success flex items-center gap-1">
            <CheckCircle2 className="size-3" />
            时间线单调递增
          </div>
        )}
      </div>
    </AuditCard>
  )
}

// ── 主面板 ──

export function ConsistencyAuditPanel(): ReactElement {
  const currentProjectId = useNovelDataStore((s) => s.currentProjectId)

  const query = useQuery({
    queryKey: ['novel', 'consistency-report', currentProjectId],
    queryFn: () => getConsistencyReport(currentProjectId!),
    enabled: !!currentProjectId,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  })

  const report = query.data
  const isRefreshing = query.isFetching && !query.isLoading
  const style = report ? healthStyle(report.healthScore) : null

  if (!currentProjectId) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-subtle">
        请先选择项目
      </div>
    )
  }

  if (query.isLoading) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-subtle">
        正在加载审计报告...
      </div>
    )
  }

  if (query.isError || !report) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-xs text-subtle p-4">
        <AlertTriangle className="size-5 text-danger" />
        <span>审计报告加载失败</span>
        <Button size="xs" variant="ghost" onClick={() => query.refetch()}>
          <RefreshCw className="size-3" />
          重试
        </Button>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 顶部：健康度评分 + 刷新按钮 */}
      <div className="shrink-0 p-3 border-b border-border">
        <div className="flex items-center gap-3">
          {style && <HealthRing score={report.healthScore} color={style.color} />}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-1">
              <span className={cn('text-sm font-semibold', style?.textClass)}>
                {style?.label}
              </span>
              {isRefreshing && (
                <RefreshCw className="size-3 text-subtle animate-spin" />
              )}
            </div>
            <div className="text-[11px] text-subtle tabular-nums">
              {report.writtenChapters} / {report.totalChapters} 章已写
            </div>
            <div className="text-[10px] text-hint mt-1">
              每 60 秒自动刷新
            </div>
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => query.refetch()}
            disabled={isRefreshing}
            title="立即刷新"
          >
            <RefreshCw className={cn('size-3.5', isRefreshing && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {/* 中部：4 个分项卡片 */}
      <div className="flex-1 overflow-auto p-2 space-y-2">
        <ForeshadowSection foreshadow={report.foreshadow} />
        <HookSection hooks={report.hooks} />
        <OrphanSection orphans={report.orphanEntities} />
        <TimelineSection timeline={report.timeline} />

        {/* 底部：摘要 */}
        {report.summary.length > 0 && (
          <div className="rounded-md bg-surface-2 p-2 mt-2">
            <div className="text-[10px] font-medium text-subtle mb-1">摘要</div>
            <ul className="space-y-0.5">
              {report.summary.map((s, i) => (
                <li key={i} className="text-[11px] text-text-secondary leading-relaxed">
                  {s}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
