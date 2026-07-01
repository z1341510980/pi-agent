import { useState, useMemo, useCallback, type ReactElement } from 'react'
import { Bell, X, Info, AlertTriangle, AlertCircle, CheckCircle2, CheckCheckIcon } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { NotificationPayload } from '@/hooks/use-websocket'

export interface NotificationCenterProps {
  notifications: NotificationPayload[]
  onDismiss: (id: string) => void
  onDismissAll: () => void
}

const LEVEL_CONFIG: Record<
  NotificationPayload['level'],
  { icon: typeof Info; color: string; label: string }
> = {
  info: { icon: Info, color: 'text-primary', label: '信息' },
  success: { icon: CheckCircle2, color: 'text-success', label: '成功' },
  warning: { icon: AlertTriangle, color: 'text-accent-foreground', label: '警告' },
  error: { icon: AlertCircle, color: 'text-destructive', label: '错误' },
}

const CATEGORY_LABELS: Record<NotificationPayload['category'], string> = {
  system: '系统',
  tool: '工具',
  memory: '记忆',
  usage: '用量',
  compaction: '压缩',
  agent: 'Agent',
  confirmation: '确认',
  devlog: '日志',
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return date.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/**
 * NotificationCenter：通知中心
 *
 * 右上角下拉面板，展示所有通知
 * - 按时间倒序排列
 * - 支持按类别筛选（system/tool/memory/usage/compaction/agent/confirmation/devlog）
 * - 支持已读/未读状态管理
 * - 支持单条删除、全部清空、全部标记已读
 * - 面板从右侧滑入（300ms）
 */
export function NotificationCenter({
  notifications,
  onDismiss,
  onDismissAll,
}: NotificationCenterProps): ReactElement {
  const [filter, setFilter] = useState<NotificationPayload['category'] | 'all'>('all')
  const [isOpen, setIsOpen] = useState(false)
  // 已读通知 ID 集合（本地状态，未持久化）
  const [readIds, setReadIds] = useState<Set<string>>(new Set())

  // 未读数量（用于徽标显示）
  const unreadCount = useMemo(
    () => notifications.reduce((sum, n) => (readIds.has(n.id) ? sum : sum + 1), 0),
    [notifications, readIds],
  )

  const filtered = useMemo(() => {
    if (filter === 'all') return notifications
    return notifications.filter((n) => n.category === filter)
  }, [notifications, filter])

  const categories = useMemo(() => {
    const set = new Set(notifications.map((n) => n.category))
    return Array.from(set)
  }, [notifications])

  // 标记单条为已读
  const markAsRead = useCallback((id: string) => {
    setReadIds((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])

  // 全部标记已读
  const markAllAsRead = useCallback(() => {
    setReadIds((prev) => {
      const next = new Set(prev)
      for (const n of notifications) {
        next.add(n.id)
      }
      return next
    })
  }, [notifications])

  // 打开面板时自动标记当前可见通知为已读
  const handleToggleOpen = useCallback(() => {
    setIsOpen((v) => {
      const next = !v
      // 打开时延迟标记已读（让用户先看到未读状态）
      if (next && unreadCount > 0) {
        setTimeout(() => markAllAsRead(), 1500)
      }
      return next
    })
  }, [unreadCount, markAllAsRead])

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="sm"
        className="relative h-9 w-9 p-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={handleToggleOpen}
        aria-label={unreadCount > 0 ? `通知中心（${unreadCount} 条未读）` : '通知中心'}
      >
        <Bell className="h-4 w-4" aria-hidden="true" />
        {unreadCount > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground tabular-nums"
            aria-hidden="true"
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </Button>

      {/* 点击外部关闭的遮罩 */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setIsOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* 通知面板：从右侧滑入（300ms） */}
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            key="notification-panel"
            initial={{ x: 20, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 20, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
            className="absolute right-0 top-full z-50 mt-1 w-80 rounded-lg bg-popover shadow-[0_8px_32px_rgba(0,0,0,0.18),0_2px_8px_rgba(0,0,0,0.08)]"
            role="dialog"
            aria-label="通知列表"
          >
            {/* 头部 */}
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold">通知</span>
                {unreadCount > 0 && (
                  <Badge variant="destructive" className="px-1.5 py-0 text-[10px] tabular-nums">
                    {unreadCount} 未读
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-1">
                {unreadCount > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={markAllAsRead}
                    aria-label="全部标记为已读"
                  >
                    <CheckCheckIcon className="size-3.5" aria-hidden="true" />
                    全部已读
                  </Button>
                )}
                {notifications.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={onDismissAll}
                  >
                    清空
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-9 w-9 p-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  onClick={() => setIsOpen(false)}
                  aria-label="关闭通知面板"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </div>
            </div>

            {/* 筛选标签 */}
            {categories.length > 0 && (
              <div
                className="flex items-center gap-1 overflow-x-auto border-b border-border px-3 py-1.5"
                role="tablist"
                aria-label="通知类别筛选"
              >
                <button
                  role="tab"
                  aria-selected={filter === 'all'}
                  className={cn(
                    'shrink-0 rounded-md px-2 py-0.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                    filter === 'all'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-surface-2'
                  )}
                  onClick={() => setFilter('all')}
                >
                  全部
                </button>
                {categories.map((cat) => (
                  <button
                    key={cat}
                    role="tab"
                    aria-selected={filter === cat}
                    className={cn(
                      'shrink-0 rounded-md px-2 py-0.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                      filter === cat
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-surface-2'
                    )}
                    onClick={() => setFilter(cat)}
                  >
                    {CATEGORY_LABELS[cat]}
                  </button>
                ))}
              </div>
            )}

            {/* 通知列表 */}
            <div className="max-h-80 overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                  暂无通知
                </div>
              ) : (
                filtered.map((n) => {
                  const config = LEVEL_CONFIG[n.level]
                  const Icon = config.icon
                  const isRead = readIds.has(n.id)
                  return (
                    <div
                      key={n.id}
                      className={cn(
                        'group flex items-start gap-2 border-b border-border/50 px-3 py-2 last:border-0 hover:bg-surface-2',
                        !isRead && 'bg-accent/5'
                      )}
                      onClick={() => markAsRead(n.id)}
                    >
                      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', config.color)} aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          {!isRead && (
                            <span
                              className="size-1.5 shrink-0 rounded-full bg-accent"
                              aria-label="未读"
                            />
                          )}
                          <span className={cn('truncate text-xs', !isRead ? 'font-semibold' : 'font-medium')}>{n.title}</span>
                          <Badge variant="secondary" className="shrink-0 px-1 py-0 text-[10px]">
                            {CATEGORY_LABELS[n.category]}
                          </Badge>
                        </div>
                        {n.message && (
                          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground text-pretty">
                            {n.message}
                          </p>
                        )}
                        <span className="mt-0.5 block text-[10px] text-muted-foreground tabular-nums">
                          {formatTime(n.timestamp)}
                        </span>
                      </div>
                      <button
                        className="shrink-0 rounded p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-surface-3 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        onClick={(e) => {
                          e.stopPropagation()
                          onDismiss(n.id)
                        }}
                        aria-label="删除通知"
                      >
                        <X className="h-3 w-3" aria-hidden="true" />
                      </button>
                    </div>
                  )
                })
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
