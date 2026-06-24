import { useState, useMemo, useRef, useEffect, type ReactElement } from 'react'
import { Search, CornerDownLeft, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SessionSummary } from './session-list'

// ── 类型定义 ──

interface MentionPanelProps {
  /** 搜索关键词（不含前导 @） */
  query: string
  /** 可引用的会话列表 */
  sessions: SessionSummary[]
  /** 当前活跃会话 ID（排除自身） */
  activeSessionId: string
  /** 选择会话回调 */
  onSelect: (session: SessionSummary) => void
  /** 关闭面板回调 */
  onClose: () => void
}

// ── 主组件 ──

export function MentionPanel({
  query,
  sessions,
  activeSessionId,
  onSelect,
  onClose,
}: MentionPanelProps): ReactElement | null {
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // 过滤：排除当前会话，按关键词搜索
  const filtered = useMemo(() => {
    const available = sessions.filter((s) => s.id !== activeSessionId)
    if (!query.trim()) return available.slice(0, 20)
    const q = query.toLowerCase()
    return available.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.preview.toLowerCase().includes(q),
    )
  }, [sessions, activeSessionId, query])

  // 重置活动索引
  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  // 滚动到活动项
  useEffect(() => {
    if (!listRef.current) return
    const active = listRef.current.querySelector(`[data-idx="${activeIndex}"]`)
    active?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  // 键盘导航（全局监听，但仅在输入框聚焦时响应）
  useEffect(() => {
    function handleKeyDown(e: globalThis.KeyboardEvent) {
      const active = document.activeElement as HTMLElement | null
      if (active?.id !== 'message-input') return

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        setActiveIndex((i) => Math.min(i + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setActiveIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        const session = filtered[activeIndex]
        if (session) {
          onSelect(session)
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [filtered, activeIndex, onSelect, onClose])

  if (filtered.length === 0) {
    return (
      <div className="absolute bottom-full left-0 right-0 mb-2 rounded-xl border border-border bg-surface-1 shadow-lg overflow-hidden z-50">
        <div className="px-4 py-6 text-center text-sm text-muted-foreground">
          没有匹配的会话
        </div>
      </div>
    )
  }

  return (
    <div
      className="absolute bottom-full left-0 right-0 mb-2 rounded-xl border border-border bg-surface-1 shadow-lg overflow-hidden z-50"
      role="listbox"
      aria-label="会话引用"
    >
      {/* 搜索提示栏 */}
      <div className="flex items-center gap-2.5 px-4 h-10 border-b border-border bg-surface-2/50">
        <Search className="size-4 text-muted-foreground shrink-0" />
        <span className="text-xs text-muted-foreground">
          {query ? `搜索: ${query}` : '搜索会话...'}
        </span>
      </div>

      {/* 会话列表 */}
      <div ref={listRef} className="max-h-[260px] overflow-auto py-2">
        <div className="px-4 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          会话
        </div>
        {filtered.map((session, idx) => {
          const active = idx === activeIndex
          return (
            <button
              key={session.id}
              type="button"
              data-idx={idx}
              onMouseEnter={() => setActiveIndex(idx)}
              onClick={() => onSelect(session)}
              className={cn(
                'w-full flex items-start gap-3 px-4 py-2.5 text-left transition-colors',
                active ? 'bg-surface-2' : 'hover:bg-surface-2/50',
              )}
            >
              <MessageSquare
                className={cn(
                  'size-4 shrink-0 mt-0.5',
                  active ? 'text-primary' : 'text-muted-foreground',
                )}
                aria-hidden="true"
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{session.title}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {session.preview}
                </div>
              </div>
              {active && (
                <CornerDownLeft className="size-3 text-muted-foreground shrink-0 mt-1" />
              )}
            </button>
          )
        })}
      </div>

      {/* 底部提示 */}
      <div className="flex items-center justify-between gap-2 px-4 h-9 border-t border-border bg-surface-2/50 text-xs text-muted-foreground">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <kbd className="bg-surface-3 rounded px-1 py-0.5 font-mono">↑↓</kbd>
            导航
          </span>
          <span className="flex items-center gap-1">
            <kbd className="bg-surface-3 rounded px-1 py-0.5 font-mono">↵</kbd>
            选择
          </span>
          <span className="flex items-center gap-1">
            <kbd className="bg-surface-3 rounded px-1 py-0.5 font-mono">ESC</kbd>
            关闭
          </span>
        </div>
        <span>{filtered.length} 个会话</span>
      </div>
    </div>
  )
}
