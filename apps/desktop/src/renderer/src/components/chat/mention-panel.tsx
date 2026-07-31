import {
  useState,
  useMemo,
  useRef,
  useEffect,
  useCallback,
  useDeferredValue,
  type ReactElement,
  type ReactNode,
} from 'react'
import {
  Search,
  CornerDownLeft,
  MessageSquare,
  Hash,
  Clock,
  Sparkles,
} from 'lucide-react'
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
  /** 选择会话回调，参数为：插入文本 + 选中的会话（用于后续联动） */
  onSelect: (insertText: string, session: SessionSummary) => void
  /** 关闭面板回调 */
  onClose: () => void
}

// ── 常量 ──

const RESULT_LIMIT = 8
const EMPTY_QUERY_LIMIT = 8

// ── 匹配 + 高亮算法 ──

/** 子串匹配（用于加分项） */
function containsAt(value: string, keyword: string): number {
  return value.toLowerCase().indexOf(keyword.toLowerCase())
}

/** 子序列 fuzzy 匹配 */
function fuzzyMatchIndices(value: string, keyword: string): number[] | null {
  if (!keyword) return []
  const v = value.toLowerCase()
  const k = keyword.toLowerCase()
  const indices: number[] = []
  let ki = 0
  for (let vi = 0; vi < v.length && ki < k.length; vi++) {
    if (v[vi] === k[ki]) {
      indices.push(vi)
      ki += 1
    }
  }
  return ki === k.length ? indices : null
}

/**
 * 计算会话匹配得分（参考 AionUi computeMentionScore 思路，扩展为多字段）
 * - 标题完全匹配：400
 * - 标题去标点后等于：350
 * - 标题前缀匹配：300
 * - 标题包含：200
 * - preview 前缀匹配：100
 * - preview 包含：50
 * - 子序列匹配标题：30
 * - 都不匹配：-1
 */
function computeSessionScore(
  session: SessionSummary,
  keyword: string,
): { indices: number[] | null; score: number; matchedField: 'title' | 'preview' | null } {
  const k = keyword.trim().toLowerCase()
  if (!k) return { indices: [], score: 0, matchedField: null }

  const title = session.title.toLowerCase()
  const preview = session.preview.toLowerCase()

  // 1. 标题完全匹配
  if (title === k) {
    return {
      indices: Array.from({ length: k.length }, (_, i) => i),
      score: 400,
      matchedField: 'title',
    }
  }

  // 2. 标题去标点后等于
  const titleClean = title.replace(/[^\w\u4e00-\u9fa5]/g, '')
  if (titleClean === k) {
    return {
      indices: Array.from({ length: k.length }, (_, i) => i),
      score: 350,
      matchedField: 'title',
    }
  }

  // 3. 标题前缀匹配
  if (title.startsWith(k)) {
    return {
      indices: Array.from({ length: k.length }, (_, i) => i),
      score: 300,
      matchedField: 'title',
    }
  }

  // 4. 标题包含
  const titleSubIdx = containsAt(title, k)
  if (titleSubIdx >= 0) {
    return {
      indices: Array.from({ length: k.length }, (_, i) => titleSubIdx + i),
      score: 200,
      matchedField: 'title',
    }
  }

  // 5. preview 前缀
  if (preview.startsWith(k)) {
    return {
      indices: Array.from({ length: k.length }, (_, i) => i),
      score: 100,
      matchedField: 'preview',
    }
  }

  // 6. preview 包含
  const previewSubIdx = containsAt(preview, k)
  if (previewSubIdx >= 0) {
    return {
      indices: Array.from({ length: k.length }, (_, i) => previewSubIdx + i),
      score: 50,
      matchedField: 'preview',
    }
  }

  // 7. 标题子序列匹配
  const fuzzyIndices = fuzzyMatchIndices(title, k)
  if (fuzzyIndices) {
    return { indices: fuzzyIndices, score: 30, matchedField: 'title' }
  }

  return { indices: null, score: -1, matchedField: null }
}

/** 按高亮索引切分文本 */
function splitHighlight(
  text: string,
  indices: number[] | null,
): Array<{ text: string; highlighted: boolean }> {
  if (!indices || indices.length === 0) {
    return [{ text, highlighted: false }]
  }
  const set = new Set(indices)
  const parts: Array<{ text: string; highlighted: boolean }> = []
  let buffer = ''
  let bufferHighlighted = false
  for (let i = 0; i < text.length; i++) {
    const isHl = set.has(i)
    if (i === 0) {
      buffer = text[i]
      bufferHighlighted = isHl
    } else if (isHl === bufferHighlighted) {
      buffer += text[i]
    } else {
      parts.push({ text: buffer, highlighted: bufferHighlighted })
      buffer = text[i]
      bufferHighlighted = isHl
    }
  }
  if (buffer) parts.push({ text: buffer, highlighted: bufferHighlighted })
  return parts
}

