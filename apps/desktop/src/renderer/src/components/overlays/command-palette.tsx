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
  Trash2Icon,
  PanelLeftIcon,
  PanelRightIcon,
  TerminalIcon,
  PaletteIcon,
  SlidersHorizontalIcon,
  UserCogIcon,
  PlugIcon,
  SparklesIcon,
  InfoIcon,
  EraserIcon,
} from 'lucide-react'
import type { PresetAssistant } from '@/config/preset-assistants'
import type { SessionSummary } from '@/components/chat/session-list'

// ── 类型定义 ──

export type CommandGroup = 'recent' | 'session' | 'agent' | 'settings' | 'view' | 'tools'

export interface Command {
  id: string
  label: string
  hint?: string
  shortcut?: string
  icon: typeof SearchIcon
  group: CommandGroup
  action: () => void
}

interface CommandPaletteProps {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  commands: Command[]
}

// ── 最近使用命令追踪（模块级，持久化到 localStorage）──

const RECENT_STORAGE_KEY = 'pi-agent.command-palette.recent'
const RECENT_LIMIT = 5

function readRecentIds(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string').slice(0, RECENT_LIMIT)
  } catch {
    return []
  }
}

function writeRecentIds(ids: string[]): void {
  try {
    window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // 隐私模式 / 配额满，静默失败
  }
}

/**
 * 记录一次命令执行，将其 ID 置于最近使用列表顶部（去重）。
 */
