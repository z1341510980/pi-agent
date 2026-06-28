import type { ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BookOpen,
  MessageSquare,
  Settings,
  Sparkles,
  ArrowRight,
  FileText,
  Users,
} from 'lucide-react'
import { browserConfig } from '@repo/config/browser'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { getApi } from '@/api/http-client'

// ── 类型 ──

interface HealthData {
  service: string
  status: string
}

interface SessionSummary {
  id: string
  title?: string
  updatedAt?: number
}

interface NovelProject {
  id: string
  title: string
  genre: string
  status: string
  updatedAt: number
}

// ── 首页组件 ──

export interface HomePageProps {
  onOpenChat: () => void
  onOpenNovel: () => void
  onOpenSettings: () => void
}

export function HomePage({
  onOpenChat,
  onOpenNovel,
  onOpenSettings,
}: HomePageProps): ReactElement {
  // 健康检查
  const healthQuery = useQuery<HealthData>({
    queryKey: ['health'],
    queryFn: () => getApi<HealthData>('/api/health'),
    refetchInterval: 30_000,
  })
  const isOnline = healthQuery.data?.status === 'online'

  // 最近会话
  const sessionsQuery = useQuery<SessionSummary[]>({
    queryKey: ['sessions'],
    queryFn: () => getApi<SessionSummary[]>('/api/sessions'),
    refetchInterval: 30_000,
  })
  const recentSessions = (sessionsQuery.data ?? [])
    .slice()
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, 5)

  // 小说项目
  const projectsQuery = useQuery<NovelProject[]>({
    queryKey: ['novel-projects'],
    queryFn: () => getApi<NovelProject[]>('/api/plugins/novel/projects'),
    refetchInterval: 60_000,
  })
  const recentProjects = (projectsQuery.data ?? [])
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5)

  return (
    <div className="h-full overflow-y-auto bg-app-bg">
      <div className="mx-auto max-w-4xl px-6 py-10">
        {/* ── Hero ── */}
        <section className="mb-10 flex items-center gap-4">
          <div className="size-14 rounded-2xl bg-accent text-accent-foreground flex items-center justify-center text-3xl font-extrabold shrink-0">
            π
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-[780] leading-tight m-0">
              {browserConfig.appName}
            </h1>
            <p className="text-sm text-muted-foreground m-0 mt-1">
              基于 Pi SDK 的 AG-UI 桌面 Agent 助手
              <span className="ml-2 inline-flex items-center gap-1">
                <span
                  className={`size-1.5 rounded-full ${isOnline ? 'bg-emerald-500' : 'bg-muted-foreground'}`}
                  aria-hidden="true"
                />
                {isOnline ? '服务在线' : '服务离线'}
              </span>
            </p>
          </div>
        </section>

        {/* ── 快捷入口 ── */}
        <section className="mb-10">
          <h2 className="text-xs font-[760] text-subtle uppercase tracking-wider m-0 mb-3">
            快捷入口
          </h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <EntryCard
              icon={MessageSquare}
              title="对话工作台"
              description="与 Agent 进行多轮对话，处理编码、分析等任务"
              accent="text-blue-500"
              onClick={onOpenChat}
            />
            <EntryCard
              icon={BookOpen}
              title="小说创作"
              description="多 Agent 协作的长篇小说创作工作台"
              accent="text-amber-500"
              onClick={onOpenNovel}
            />
            <EntryCard
              icon={Settings}
              title="设置"
              description="配置模型供应商、Agent 人格和应用选项"
              accent="text-muted-foreground"
              onClick={onOpenSettings}
            />
          </div>
        </section>

        {/* ── 最近活动 ── */}
        <section className="grid gap-5 sm:grid-cols-2">
          {/* 最近会话 */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-[760] text-subtle uppercase tracking-wider m-0">
                最近会话
              </h2>
              <Button
                variant="ghost"
                size="sm"
                onClick={onOpenChat}
                className="h-7 text-xs text-muted-foreground hover:text-text"
              >
                查看全部
                <ArrowRight className="size-3" />
              </Button>
            </div>
            <div className="rounded-lg border border-border bg-surface-2 overflow-hidden">
              {recentSessions.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                  暂无会话
                </div>
              ) : (
                <ul className="m-0 p-0 list-none divide-y divide-border">
                  {recentSessions.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={onOpenChat}
                        className="w-full flex items-center gap-2.5 px-4 py-2.5 text-left hover:bg-surface-3 transition-colors"
                      >
                        <MessageSquare className="size-3.5 text-muted-foreground shrink-0" />
                        <span className="text-sm text-text truncate flex-1 min-w-0">
                          {s.title || '未命名会话'}
                        </span>
                        {s.updatedAt && (
                          <span className="text-[10px] text-muted-foreground shrink-0">
                            {relativeTime(s.updatedAt)}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* 最近项目 */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-[760] text-subtle uppercase tracking-wider m-0">
                最近小说项目
              </h2>
              <Button
                variant="ghost"
                size="sm"
                onClick={onOpenNovel}
                className="h-7 text-xs text-muted-foreground hover:text-text"
              >
                查看全部
                <ArrowRight className="size-3" />
              </Button>
            </div>
            <div className="rounded-lg border border-border bg-surface-2 overflow-hidden">
              {recentProjects.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                  暂无项目
                </div>
              ) : (
                <ul className="m-0 p-0 list-none divide-y divide-border">
                  {recentProjects.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={onOpenNovel}
                        className="w-full flex items-center gap-2.5 px-4 py-2.5 text-left hover:bg-surface-3 transition-colors"
                      >
                        <BookOpen className="size-3.5 text-amber-500/70 shrink-0" />
                        <span className="text-sm text-text truncate flex-1 min-w-0">
                          {p.title || '未命名项目'}
                        </span>
                        <Badge variant="outline" className="text-[10px] shrink-0">
                          {p.genre}
                        </Badge>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>

        {/* ── 能力概览 ── */}
        <section className="mt-10">
          <h2 className="text-xs font-[760] text-subtle uppercase tracking-wider m-0 mb-3">
            能力概览
          </h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <FeatureCard
              icon={Sparkles}
              title="多 Agent 协作"
              description="Director / Writer / Reviewer / Memory 四角色编排"
            />
            <FeatureCard
              icon={FileText}
              title="三层缓存优化"
              description="STATIC / SEMI / DYNAMIC 提示词分层缓存"
            />
            <FeatureCard
              icon={Users}
              title="插件化架构"
              description="独立 Session、工具权限隔离、配置化提示词"
            />
          </div>
        </section>
      </div>
    </div>
  )
}

// ── 子组件 ──

function EntryCard({
  icon: Icon,
  title,
  description,
  accent,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: string
  accent: string
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group text-left rounded-lg border border-border bg-surface-2 p-4 hover:border-primary/40 hover:bg-surface-3 transition-colors"
    >
      <div className="flex items-start gap-3">
        <div className={`size-9 rounded-lg bg-surface-3 flex items-center justify-center shrink-0 ${accent}`}>
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <span className="text-sm font-[760] text-text">{title}</span>
            <ArrowRight className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" />
          </div>
          <p className="text-xs text-muted-foreground m-0 mt-1">{description}</p>
        </div>
      </div>
    </button>
  )
}

function FeatureCard({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: string
}): ReactElement {
  return (
    <div className="rounded-lg border border-border bg-surface-2 p-4">
      <div className="flex items-center gap-2 mb-1.5">
        <Icon className="size-3.5 text-primary" />
        <span className="text-xs font-[760] text-text">{title}</span>
      </div>
      <p className="text-xs text-muted-foreground m-0">{description}</p>
    </div>
  )
}

// ── 工具函数 ──

function relativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  if (diff < 0) return '刚刚'
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  const month = Math.floor(day / 30)
  if (month < 12) return `${month} 个月前`
  return `${Math.floor(month / 12)} 年前`
}
