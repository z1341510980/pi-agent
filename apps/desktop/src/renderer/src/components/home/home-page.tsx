import type { ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BookOpen, MessageSquare, Settings, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { getApi } from '@/api/http-client'
import { SlotRenderer } from '@/components/slot'
import { useOptionalSlotRegistry } from '@/core/slot-context-value'
import { BUILTIN_SLOTS } from '@/ui/slot-types'

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

export function HomePage({ onOpenChat, onOpenNovel, onOpenSettings }: HomePageProps): ReactElement {
  const slotRegistry = useOptionalSlotRegistry()
  const novelAvailable =
    slotRegistry?.entriesOfSlot('sidebar.navigation').some((entry) => entry.pluginId === 'novel') ??
    false

  // 健康检查
  const healthQuery = useQuery<HealthData>({
    queryKey: ['health'],
    queryFn: () => getApi<HealthData>('/api/health'),
    refetchInterval: 30_000
  })
  const isOnline = healthQuery.data?.status === 'online'

  // 最近会话
  const sessionsQuery = useQuery<SessionSummary[]>({
    queryKey: ['sessions'],
    queryFn: () => getApi<SessionSummary[]>('/api/sessions'),
    refetchInterval: 30_000
  })
  const recentSessions = (sessionsQuery.data ?? [])
    .slice()
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, 5)

  // 小说项目
  const projectsQuery = useQuery<NovelProject[]>({
    queryKey: ['novel-projects'],
    queryFn: () => getApi<NovelProject[]>('/api/plugins/novel/projects'),
    refetchInterval: 60_000
  })
  const recentProjects = (projectsQuery.data ?? [])
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5)

  const handleShowcaseNavigate = (view: string): void => {
    if (view === 'plugin:novel') onOpenNovel()
  }

  return (
    <div className="relative h-full overflow-y-auto bg-app-bg" data-tour="home-page">
      {/* 环境光背景 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px] overflow-hidden"
      >
        <div className="absolute inset-0 bg-[radial-gradient(760px_300px_at_50%_-80px,var(--color-primary-10),transparent_70%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:24px_24px] opacity-40 [mask-image:linear-gradient(to_bottom,black,transparent_80%)]" />
      </div>

      <div className="relative mx-auto max-w-5xl px-8 pb-20 pt-10">
        {/* 设置入口（右上角） */}
        <Button
          variant="ghost"
          size="icon"
          onClick={onOpenSettings}
          data-tour="entry-settings"
          aria-label="设置"
          title="设置"
          className="absolute right-6 top-5 text-subtle hover:text-text"
        >
          <Settings className="size-4" aria-hidden="true" />
        </Button>

        {/* ── Hero ── */}
        <section
          className="mb-16 flex flex-col items-center pb-2 pt-6 text-center"
          data-tour="home-hero"
        >
          <p className="pi-rise m-0 inline-flex h-6 items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 text-xs text-muted-foreground">
            <span
              className={`size-1.5 rounded-full ${isOnline ? 'bg-emerald-500' : 'bg-muted-foreground'}`}
              aria-hidden="true"
            />
            {isOnline ? '服务在线' : '服务离线'}
          </p>
          <h1 className="pi-rise pi-rise-1 m-0 mt-6 text-balance text-[44px] font-bold leading-[1.1] tracking-tight text-text sm:text-[56px]">
            让 AI，{'\u00A0'}
            <span className="bg-gradient-to-r from-info to-[var(--dsw-static-deepseek-400)] bg-clip-text text-transparent">
              如臂使指
            </span>
          </h1>
          <p className="pi-rise pi-rise-2 m-0 mt-4 max-w-xl text-pretty text-base leading-relaxed text-muted-foreground">
            一个工作台，指挥你的 Agent 编队。交代任务即刻执行，
            {novelAvailable ? '长篇创作由角色编队接力完成。' : '能力随插件不断生长。'}
          </p>
          <div
            className="pi-rise pi-rise-3 mt-9 flex flex-wrap items-center justify-center gap-3"
            data-tour="home-entries"
          >
            <Button onClick={onOpenChat} data-tour="entry-chat" className="h-10 px-5 text-sm">
              开始对话
              <ArrowRight className="size-4" aria-hidden="true" />
            </Button>
            {novelAvailable && (
              <Button
                variant="outline"
                onClick={onOpenNovel}
                data-tour="entry-novel"
                className="h-10 px-5 text-sm"
              >
                <BookOpen className="size-4" aria-hidden="true" />
                小说创作
              </Button>
            )}
          </div>
        </section>

        {/* ── 插件展示区 ── */}
        <section className="mb-16 min-h-0" aria-label="插件展示">
          <SlotRenderer
            name={BUILTIN_SLOTS.HOME_SHOWCASE}
            extraProps={{ onNavigate: handleShowcaseNavigate }}
            fallback={null}
          />
        </section>

        {/* ── 最近活动 ── */}
        <section className="grid gap-5 sm:grid-cols-2">
          <div className="min-w-0">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="m-0 text-xs font-[760] uppercase tracking-wider text-subtle">
                最近会话
              </h2>
              <Button
                variant="ghost"
                size="sm"
                onClick={onOpenChat}
                className="h-7 text-xs text-muted-foreground hover:text-text"
              >
                查看全部
                <ArrowRight className="size-3" aria-hidden="true" />
              </Button>
            </div>
            <div className="overflow-hidden rounded-xl border border-border bg-surface-2">
              {recentSessions.length === 0 ? (
                <EmptyHint
                  icon={MessageSquare}
                  text="暂无会话"
                  hint="点击「开始对话」开启第一轮对话"
                />
              ) : (
                <ul className="m-0 list-none divide-y divide-border p-0">
                  {recentSessions.map((s, idx) => (
                    <li key={s.id ?? `session-${idx}`}>
                      <button
                        type="button"
                        onClick={onOpenChat}
                        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-surface-3 focus-visible:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
                      >
                        <MessageSquare
                          className="size-3.5 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 truncate text-sm text-text">
                          {s.title || '未命名会话'}
                        </span>
                        {s.updatedAt !== undefined && (
                          <span className="shrink-0 text-[11px] tabular-nums text-hint">
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

          {novelAvailable && (
            <div className="min-w-0">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="m-0 text-xs font-[760] uppercase tracking-wider text-subtle">
                  最近小说项目
                </h2>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onOpenNovel}
                  className="h-7 text-xs text-muted-foreground hover:text-text"
                >
                  查看全部
                  <ArrowRight className="size-3" aria-hidden="true" />
                </Button>
              </div>
              <div className="overflow-hidden rounded-xl border border-border bg-surface-2">
                {recentProjects.length === 0 ? (
                  <EmptyHint icon={BookOpen} text="暂无项目" hint="从小说创作入口新建第一个项目" />
                ) : (
                  <ul className="m-0 list-none divide-y divide-border p-0">
                    {recentProjects.map((p, idx) => (
                      <li key={p.id ?? `project-${idx}`}>
                        <button
                          type="button"
                          onClick={onOpenNovel}
                          className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-surface-3 focus-visible:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
                        >
                          <BookOpen
                            className="size-3.5 shrink-0 text-warning-label"
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1 truncate text-sm text-text">
                            {p.title || '未命名项目'}
                          </span>
                          <Badge variant="outline" className="shrink-0 text-[10px]">
                            {p.genre}
                          </Badge>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

// ── 子组件 ──

function EmptyHint({
  icon: Icon,
  text,
  hint
}: {
  icon: React.ComponentType<{ className?: string }>
  text: string
  hint: string
}): ReactElement {
  return (
    <div className="flex flex-col items-center gap-1 px-4 py-8 text-center">
      <Icon className="size-4 text-subtle" aria-hidden="true" />
      <p className="m-0 text-xs text-muted-foreground">{text}</p>
      <p className="m-0 text-[11px] text-hint">{hint}</p>
    </div>
  )
}

// ── 工具函数 ──

const rtf = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })

const TIME_DIVISIONS = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Number.POSITIVE_INFINITY, unit: 'year' }
] as const

function relativeTime(timestamp: number): string {
  let duration = Math.round((timestamp - Date.now()) / 1000)
  if (Math.abs(duration) < 60) return '刚刚'
  for (const { amount, unit } of TIME_DIVISIONS) {
    if (Math.abs(duration) < amount) return rtf.format(duration, unit)
    duration = Math.round(duration / amount)
  }
  return ''
}
