import { useState, useMemo, useEffect, type ReactElement } from 'react'
import { Terminal, ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { DevLogPayload } from '@/hooks/use-websocket'

export interface DevLogPanelProps {
  logs: DevLogPayload[]
  onClear: () => void
  /** 外部控制展开/收起 */
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}

const LEVEL_CONFIG: Record<
  DevLogPayload['level'],
  { color: string; label: string; bg: string }
> = {
  info: { color: 'text-primary', label: 'INFO', bg: 'bg-primary/10' },
  warn: { color: 'text-accent-foreground', label: 'WARN', bg: 'bg-accent/10' },
  error: { color: 'text-destructive', label: 'ERROR', bg: 'bg-destructive/10' },
  debug: { color: 'text-muted-foreground', label: 'DEBUG', bg: 'bg-muted/10' },
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

/**
 * DevLogPanel：开发者日志面板
 *
 * 底部抽屉式展开，按级别筛选（info/warn/error/debug）
 * 快捷键 Cmd/Ctrl+D 切换
 */
export function DevLogPanel({
  logs,
  onClear,
  isOpen,
  onOpenChange,
}: DevLogPanelProps): ReactElement {
  const [filter, setFilter] = useState<DevLogPayload['level'] | 'all'>('all')
  const [autoScroll, setAutoScroll] = useState(true)

  const filtered = useMemo(() => {
    if (filter === 'all') return logs
    return logs.filter((l) => l.level === filter)
  }, [logs, filter])

  // 自动滚动到底部
  useEffect(() => {
    if (isOpen && autoScroll) {
      const container = document.getElementById('devlog-container')
      if (container) {
        container.scrollTop = container.scrollHeight
      }
    }
  }, [filtered, isOpen, autoScroll])

  const errorCount = logs.filter((l) => l.level === 'error').length
  const warnCount = logs.filter((l) => l.level === 'warn').length

  return (
    <>
      {/* 底部抽屉 */}
      <div
        className={cn(
          'flex flex-col border-t border-border bg-surface-1 transition-[height] duration-200',
          isOpen ? 'h-48' : 'h-7'
        )}
      >
        {/* 标题栏 */}
        <div
          className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1 cursor-pointer hover:bg-surface-2"
          onClick={() => onOpenChange(!isOpen)}
        >
          <div className="flex items-center gap-2">
            <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">DevLog</span>
            {errorCount > 0 && (
              <span className="rounded bg-destructive/20 px-1.5 py-0.5 text-[10px] font-bold text-destructive tabular-nums">
                {errorCount} 错误
              </span>
            )}
            {warnCount > 0 && (
              <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-bold text-accent-foreground tabular-nums">
                {warnCount} 警告
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {isOpen && (
              <>
                {/* 级别筛选 */}
                <div className="flex items-center gap-0.5">
                  {(['all', 'info', 'warn', 'error', 'debug'] as const).map((level) => (
                    <button
                      key={level}
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[10px] uppercase transition-colors',
                        filter === level
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:bg-surface-3'
                      )}
                      onClick={(e) => {
                        e.stopPropagation()
                        setFilter(level)
                      }}
                    >
                      {level}
                    </button>
                  ))}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-[10px]"
                  onClick={(e) => {
                    e.stopPropagation()
                    onClear()
                  }}
                >
                  清空
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0"
                  onClick={(e) => {
                    e.stopPropagation()
                    setAutoScroll((v) => !v)
                  }}
                  title={autoScroll ? '暂停自动滚动' : '开启自动滚动'}
                >
                  {autoScroll ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
                </Button>
              </>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={(e) => {
                e.stopPropagation()
                onOpenChange(!isOpen)
              }}
            >
              {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
            </Button>
          </div>
        </div>

        {/* 日志内容 */}
        {isOpen && (
          <div
            id="devlog-container"
            className="flex-1 overflow-y-auto px-3 py-1 font-mono text-xs"
          >
            {filtered.length === 0 ? (
              <div className="py-4 text-center text-muted-foreground">暂无日志</div>
            ) : (
              filtered.map((log) => {
                const config = LEVEL_CONFIG[log.level]
                return (
                  <div
                    key={log.id}
                    className={cn(
                      'flex items-start gap-2 rounded px-1.5 py-0.5 hover:bg-surface-2',
                      config.bg
                    )}
                  >
                    <span className="shrink-0 text-muted-foreground">{formatTime(log.timestamp)}</span>
                    <span className={cn('shrink-0 font-bold', config.color)}>{config.label}</span>
                    {log.source && (
                      <span className="shrink-0 text-purple-400">[{log.source}]</span>
                    )}
                    <span className="min-w-0 flex-1 break-words text-foreground">{log.message}</span>
                  </div>
                )
              })
            )}
          </div>
        )}
      </div>
    </>
  )
}
