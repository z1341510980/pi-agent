import { useState, useMemo, useRef, useEffect, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, CornerDownLeft, FileText, Zap } from 'lucide-react'
// CornerDownLeft 在 JSX 中直接使用
import { getApi } from '../../api/http-client'
import { cn } from '@/lib/utils'

// ── 类型定义 ──

interface SkillInfo {
  name: string
  description: string
  path: string
}

interface SlashCommand {
  id: string
  label: string
  hint: string
  icon: typeof FileText
  group: 'command' | 'skill'
  insertText: string
}

interface SlashCommandPanelProps {
  /** 搜索关键词（不含前导 /） */
  query: string
  /** 选择指令回调 */
  onSelect: (insertText: string) => void
  /** 关闭面板回调 */
  onClose: () => void
}

// ── 固定命令 ──

const FIXED_COMMANDS: SlashCommand[] = [
  {
    id: 'cmd-spec',
    label: 'Spec',
    hint: '根据需求细化完整的规范、任务、验收文档，用户确认后再严格执行',
    icon: FileText,
    group: 'command',
    insertText: '/spec ',
  },
  {
    id: 'cmd-plan',
    label: 'Plan',
    hint: '优先规划任务的执行方向，用户确认后再执行',
    icon: FileText,
    group: 'command',
    insertText: '/plan ',
  },
]

// ── 主组件 ──

export function SlashCommandPanel({
  query,
  onSelect,
  onClose,
}: SlashCommandPanelProps): ReactElement | null {
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // 从后端获取技能列表
  const skillsQuery = useQuery({
    queryKey: ['skills'],
    queryFn: () => getApi<SkillInfo[]>('/api/skills'),
    staleTime: 60_000,
  })

  // 合并固定命令 + 动态技能
  const allCommands = useMemo<SlashCommand[]>(() => {
    const skillCommands: SlashCommand[] = (skillsQuery.data ?? []).map((skill) => ({
      id: `skill-${skill.name}`,
      label: skill.name,
      hint: skill.description,
      icon: Zap,
      group: 'skill' as const,
      insertText: `/${skill.name} `,
    }))
    return [...FIXED_COMMANDS, ...skillCommands]
  }, [skillsQuery.data])

  // 按搜索关键词过滤
  const filtered = useMemo(() => {
    if (!query.trim()) return allCommands
    const q = query.toLowerCase()
    return allCommands.filter(
      (cmd) =>
        cmd.label.toLowerCase().includes(q) ||
        cmd.hint.toLowerCase().includes(q),
    )
  }, [allCommands, query])

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
      // 仅当消息输入框聚焦时才拦截
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
        const cmd = filtered[activeIndex]
        if (cmd) {
          onSelect(cmd.insertText)
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
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          没有匹配的指令
        </div>
      </div>
    )
  }

  // 分组分类
  const grouped = useMemo(() => {
    const map = new Map<string, SlashCommand[]>()
    for (const cmd of filtered) {
      const arr = map.get(cmd.group) ?? []
      arr.push(cmd)
      map.set(cmd.group, arr)
    }
    return Array.from(map.entries())
  }, [filtered])

  const groupLabels: Record<string, string> = {
    command: '命令',
    skill: '技能',
  }

  let runningIdx = -1

  return (
    <div
      className="absolute bottom-full left-0 right-0 mb-2 rounded-xl border border-border bg-surface-1 shadow-lg overflow-hidden z-50"
      role="listbox"
      aria-label="指令面板"
    >
      {/* 搜索提示栏 */}
      <div className="flex items-center gap-2.5 px-4 h-10 border-b border-border bg-surface-2/50">
        <Search className="size-4 text-muted-foreground shrink-0" />
        <span className="text-xs text-muted-foreground">
          {query ? `搜索: ${query}` : '输入搜索...'}
        </span>
      </div>

      {/* 指令列表 */}
      <div ref={listRef} className="max-h-[320px] overflow-auto py-2">
        {grouped.map(([group, cmds]) => (
          <div key={group} className="mb-1">
            <div className="px-4 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              {groupLabels[group] ?? group}
            </div>
            {cmds.map((cmd) => {
              runningIdx += 1
              const idx = runningIdx
              const active = idx === activeIndex
              const Icon = cmd.icon
              return (
                <button
                  key={cmd.id}
                  type="button"
                  data-idx={idx}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => onSelect(cmd.insertText)}
                  className={cn(
                    'w-full flex items-start gap-3 px-4 py-2.5 text-left transition-colors',
                    active ? 'bg-surface-2' : 'hover:bg-surface-2/50',
                  )}
                >
                  <Icon
                    className={cn(
                      'size-4 shrink-0 mt-0.5',
                      active ? 'text-primary' : 'text-muted-foreground',
                    )}
                    aria-hidden="true"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{cmd.label}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {cmd.hint}
                    </div>
                  </div>
                  {active && (
                    <CornerDownLeft className="size-3 text-muted-foreground shrink-0 mt-1" />
                  )}
                </button>
              )
            })}
          </div>
        ))}
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
        <span>{filtered.length} 个指令</span>
      </div>
    </div>
  )
}
