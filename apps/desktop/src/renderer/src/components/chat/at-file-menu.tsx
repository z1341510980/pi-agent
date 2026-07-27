import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Folder } from 'lucide-react'
import type { SessionSummary } from './session-list'
import { cn } from '@/lib/utils'

/** AtFileMenu 项：可以是文件、会话或 agent */
export interface AtFileMenuItem {
  type: 'file' | 'session' | 'agent'
  id: string
  label: string
  /** 副标题（如会话预览、文件路径） */
  preview?: string
}

export interface AtFileMenuProps {
  /** 当前 @ 后的搜索词（不含 @） */
  query: string
  /** 可引用的会话列表（由父级注入，避免组件内部网络依赖） */
  sessions: SessionSummary[]
  /** 当前活跃会话 ID（排除自身） */
  activeSessionId?: string
  /** 额外的文件项（未来扩展用，由父级 fetch /files/search 注入） */
  files?: Array<{ id: string; name: string; path?: string }>
  /** 选中某项时回调 */
  onSelect: (item: AtFileMenuItem) => void
  /** 关闭面板 */
  onClose: () => void
}

/**
 * AtFileMenu：@文件/会话 mention 菜单（Stage 2 Task 2.4）
 *
 * 参考 AionUi `AtFileMenu`：纯展示组件，items 由父级注入。
 * 当前 pi-agent 没有 /files/search 路由，先以 sessions 为主，
 * 通过 files prop 预留文件搜索能力的接入点。
 *
 * 与 `MentionPanel` 的关系：
 *   - MentionPanel 已有完整键盘导航 + 视觉（搜索栏 + kbd 提示）
 *   - AtFileMenu 是更轻量的 listbox，适合未来扩展为统一的
 *     "文件 + 会话 + agent" 引用面板
 *   - 当前 input-area 仍使用 MentionPanel 处理 @；AtFileMenu 作为
 *     可选替代项，已通过 typecheck + 视觉对齐 AionUi token，
 *     父级可在需要时切换为 AtFileMenu
 */
export function AtFileMenu({
  query,
  sessions,
  activeSessionId,
  files = [],
  onSelect,
  onClose
}: AtFileMenuProps) {
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const items = useMemo<AtFileMenuItem[]>(() => {
    const q = query.trim().toLowerCase()
    // 文件项（来自父级注入，未来可接入 /files/search）
    const fileItems: AtFileMenuItem[] = files
      .filter((f) => !q || f.name.toLowerCase().includes(q))
      .slice(0, 5)
      .map((f) => ({
        type: 'file' as const,
        id: f.id,
        label: f.name,
        preview: f.path
      }))
    // 会话项（排除当前活跃会话）
    const sessionItems: AtFileMenuItem[] = sessions
      .filter((s) => s.id !== activeSessionId)
      .filter((s) => !q || s.title.toLowerCase().includes(q) || s.preview.toLowerCase().includes(q))
      .slice(0, 10)
      .map((s) => ({
        type: 'session' as const,
        id: s.id,
        label: s.title,
        preview: s.preview
      }))
    return [...fileItems, ...sessionItems]
  }, [query, sessions, activeSessionId, files])

  // items 变化时重置高亮
  useEffect(() => {
    setActiveIndex(0)
  }, [items])

  // 滚动到活动项
  useEffect(() => {
    if (!listRef.current) return
    const active = listRef.current.querySelector(`[data-idx="${activeIndex}"]`)
    active?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  // 键盘导航（全局 capture，与 MentionPanel 同模式；仅在 textarea 聚焦时响应）
  useEffect(() => {
    function handleKeyDown(e: globalThis.KeyboardEvent) {
      const active = document.activeElement as HTMLElement | null
      if (active?.id !== 'message-input') return
      if (items.length === 0) return

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        setActiveIndex((i) => Math.min(i + 1, items.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setActiveIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        const item = items[activeIndex]
        if (item) onSelect(item)
        onClose()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [items, activeIndex, onSelect, onClose])

  if (items.length === 0) {
    return (
      <div className="absolute bottom-full left-0 mb-1 w-64 rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-3 py-4 text-center text-xs text-[var(--t-tertiary)] shadow-lg">
        没有匹配项
      </div>
    )
  }

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 mb-1 max-h-60 w-64 overflow-auto rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] shadow-lg"
      role="listbox"
      aria-label="@文件/会话引用"
    >
      {items.map((item, idx) => {
        const active = idx === activeIndex
        return (
          <button
            key={`${item.type}-${item.id}`}
            type="button"
            role="option"
            aria-selected={active}
            data-idx={idx}
            onMouseEnter={() => setActiveIndex(idx)}
            onClick={() => {
              onSelect(item)
              onClose()
            }}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
              active ? 'bg-[var(--fill-2)]' : 'hover:bg-[var(--fill-1)]'
            )}
          >
            {item.type === 'file' ? (
              <FileText className="h-3 w-3 shrink-0 text-[var(--t-tertiary)]" />
            ) : (
              <Folder className="h-3 w-3 shrink-0 text-[var(--t-tertiary)]" />
            )}
            <div className="flex-1 min-w-0">
              <div className="truncate text-[var(--t-primary)]">{item.label}</div>
              {item.preview && (
                <div className="truncate text-[10px] text-[var(--t-tertiary)]">{item.preview}</div>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}
