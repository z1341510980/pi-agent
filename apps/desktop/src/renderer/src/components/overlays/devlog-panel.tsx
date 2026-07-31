import {
  useState,
  useMemo,
  useEffect,
  useRef,
  useCallback,
  useDeferredValue,
  type ReactElement,
} from 'react'
import {
  Terminal,
  X,
  Trash2,
  Pause,
  Play,
  AlertTriangle,
  Info,
  Bug,
  CircleAlert,
  Search,
  Copy,
  Check,
  ArrowDownToLine,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/hooks/use-toast'
import type { DevLogPayload } from '@/hooks/use-websocket'

// ── 类型定义 ──

export interface DevLogPanelProps {
  logs: DevLogPayload[]
  onClear: () => void
  /** 外部控制展开/收起 */
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}

type FilterLevel = DevLogPayload['level'] | 'all'

interface LevelConfig {
  color: string
  label: string
  bg: string
  dot: string
  Icon: typeof Info
}

const LEVEL_CONFIG: Record<DevLogPayload['level'], LevelConfig> = {
  info: {
    color: 'text-blue-500',
    label: 'INFO',
    bg: 'hover:bg-blue-500/5',
    dot: 'bg-blue-500',
    Icon: Info,
  },
  warn: {
    color: 'text-amber-500',
    label: 'WARN',
    bg: 'hover:bg-amber-500/5',
    dot: 'bg-amber-500',
    Icon: AlertTriangle,
  },
  error: {
    color: 'text-destructive',
    label: 'ERROR',
    bg: 'hover:bg-destructive/5',
    dot: 'bg-destructive',
    Icon: CircleAlert,
  },
  debug: {
    color: 'text-muted-foreground',
    label: 'DEBUG',
    bg: 'hover:bg-muted/30',
    dot: 'bg-muted-foreground',
    Icon: Bug,
  },
}

const FILTER_LEVELS: Array<{ value: FilterLevel; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warn' },
  { value: 'error', label: 'Error' },
  { value: 'debug', label: 'Debug' },
]

const MAX_LOGS = 1000

// ── 工具函数 ──

function formatFullTime(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}`
}

/** 把单条日志格式化为可复制的纯文本 */
function formatLogText(log: DevLogPayload): string {
  const config = LEVEL_CONFIG[log.level]
  const time = formatFullTime(log.timestamp)
  const source = log.source ? `[${log.source}]` : ''
  return `${time} ${config.label} ${source} ${log.message}`.trim()
}

// ── 主组件 ──

/**
 * DevLogPanel：右浮动抽屉式日志面板
 *
 * 布局：右侧浮动抽屉，宽度 420px，从右侧滑入
 * 交互：
 *   - 搜索框（支持关键词 + 来源）
 *   - 级别筛选 Pill
 *   - 点击单条日志复制到剪贴板
 *   - 自动滚动到底部（用户手动滚动时暂停）
 *   - 清空日志
 *   - 复制全部
 * 逻辑：
 *   - 最多保留 MAX_LOGS 条（超出自动裁剪旧数据）
 *   - useDeferredValue 防抖搜索
 *   - 虚拟化渲染（暂用 slice 简化，后续可升级 react-virtual）
 */
export function DevLogPanel({
  logs,
  onClear,
  isOpen,
  onOpenChange,
}: DevLogPanelProps): ReactElement {
  const [filter, setFilter] = useState<FilterLevel>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  /** 用户是否手动滚动过（用于判断是否要暂停自动滚动） */
  const userScrolledRef = useRef(false)

  const deferredQuery = useDeferredValue(searchQuery)

  // 裁剪：保留最新 MAX_LOGS 条
  const trimmedLogs = useMemo(() => {
    if (logs.length <= MAX_LOGS) return logs
    return logs.slice(logs.length - MAX_LOGS)
  }, [logs])

  // 过滤：级别 + 关键词 + 来源
  const filtered = useMemo(() => {
    let result = trimmedLogs
    if (filter !== 'all') {
      result = result.filter((l) => l.level === filter)
    }
    const q = deferredQuery.trim().toLowerCase()
    if (q) {
      // 支持 source: 前缀过滤来源
      const sourceMatch = q.match(/^source:(\S+)\s*(.*)$/)
      if (sourceMatch) {
        const source = sourceMatch[1].toLowerCase()
        const rest = sourceMatch[2]
        result = result.filter((l) => l.source?.toLowerCase().includes(source))
        if (rest) {
          result = result.filter((l) => l.message.toLowerCase().includes(rest))
        }
      } else {
        result = result.filter(
          (l) =>
            l.message.toLowerCase().includes(q) ||
            l.source?.toLowerCase().includes(q),
        )
      }
    }
    return result
  }, [trimmedLogs, filter, deferredQuery])

  // 计数
  const counts = useMemo(() => {
    const c: Record<FilterLevel, number> = {
      all: trimmedLogs.length,
      info: 0,
      warn: 0,
      error: 0,
      debug: 0,
    }
    for (const l of trimmedLogs) c[l.level] += 1
    return c
  }, [trimmedLogs])

  // 自动滚动到底部
  useEffect(() => {
    if (!isOpen || !autoScroll || userScrolledRef.current) return
    const container = scrollRef.current
    if (!container) return
    container.scrollTop = container.scrollHeight
  }, [filtered, isOpen, autoScroll])

  // 打开时重置用户滚动状态
  useEffect(() => {
    if (isOpen) {
      userScrolledRef.current = false
    }
  }, [isOpen])

  // 监听容器滚动，判断用户是否手动滚动
  const handleScroll = useCallback(() => {
    const container = scrollRef.current
    if (!container) return
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight
    // 距离底部 > 40px 视为用户主动向上滚动
    if (distanceFromBottom > 40) {
      userScrolledRef.current = true
    } else {
      userScrolledRef.current = false
    }
  }, [])

  // 复制单条日志
  const handleCopyLog = useCallback(async (log: DevLogPayload) => {
    const text = formatLogText(log)
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(log.id)
      window.setTimeout(() => setCopiedId(null), 2000)
    } catch {
      toast.error('复制失败', '剪贴板不可用')
    }
  }, [])

  // 复制全部（过滤后）
  const handleCopyAll = useCallback(async () => {
    if (filtered.length === 0) return
    const text = filtered.map(formatLogText).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      toast.success('已复制', `共 ${filtered.length} 条日志`)
    } catch {
      toast.error('复制失败', '剪贴板不可用')
    }
  }, [filtered])

  // 跳转到底部
  const scrollToBottom = useCallback(() => {
    const container = scrollRef.current
    if (!container) return
    container.scrollTop = container.scrollHeight
    userScrolledRef.current = false
  }, [])

  const errorCount = counts.error
  const warnCount = counts.warn

  return (
    <>
      {/* 遮罩层（点击关闭） */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[1px] transition-opacity"
          onClick={() => onOpenChange(false)}
          aria-hidden="true"
        />
      )}

      {/* 抽屉本体 */}
      <aside
        className={cn(
          'fixed top-0 right-0 bottom-0 z-50 flex flex-col bg-surface-1/95 backdrop-blur-md border-l border-border shadow-[0_0_60px_-15px_rgba(0,0,0,0.3)] transition-transform duration-200',
          isOpen ? 'translate-x-0' : 'translate-x-full',
        )}
        style={{ width: 'min(480px, 50vw)' }}
        aria-hidden={!isOpen}
        role="complementary"
        aria-label="开发日志面板"
      >
        {/* 顶部标题栏 */}
        <header className="flex h-11 shrink-0 items-center justify-between gap-2 px-3 border-b border-border bg-surface-2/40">
          <div className="flex items-center gap-2 min-w-0">
            <Terminal className="size-3.5 text-muted-foreground shrink-0" />
            <span className="text-sm font-medium text-text">DevLog</span>
            {errorCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-destructive/15 px-1.5 py-0.5 text-[10px] font-semibold text-destructive tabular-nums">
                <CircleAlert className="size-2.5" />
                {errorCount}
              </span>
            )}
            {warnCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400 tabular-nums">
                <AlertTriangle className="size-2.5" />
                {warnCount}
              </span>
            )}
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {filtered.length}/{trimmedLogs.length}
            </span>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {/* 复制全部 */}
            <button
              type="button"
              className="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:text-text hover:bg-surface-3 transition-colors"
              onClick={handleCopyAll}
              disabled={filtered.length === 0}
              aria-label="复制全部日志"
              title="复制全部日志"
            >
              <Copy className="size-3.5" />
            </button>

            {/* 清空 */}
            <button
              type="button"
              className="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-surface-3 transition-colors"
              onClick={onClear}
              disabled={trimmedLogs.length === 0}
              aria-label="清空日志"
              title="清空日志"
            >
              <Trash2 className="size-3.5" />
            </button>

            {/* 自动滚动开关 */}
            <button
              type="button"
              className={cn(
                'inline-flex size-7 items-center justify-center rounded transition-colors',
                autoScroll
                  ? 'text-primary bg-primary/10'
                  : 'text-muted-foreground hover:text-text hover:bg-surface-3',
              )}
              onClick={() => {
                setAutoScroll((v) => !v)
                if (!autoScroll) {
                  // 从暂停切换到自动时，立即跳转到底部
                  scrollToBottom()
                }
              }}
              aria-label={autoScroll ? '暂停自动滚动' : '开启自动滚动'}
              title={autoScroll ? '暂停自动滚动' : '开启自动滚动'}
            >
              {autoScroll ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
            </button>

            {/* 跳转到底部 */}
            <button
              type="button"
              className="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:text-text hover:bg-surface-3 transition-colors"
              onClick={scrollToBottom}
              aria-label="跳转到底部"
              title="跳转到底部"
            >
              <ArrowDownToLine className="size-3.5" />
            </button>

            {/* 关闭 */}
            <button
              type="button"
              className="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:text-text hover:bg-surface-3 transition-colors"
              onClick={() => onOpenChange(false)}
              aria-label="关闭 DevLog"
              title="关闭 (ESC)"
            >
              <X className="size-4" />
            </button>
          </div>
        </header>

        {/* 搜索 + 筛选栏 */}
        <div className="shrink-0 px-3 py-2 border-b border-border bg-surface-1/50 space-y-2">
          {/* 搜索框 */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索消息或来源（可用 source:xxx 过滤来源）"
              className="w-full h-7 pl-8 pr-2 text-xs rounded-md border border-border bg-background/60 text-text placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/40 focus:border-primary/40 transition-colors"
            />
          </div>

          {/* 级别筛选 Pill 组 */}
          <div
            className="flex items-center gap-0.5 p-0.5 rounded-md bg-surface-2"
            role="group"
            aria-label="日志级别筛选"
          >
            {FILTER_LEVELS.map((lvl) => {
              const isActive = filter === lvl.value
              const count = counts[lvl.value]
              return (
                <button
                  key={lvl.value}
                  type="button"
                  className={cn(
                    'flex-1 rounded px-2 py-1 text-[11px] font-medium transition-colors flex items-center justify-center gap-1',
                    isActive
                      ? 'bg-surface-3 text-text shadow-sm'
                      : 'text-muted-foreground hover:text-text',
                  )}
                  onClick={() => setFilter(lvl.value)}
                >
                  {lvl.label}
                  {count > 0 && (
                    <span
                      className={cn(
                        'text-[9px] tabular-nums',
                        isActive ? 'text-text/70' : 'text-muted-foreground/60',
                      )}
                    >
                      {count}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>

        {/* 日志列表 */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 min-h-0 overflow-y-auto px-2 py-2 font-mono text-[11px] leading-relaxed sidebar-scroll"
        >
          {filtered.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground text-xs">
              {trimmedLogs.length === 0
                ? '暂无日志'
                : '没有匹配的日志'}
            </div>
          ) : (
            <div className="space-y-0.5">
              {filtered.map((log) => {
                const config = LEVEL_CONFIG[log.level]
                const Icon = config.Icon
                const copied = copiedId === log.id
                return (
                  <button
                    key={log.id}
                    type="button"
                    onClick={() => handleCopyLog(log)}
                    className={cn(
                      'group flex items-start gap-2 w-full text-left rounded px-1.5 py-1 transition-colors',
                      config.bg,
                      'hover:bg-surface-2',
                    )}
                    title="点击复制此条日志"
                  >
                    <span className="shrink-0 text-muted-foreground/70 tabular-nums">
                      {formatFullTime(log.timestamp)}
                    </span>
                    <Icon
                      className={cn('size-3 shrink-0 mt-0.5', config.color)}
                      aria-hidden="true"
                    />
                    <span className={cn('shrink-0 font-semibold text-[10px]', config.color)}>
                      {config.label}
                    </span>
                    {log.source && (
                      <span className="shrink-0 text-purple-500 dark:text-purple-400 text-[10px]">
                        [{log.source}]
                      </span>
                    )}
                    <span className="min-w-0 flex-1 break-words text-text">
                      {log.message}
                    </span>
                    {/* 悬停时显示复制图标 */}
                    <span
                      className={cn(
                        'shrink-0 mt-0.5 transition-opacity',
                        copied
                          ? 'opacity-100 text-emerald-500'
                          : 'opacity-0 group-hover:opacity-100 text-muted-foreground',
                      )}
                    >
                      {copied ? (
                        <Check className="size-3" />
                      ) : (
                        <Copy className="size-3" />
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* 底部状态栏 */}
        <footer className="shrink-0 flex h-7 items-center justify-between px-3 border-t border-border bg-surface-2/40 text-[10px] text-muted-foreground">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="bg-surface-3 rounded px-1 py-0.5 font-mono">ESC</kbd>
              关闭
            </span>
            <span className="flex items-center gap-1">
              <kbd className="bg-surface-3 rounded px-1 py-0.5 font-mono">⌘K</kbd>
              命令面板
            </span>
          </div>
          <span className="tabular-nums">
            显示 {filtered.length} / 共 {trimmedLogs.length} 条
            {logs.length > MAX_LOGS && (
              <span className="text-muted-foreground/60">
                {' '}(原 {logs.length})
              </span>
            )}
          </span>
        </footer>
      </aside>
    </>
  )
}