/** 渲染高亮文本 */
function renderHighlighted(
  text: string,
  indices: number[] | null,
): ReactNode {
  const segments = splitHighlight(text, indices)
  return segments.map((seg, i) =>
    seg.highlighted ? (
      <mark
        key={i}
        className="bg-primary/20 text-primary rounded-[2px] px-0.5 font-semibold"
      >
        {seg.text}
      </mark>
    ) : (
      <span key={i}>{seg.text}</span>
    ),
  )
}

// ── 相对时间格式 ──

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
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
  /** 鼠标 hover 索引（与 activeIndex 解耦） */
  const [hoverIndex, setHoverIndex] = useState<number>(-1)
  const listRef = useRef<HTMLDivElement>(null)
  /** 用户最后操作来源 */
  const lastInputSource = useRef<'keyboard' | 'mouse'>('keyboard')

  // 用 deferred value 防抖过滤
  const deferredQuery = useDeferredValue(query)

  // 过滤 + 打分 + 排序
  const filtered = useMemo(() => {
    const available = sessions.filter((s) => s.id !== activeSessionId)
    const q = deferredQuery.trim()

    // 空查询：按 updatedAt 倒序，取前 N 条
    if (!q) {
      return available
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, EMPTY_QUERY_LIMIT)
        .map((session) => ({ session, indices: null as number[] | null, matchedField: null as 'title' | 'preview' | null }))
    }

    // 有查询：打分 + 排序 + 限制
    return available
      .map((session) => {
        const { indices, score, matchedField } = computeSessionScore(session, q)
        if (score < 0) return null
        return { session, indices, score, matchedField }
      })
      .filter(
        (x): x is {
          session: SessionSummary
          indices: number[] | null
          score: number
          matchedField: 'title' | 'preview'
        } => x !== null,
      )
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        // 同分按 updatedAt 倒序
        return b.session.updatedAt - a.session.updatedAt
      })
      .slice(0, RESULT_LIMIT)
      .map(({ session, indices, matchedField }) => ({ session, indices, matchedField }))
  }, [sessions, activeSessionId, deferredQuery])

  // 重置 activeIndex（query 变化时）
  useEffect(() => {
    setActiveIndex(0)
    setHoverIndex(-1)
    lastInputSource.current = 'keyboard'
  }, [deferredQuery])

  // 滚动 active 项到可视区
  useEffect(() => {
    if (!listRef.current) return
    const active = listRef.current.querySelector(`[data-idx="${activeIndex}"]`)
    active?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  // 选中处理：构造插入文本 + 回调
  const handleSelect = useCallback(
    (session: SessionSummary) => {
      // 插入格式：@会话标题（若标题含空格用引号包裹）
      const title = session.title.trim()
      const needsQuote = /\s/.test(title) || /[，,;；!！?？()（）\[\]【】{}]/.test(title)
      const insertText = needsQuote ? `@"${title}" ` : `@${title} `
      onSelect(insertText, session)
    },
    [onSelect],
  )

  // 键盘导航
  useEffect(() => {
    function handleKeyDown(e: globalThis.KeyboardEvent) {
      const active = document.activeElement as HTMLElement | null
      if (active?.id !== 'message-input') return

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        lastInputSource.current = 'keyboard'
        setHoverIndex(-1)
        setActiveIndex((i) => (i + 1) % Math.max(filtered.length, 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        lastInputSource.current = 'keyboard'
        setHoverIndex(-1)
        setActiveIndex((i) => (i - 1 + filtered.length) % Math.max(filtered.length, 1))
      } else if (e.key === 'Enter' && !e.shiftKey) {
        const item = filtered[activeIndex]
        if (item) {
          e.preventDefault()
          e.stopPropagation()
          handleSelect(item.session)
        }
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [filtered, activeIndex, handleSelect, onClose])

  // 空状态
  if (filtered.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-popover shadow-[0_20px_60px_-15px_rgba(0,0,0,0.25),0_8px_24px_-8px_rgba(0,0,0,0.12)] overflow-hidden">
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
          <Search className="size-6 text-muted-foreground/40" aria-hidden="true" />
          <div className="text-sm text-muted-foreground">没有匹配的会话</div>
          {query && (
            <div className="text-xs text-muted-foreground/70">
              未找到包含「{query}」的会话
            </div>
          )}
        </div>
      </div>
    )
  }

  const isSearching = deferredQuery.trim().length > 0

  return (
    <div
      className="rounded-2xl border border-border bg-popover/95 backdrop-blur-md shadow-[0_20px_60px_-15px_rgba(0,0,0,0.25),0_8px_24px_-8px_rgba(0,0,0,0.12)] overflow-hidden"
      role="listbox"
      aria-label="会话引用"
      aria-activedescendant={`mention-item-${activeIndex}`}
    >
      {/* 顶部：标题栏 */}
      <div className="flex items-center justify-between gap-2 px-3.5 h-9 border-b border-border/60 bg-surface-2/40">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <Hash className="size-3" aria-hidden="true" />
          <span>引用会话</span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px]">
          {isSearching ? (
            <span className="text-muted-foreground">
              搜索: <span className="text-text font-medium">{deferredQuery}</span>
            </span>
          ) : (
            <span className="text-muted-foreground/70 flex items-center gap-1">
              <Sparkles className="size-2.5" aria-hidden="true" />
              最近更新的会话
            </span>
          )}
          <kbd className="font-mono text-muted-foreground/60 px-1.5 py-0.5 rounded bg-surface-3">
            ESC
          </kbd>
        </div>
      </div>

      {/* 列表 */}
      <div
        ref={listRef}
        className="max-h-[min(34vh,260px)] overflow-y-auto p-1.5 sidebar-scroll"
        onMouseLeave={() => setHoverIndex(-1)}
      >
        <div className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-semibold text-muted-foreground/80 uppercase tracking-wider">
          <MessageSquare className="size-2.5" aria-hidden="true" />
          会话
          <span className="text-muted-foreground/50 font-normal normal-case tracking-normal">
            · {filtered.length}
          </span>
        </div>
        {filtered.map(({ session, indices, matchedField }, idx) => {
          const active = idx === activeIndex
          const hovered = idx === hoverIndex
          const isHighlighted = active || (hovered && lastInputSource.current === 'mouse')
          return (
            <button
              key={session.id}
              id={`mention-item-${idx}`}
              type="button"
              data-idx={idx}
              role="option"
              aria-selected={active}
              onMouseMove={() => {
                if (hoverIndex !== idx) {
                  lastInputSource.current = 'mouse'
                  setHoverIndex(idx)
                }
              }}
              // 用 onMouseDown + preventDefault 防止 textarea 失焦
              onMouseDown={(e) => {
                e.preventDefault()
                handleSelect(session)
              }}
              className={cn(
                'relative w-full flex items-center gap-2.5 pl-3 pr-2 py-2 rounded-lg text-left transition-colors active:scale-[0.99]',
                isHighlighted
                  ? 'bg-primary/8 text-text'
                  : 'text-text hover:bg-surface-2/40',
              )}
            >
              {/* 左侧 indicator bar（仅 active 显示） */}
              {active && (
                <span
                  className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-primary"
                  aria-hidden="true"
                />
              )}
              <span
                className={cn(
                  'flex size-7 shrink-0 items-center justify-center rounded-md transition-colors',
                  active
                    ? 'bg-primary/15 text-primary'
                    : 'bg-surface-3 text-muted-foreground',
                )}
              >
                <MessageSquare className="size-3.5" aria-hidden="true" />
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">
                  {/* 仅当匹配字段是 title 时才高亮 title */}
                  {matchedField === 'title'
                    ? renderHighlighted(session.title, indices)
                    : session.title}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="text-[11px] text-muted-foreground truncate leading-tight flex-1 min-w-0">
                    {/* 匹配 preview 时高亮 */}
                    {matchedField === 'preview'
                      ? renderHighlighted(session.preview, indices)
                      : session.preview}
                  </span>
                  <span className="shrink-0 inline-flex items-center gap-0.5 text-[10px] text-muted-foreground/70 tabular-nums">
                    <Clock className="size-2.5" aria-hidden="true" />
                    {formatRelativeTime(session.updatedAt)}
                  </span>
                </div>
              </div>
              {active && (
                <CornerDownLeft
                  className="size-3 text-muted-foreground shrink-0"
                  aria-hidden="true"
                />
              )}
            </button>
          )
        })}
      </div>

      {/* 底部：状态栏 */}
      <div className="flex items-center justify-between gap-2 px-3.5 h-8 border-t border-border/60 bg-surface-2/40 text-[10px] text-muted-foreground">
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
            <kbd className="bg-surface-3 rounded px-1 py-0.5 font-mono">Tab</kbd>
            关闭
          </span>
        </div>
        <span className="tabular-nums">{filtered.length} 个会话</span>
      </div>
    </div>
  )
}
