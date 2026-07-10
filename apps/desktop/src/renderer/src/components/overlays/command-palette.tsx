import type { ReactElement } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  SearchIcon,
  PlusIcon,
  SettingsIcon,
  ArchiveIcon,
  SunIcon,
  BotIcon,
  ShieldIcon,
  GaugeIcon,
  CornerDownLeftIcon,
} from 'lucide-react'

// ── 类型定义 ──

export interface Command {
  id: string
  label: string
  hint?: string
  shortcut?: string
  icon: typeof SearchIcon
  group: 'session' | 'agent' | 'settings' | 'view'
  action: () => void
}

interface CommandPaletteProps {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  commands: Command[]
}

// ── 主组件 ──

export function CommandPalette({
  isOpen,
  onOpenChange,
  commands,
}: CommandPaletteProps): ReactElement | null {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // 过滤命令
  const filtered = useMemo(() => {
    if (!query.trim()) return commands
    const q = query.toLowerCase()
    return commands.filter(
      (cmd) =>
        cmd.label.toLowerCase().includes(q) ||
        cmd.hint?.toLowerCase().includes(q) ||
        cmd.group.toLowerCase().includes(q),
    )
  }, [commands, query])

  // 重置状态
  useEffect(() => {
    if (!isOpen) return undefined
    setQuery('')
    setActiveIndex(0)
    // 聚焦输入框
    const t = window.setTimeout(() => inputRef.current?.focus(), 50)
    return () => window.clearTimeout(t)
  }, [isOpen])

  // 活动索引重置
  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  // 滚动到活动项
  useEffect(() => {
    if (!listRef.current) return
    const active = listRef.current.querySelector(`[data-idx="${activeIndex}"]`)
    active?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  // 键盘导航
  function handleKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const cmd = filtered[activeIndex]
      if (cmd) {
        cmd.action()
        onOpenChange(false)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onOpenChange(false)
    }
  }

  if (!isOpen) return null

  // 按组分类
  const grouped = useMemo(() => {
    const map = new Map<string, Command[]>()
    for (const cmd of filtered) {
      const arr = map.get(cmd.group) ?? []
      arr.push(cmd)
      map.set(cmd.group, arr)
    }
    return Array.from(map.entries())
  }, [filtered])

  // 组标签
  const groupLabels: Record<string, string> = {
    session: '会话',
    agent: 'Agent',
    settings: '设置',
    view: '视图',
  }

  let runningIdx = -1

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="命令面板"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="w-full max-w-[560px] mx-4 bg-surface-1 rounded-xl overflow-hidden shadow-[0_8px_32px_rgba(0,0,0,0.18),0_2px_8px_rgba(0,0,0,0.08)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── 搜索框 ── */}
        <div className="flex items-center gap-2.5 px-4 h-12 border-b border-border">
          <SearchIcon className="size-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入命令或搜索..."
            className="flex-1 bg-transparent border-0 outline-none text-sm placeholder:text-muted-foreground"
            aria-label="搜索命令"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="text-xs text-muted-foreground bg-surface-3 rounded px-1.5 py-0.5 font-mono">
            ESC
          </kbd>
        </div>

        {/* ── 命令列表 ── */}
        <div ref={listRef} className="max-h-[400px] overflow-auto py-2">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              没有匹配的命令
            </div>
          ) : (
            grouped.map(([group, cmds]) => (
              <div key={group} className="mb-1">
                <div className="px-4 py-1 text-xs text-muted-foreground font-[760] uppercase tracking-wide">
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
                      onClick={() => {
                        cmd.action()
                        onOpenChange(false)
                      }}
                      className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                        active ? 'bg-surface-2' : 'hover:bg-surface-2/50'
                      }`}
                    >
                      <Icon className={`size-4 shrink-0 ${active ? 'text-accent' : 'text-muted-foreground'}`} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-[760] truncate">{cmd.label}</div>
                        {cmd.hint && (
                          <div className="text-xs text-muted-foreground truncate">{cmd.hint}</div>
                        )}
                      </div>
                      {cmd.shortcut && (
                        <kbd className="text-xs text-muted-foreground bg-surface-3 rounded px-1.5 py-0.5 font-mono shrink-0">
                          {cmd.shortcut}
                        </kbd>
                      )}
                      {active && (
                        <CornerDownLeftIcon className="size-3 text-muted-foreground shrink-0" />
                      )}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>

        {/* ── 底部提示 ── */}
        <div className="flex items-center justify-between gap-2 px-4 h-9 border-t border-border bg-surface-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="bg-surface-3 rounded px-1 py-0.5 font-mono">↑↓</kbd>
              导航
            </span>
            <span className="flex items-center gap-1">
              <kbd className="bg-surface-3 rounded px-1 py-0.5 font-mono">↵</kbd>
              执行
            </span>
            <span className="flex items-center gap-1">
              <kbd className="bg-surface-3 rounded px-1 py-0.5 font-mono">ESC</kbd>
              关闭
            </span>
          </div>
          <span className="tabular-nums">{filtered.length} 个命令</span>
        </div>
      </div>
    </div>
  )
}

// ── 默认命令工厂 ──

export function createDefaultCommands(actions: {
  onNewSession: () => void
  onOpenSettings: () => void
  onCompact: () => void
  onToggleTheme: () => void
  onSwitchMode: () => void
  onSwitchModel: () => void
  onViewUsage: () => void
}): Command[] {
  return [
    {
      id: 'new-session',
      label: '新建会话',
      hint: '创建一个新的对话会话',
      shortcut: '⌘N',
      icon: PlusIcon,
      group: 'session',
      action: actions.onNewSession,
    },
    {
      id: 'compact',
      label: '手动压缩当前会话',
      hint: '压缩上下文以释放 token 空间',
      icon: ArchiveIcon,
      group: 'session',
      action: actions.onCompact,
    },
    {
      id: 'switch-model',
      label: '切换模型',
      hint: '选择当前会话使用的 LLM 模型',
      icon: BotIcon,
      group: 'agent',
      action: actions.onSwitchModel,
    },
    {
      id: 'switch-mode',
      label: '切换权限模式',
      hint: 'Auto / Plan / Read-only',
      icon: ShieldIcon,
      group: 'agent',
      action: actions.onSwitchMode,
    },
    {
      id: 'view-usage',
      label: '查看用量',
      hint: '打开用量面板查看成本统计',
      icon: GaugeIcon,
      group: 'view',
      action: actions.onViewUsage,
    },
    {
      id: 'toggle-theme',
      label: '切换主题',
      hint: '在浅色和深色主题之间切换',
      icon: SunIcon,
      group: 'view',
      action: actions.onToggleTheme,
    },
    {
      id: 'open-settings',
      label: '打开设置',
      hint: '打开设置中心',
      shortcut: '⌘,',
      icon: SettingsIcon,
      group: 'settings',
      action: actions.onOpenSettings,
    },
  ]
}