export function recordRecentCommand(id: string): void {
  if (!id) return
  const prev = readRecentIds().filter((x) => x !== id)
  const next = [id, ...prev].slice(0, RECENT_LIMIT)
  writeRecentIds(next)
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

  // 过滤命令（简单 includes 模糊匹配）
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

  // 执行命令：记录到最近使用，触发 action，关闭 palette
  function runCommand(cmd: Command | undefined): void {
    if (!cmd) return
    recordRecentCommand(cmd.id)
    cmd.action()
    onOpenChange(false)
  }

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
      runCommand(filtered[activeIndex])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onOpenChange(false)
    }
  }

  if (!isOpen) return null

  // 按组分类（recent 仅在无搜索词时显示，避免重复干扰）
  const grouped = useMemo(() => {
    const map = new Map<CommandGroup, Command[]>()
    if (!query.trim()) {
      // 无搜索词：在最前面插入"最近使用"分组
      const recentIds = readRecentIds()
      if (recentIds.length > 0) {
        const recentCmds: Command[] = []
        for (const id of recentIds) {
          const cmd = commands.find((c) => c.id === id)
          if (cmd) recentCmds.push(cmd)
        }
        if (recentCmds.length > 0) {
          map.set('recent', recentCmds)
        }
      }
    }
    for (const cmd of filtered) {
      const arr = map.get(cmd.group) ?? []
      arr.push(cmd)
      map.set(cmd.group, arr)
    }
    return Array.from(map.entries())
  }, [filtered, commands, query])

  // 组标签
  const groupLabels: Record<CommandGroup, string> = {
    recent: '最近使用',
    session: '会话',
    agent: 'Agent',
    settings: '设置',
    view: '视图',
    tools: '工具',
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
          {filtered.length === 0 && grouped.length === 0 ? (
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
                      key={`${group}-${cmd.id}-${idx}`}
                      type="button"
                      data-idx={idx}
                      onMouseEnter={() => setActiveIndex(idx)}
                      onClick={() => runCommand(cmd)}
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

/**
 * createDefaultCommands 入参：所有可触发的 action handlers。
 * 新增字段均为可选，保持向后兼容。
 */
export interface DefaultCommandsActions {
  // ── 会话操作 ──
  onNewSession: () => void
  /** 删除当前会话（由调用方实现确认逻辑） */
  onDeleteCurrentSession?: () => void
  /** 切换到指定会话（用于置顶会话快捷切换） */
  onSwitchToSession?: (threadId: string) => void

  // ── Agent 切换 ──
  /** 切换到指定 Agent */
  onSwitchAgent?: (agentId: string) => void

  // ── 视图控制 ──
  onToggleLeftPanel?: () => void
  onToggleRightPanel?: () => void
  onToggleDevLog?: () => void
  /** 切换主题面板（占位） */
  onOpenThemePanel?: () => void
  /** 兼容旧接口：切换主题 */
  onToggleTheme?: () => void
  /** 兼容旧接口：切换右栏到上下文 */
  onSwitchMode?: () => void
  /** 兼容旧接口：切换右栏到上下文（用于模型选择） */
  onSwitchModel?: () => void
  /** 兼容旧接口：查看用量 */
  onViewUsage?: () => void

  // ── 设置 ──
  /** 打开设置中心（通用入口） */
  onOpenSettings?: () => void
  onOpenGeneralSettings?: () => void
  onOpenAssistantSettings?: () => void
  onOpenProviderSettings?: () => void
  onOpenSkillSettings?: () => void
  onOpenAbout?: () => void

  // ── 工具 ──
  /** 手动压缩上下文 */
  onCompact?: () => void
  /** 清空当前会话消息（由调用方实现确认逻辑） */
  onClearMessages?: () => void
}

/**
 * createDefaultCommands 选项。
 */
export interface CreateDefaultCommandsOptions {
  /** 所有可用助手列表（来自 useActiveAgent 的 allAssistants） */
  allAssistants?: PresetAssistant[]
  /** 置顶会话列表（用于快捷切换） */
  pinnedSessions?: SessionSummary[]
}

/**
 * 生成默认命令列表。
 *
 * 新增命令分类：
 * - 会话：新建 / 切换到置顶 / 删除当前（带确认）
 * - Agent：列出所有可用 Agent，选中后切换
 * - 视图：切换左/右栏 / DevLog / 主题面板（占位）
 * - 设置：通用 / 助手 / Provider / 技能 / 关于
 * - 工具：手动压缩 / 清空当前会话消息（带确认）
 *
 * 保留原有命令以维持向后兼容。
 */
export function createDefaultCommands(
  actions: DefaultCommandsActions,
  options: CreateDefaultCommandsOptions = {},
): Command[] {
  const commands: Command[] = []

  // ── 会话操作 ──
  commands.push({
    id: 'new-session',
    label: '新建会话',
    hint: '创建一个新的对话会话',
    shortcut: '⌘N',
    icon: PlusIcon,
    group: 'session',
    action: actions.onNewSession,
  })

  if (actions.onDeleteCurrentSession) {
    commands.push({
      id: 'delete-current-session',
      label: '删除当前会话',
      hint: '删除后无法恢复，需确认',
      icon: Trash2Icon,
      group: 'session',
      action: actions.onDeleteCurrentSession,
    })
  }

  // 置顶会话快捷切换（最多展示前 5 个）
  if (actions.onSwitchToSession && options.pinnedSessions?.length) {
    options.pinnedSessions.slice(0, 5).forEach((s, idx) => {
      commands.push({
        id: `switch-pinned-${s.id}`,
        label: `切换到置顶会话 #${idx + 1}`,
        hint: s.title,
        icon: PlusIcon,
        group: 'session',
        action: () => actions.onSwitchToSession?.(s.id),
      })
    })
  }

  // ── Agent 切换（列出所有可用 Agent）──
  if (actions.onSwitchAgent && options.allAssistants?.length) {
    for (const a of options.allAssistants) {
      commands.push({
        id: `switch-agent-${a.agentId}`,
        label: `切换到 Agent：${a.name}`,
        hint: a.description,
        icon: BotIcon,
        group: 'agent',
        action: () => actions.onSwitchAgent?.(a.agentId),
      })
    }
  }

  // 兼容旧命令：切换模型 / 切换权限模式
  if (actions.onSwitchModel) {
    commands.push({
      id: 'switch-model',
      label: '切换模型',
      hint: '选择当前会话使用的 LLM 模型',
      icon: BotIcon,
      group: 'agent',
      action: actions.onSwitchModel,
    })
  }

  if (actions.onSwitchMode) {
    commands.push({
      id: 'switch-mode',
      label: '切换权限模式',
      hint: 'Auto / Plan / Read-only',
      icon: ShieldIcon,
      group: 'agent',
      action: actions.onSwitchMode,
    })
  }

  // ── 视图控制 ──
  if (actions.onToggleLeftPanel) {
    commands.push({
      id: 'toggle-left-panel',
      label: '切换左侧栏',
      hint: '显示/隐藏会话列表',
      shortcut: '⌘\\',
      icon: PanelLeftIcon,
      group: 'view',
      action: actions.onToggleLeftPanel,
    })
  }

  if (actions.onToggleRightPanel) {
    commands.push({
      id: 'toggle-right-panel',
      label: '切换右侧栏',
      hint: '显示/隐藏上下文/记忆/用量面板',
      shortcut: '⌘⇧\\',
      icon: PanelRightIcon,
      group: 'view',
      action: actions.onToggleRightPanel,
    })
  }

  if (actions.onToggleDevLog) {
    commands.push({
      id: 'toggle-devlog',
      label: '切换 DevLog 面板',
      hint: '显示/隐藏开发者日志',
      shortcut: '⌘D',
      icon: TerminalIcon,
      group: 'view',
      action: actions.onToggleDevLog,
    })
  }

  if (actions.onOpenThemePanel) {
    commands.push({
      id: 'open-theme-panel',
      label: '切换主题面板',
      hint: '占位：后续接入主题选择器',
      icon: PaletteIcon,
      group: 'view',
      action: actions.onOpenThemePanel,
    })
  }

  // 兼容旧命令：查看用量 / 切换主题
  if (actions.onViewUsage) {
    commands.push({
      id: 'view-usage',
      label: '查看用量',
      hint: '打开用量面板查看成本统计',
      icon: GaugeIcon,
      group: 'view',
      action: actions.onViewUsage,
    })
  }

  if (actions.onToggleTheme) {
    commands.push({
      id: 'toggle-theme',
      label: '切换主题',
      hint: '在浅色和深色主题之间切换',
      icon: SunIcon,
      group: 'view',
      action: actions.onToggleTheme,
    })
  }

  // ── 设置 ──
  if (actions.onOpenGeneralSettings ?? actions.onOpenSettings) {
    commands.push({
      id: 'open-general-settings',
      label: '打开通用设置',
      hint: '语言、字体、自动保存等',
      shortcut: '⌘,',
      icon: SlidersHorizontalIcon,
      group: 'settings',
      action: actions.onOpenGeneralSettings ?? actions.onOpenSettings ?? (() => {}),
    })
  }

  if (actions.onOpenAssistantSettings) {
    commands.push({
      id: 'open-assistant-settings',
      label: '打开助手设置',
      hint: '管理内置与自定义助手',
      icon: UserCogIcon,
      group: 'settings',
      action: actions.onOpenAssistantSettings,
    })
  }

  if (actions.onOpenProviderSettings) {
    commands.push({
      id: 'open-provider-settings',
      label: '打开 Provider 设置',
      hint: '配置模型供应商与 API Key',
      icon: PlugIcon,
      group: 'settings',
      action: actions.onOpenProviderSettings,
    })
  }

  if (actions.onOpenSkillSettings) {
    commands.push({
      id: 'open-skill-settings',
      label: '打开技能设置',
      hint: '管理记忆、检索、工具技能',
      icon: SparklesIcon,
      group: 'settings',
      action: actions.onOpenSkillSettings,
    })
  }

  if (actions.onOpenAbout) {
    commands.push({
      id: 'open-about',
      label: '关于',
      hint: '版本、协议、致谢',
      icon: InfoIcon,
      group: 'settings',
      action: actions.onOpenAbout,
    })
  }

  // 兼容旧命令：打开设置（无具体分类）
  if (actions.onOpenSettings && !actions.onOpenGeneralSettings) {
    commands.push({
      id: 'open-settings',
      label: '打开设置',
      hint: '打开设置中心',
      shortcut: '⌘,',
      icon: SettingsIcon,
      group: 'settings',
      action: actions.onOpenSettings,
    })
  }

  // ── 工具 ──
  if (actions.onCompact) {
    commands.push({
      id: 'compact',
      label: '手动压缩当前会话',
      hint: '压缩上下文以释放 token 空间',
      icon: ArchiveIcon,
      group: 'tools',
      action: actions.onCompact,
    })
  }

  if (actions.onClearMessages) {
    commands.push({
      id: 'clear-messages',
      label: '清空当前会话消息',
      hint: '删除当前会话所有消息（需确认）',
      icon: EraserIcon,
      group: 'tools',
      action: actions.onClearMessages,
    })
  }

  return commands
}
