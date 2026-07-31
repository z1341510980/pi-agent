import {
  useState,
  useMemo,
  useRef,
  useEffect,
  useCallback,
  useDeferredValue,
  type ReactElement,
  type ReactNode
} from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  CornerDownLeft,
  FileText,
  Zap,
  Command as CommandIcon,
  Hash,
  Clock,
  Search,
  Sparkles
} from 'lucide-react'
import { getApi } from '../../api/http-client'
import { cn } from '@/lib/utils'

// ── 类型定义 ──

interface SkillInfo {
  name: string
  description: string
  path: string
}

/** 命令分组 */
type CommandGroup = 'recent' | 'command' | 'skill'

interface SlashCommand {
  id: string
  /** 展示用 label（保留原始大小写） */
  label: string
  /** 用于匹配/高亮/排序的规范化名称（小写） */
  name: string
  hint: string
  icon: typeof FileText
  group: CommandGroup
  insertText: string
}

interface SlashCommandPanelProps {
  /** 搜索关键词（不含前导 /） */
  query: string
  /** 选择指令回调，返回插入文本 */
  onSelect: (insertText: string) => void
  /** 关闭面板回调 */
  onClose: () => void
}

// ── 固定命令 ──

const FIXED_COMMANDS: SlashCommand[] = [
  {
    id: 'cmd-spec',
    label: 'Spec',
    name: 'spec',
    hint: '根据需求细化完整的规范、任务、验收文档',
    icon: FileText,
    group: 'command',
    insertText: '/spec '
  },
  {
    id: 'cmd-plan',
    label: 'Plan',
    name: 'plan',
    hint: '优先规划任务的执行方向',
    icon: FileText,
    group: 'command',
    insertText: '/plan '
  }
]

// ── 历史记录（localStorage 持久化） ──

const HISTORY_KEY = 'pi-agent.slash-commands.history'
const HISTORY_MAX = 8
const RECENT_DISPLAY_LIMIT = 5
const SEARCH_RESULT_LIMIT = 20

interface HistoryRecord {
  id: string
  useCount: number
  lastUsedAt: number
}

type HistoryMap = Record<string, HistoryRecord>

function loadHistory(): HistoryMap {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY)
    if (!raw) return {}
    const data = JSON.parse(raw)
    if (data && typeof data === 'object') return data as HistoryMap
    return {}
  } catch {
    return {}
  }
}

function saveHistory(map: HistoryMap): void {
  if (typeof window === 'undefined') return
  try {
    const entries = Object.values(map)
    entries.sort((a, b) => {
      if (b.useCount !== a.useCount) return b.useCount - a.useCount
      return b.lastUsedAt - a.lastUsedAt
    })
    const top: HistoryMap = {}
    for (const rec of entries.slice(0, HISTORY_MAX * 2)) {
      top[rec.id] = rec
    }
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(top))
  } catch {
    // 忽略存储失败
  }
}

function recordUsage(id: string): HistoryMap {
  const map = loadHistory()
  const now = Date.now()
  const existing = map[id]
  map[id] = existing
    ? { id, useCount: existing.useCount + 1, lastUsedAt: now }
    : { id, useCount: 1, lastUsedAt: now }
  saveHistory(map)
  return map
}

// ── 匹配 + 高亮算法 ──

/**
 * 子序列 fuzzy 匹配（比 AionUi 的 indexOf 更宽容）
 * 返回匹配字符的下标数组；不匹配返回 null
 */
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

/** 子串匹配（用于加分项） */
function containsMatch(value: string, keyword: string): number {
  return value.toLowerCase().indexOf(keyword.toLowerCase())
}

/** 计算匹配得分：前缀 > 词首 > 包含 > 子序列 */
function computeMatchScore(
  cmd: SlashCommand,
  keyword: string
): {
  indices: number[] | null
  score: number
} {
  const k = keyword.trim().toLowerCase()
  if (!k) return { indices: [], score: 0 }

  // 1. 前缀匹配（最高分）
  if (cmd.name.startsWith(k)) {
    const indices = Array.from({ length: k.length }, (_, i) => i)
    return { indices, score: 1000 + k.length * 10 }
  }

  // 2. 子串匹配（中分）
  const subIdx = containsMatch(cmd.name, k)
  if (subIdx >= 0) {
    const indices = Array.from({ length: k.length }, (_, i) => subIdx + i)
    return { indices, score: 500 + k.length * 5 }
  }

  // 3. 子序列匹配（低分）
  const fuzzyIndices = fuzzyMatchIndices(cmd.name, k)
  if (fuzzyIndices) {
    return { indices: fuzzyIndices, score: 100 + fuzzyIndices.length }
  }

  // 4. hint 中包含（最低分）
  if (cmd.hint.toLowerCase().includes(k)) {
    return { indices: null, score: 10 }
  }

  return { indices: null, score: -1 }
}

/** 将文本按高亮索引切分为 segments */
function splitHighlight(
  text: string,
  indices: number[] | undefined
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

// ── 分组配置 ──

const GROUP_CONFIG: Record<CommandGroup, { label: string; icon: typeof Hash }> = {
  recent: { label: '最近使用', icon: Clock },
  command: { label: '命令', icon: CommandIcon },
  skill: { label: '技能', icon: Hash }
}

const GROUP_ORDER: CommandGroup[] = ['recent', 'command', 'skill']

// ── 相对时间格式 ──

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return `${Math.floor(diff / (7 * 86_400_000))} 周前`
}

// ── 主组件 ──

export function SlashCommandPanel({
  query,
  onSelect,
  onClose
}: SlashCommandPanelProps): ReactElement | null {
  const [activeIndex, setActiveIndex] = useState(0)
  /** 鼠标 hover 索引（与 activeIndex 解耦，避免抢夺键盘选中） */
  const [hoverIndex, setHoverIndex] = useState<number>(-1)
  const [historyVersion, setHistoryVersion] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  /** 用户最后操作来源（keyboard / mouse），决定视觉优先级 */
  const lastInputSource = useRef<'keyboard' | 'mouse'>('keyboard')

  // 用 deferred value 防抖过滤，避免快输入时主线程卡顿
  const deferredQuery = useDeferredValue(query)

  // 从后端获取技能列表
  const skillsQuery = useQuery({
    queryKey: ['skills'],
    queryFn: () => getApi<SkillInfo[]>('/api/skills'),
    staleTime: 60_000
  })

  // 加载历史记录（historyVersion 变化时重新读取）
  const history = useMemo<HistoryMap>(() => loadHistory(), [historyVersion])

  // 合并固定命令 + 动态技能（去重，按 id）
  const allCommands = useMemo<SlashCommand[]>(() => {
    const seen = new Set<string>()
    const result: SlashCommand[] = []
    for (const cmd of FIXED_COMMANDS) {
      if (!seen.has(cmd.id)) {
        seen.add(cmd.id)
        result.push(cmd)
      }
    }
    for (const skill of skillsQuery.data ?? []) {
      const id = `skill-${skill.name}`
      if (!seen.has(id)) {
        seen.add(id)
        result.push({
          id,
          label: skill.name,
          name: skill.name.toLowerCase(),
          hint: skill.description,
          icon: Zap,
          group: 'skill',
          insertText: `/${skill.name} `
        })
      }
    }
    return result
  }, [skillsQuery.data])

  // 空查询时：最近使用排序（按 useCount + lastUsedAt）
  const recentCommands = useMemo<SlashCommand[]>(() => {
    if (deferredQuery.trim()) return []
    return allCommands
      .map((cmd) => ({ cmd, rec: history[cmd.id] }))
      .filter((x): x is { cmd: SlashCommand; rec: HistoryRecord } => Boolean(x.rec))
      .sort((a, b) => {
        if (b.rec.useCount !== a.rec.useCount) {
          return b.rec.useCount - a.rec.useCount
        }
        return b.rec.lastUsedAt - a.rec.lastUsedAt
      })
      .slice(0, RECENT_DISPLAY_LIMIT)
      .map((x) => ({
        ...x.cmd,
        group: 'recent' as const,
        _useCount: x.rec.useCount,
        _lastUsedAt: x.rec.lastUsedAt
      }))
  }, [allCommands, history, deferredQuery])

  // 有查询时：匹配 + 打分 + 排序 + 限制
  const searchResults = useMemo<Array<{ cmd: SlashCommand; indices: number[] | null }>>(() => {
    const q = deferredQuery.trim().toLowerCase()
    if (!q) return []
    return allCommands
      .map((cmd) => {
        const { indices, score } = computeMatchScore(cmd, q)
        if (score < 0) return null
        return { cmd, indices, score }
      })
      .filter(
        (x): x is { cmd: SlashCommand; indices: number[] | null; score: number } => x !== null
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, SEARCH_RESULT_LIMIT)
      .map(({ cmd, indices }) => ({ cmd, indices }))
  }, [allCommands, deferredQuery])

  // 最终展示：空查询时 recent + 命令 + 技能；有查询时 searchResults
  const displayCommands = useMemo<Array<{ cmd: SlashCommand; indices: number[] | null }>>(() => {
    if (deferredQuery.trim()) {
      return searchResults
    }
    // 空查询：先 recent，再命令/技能（去重）
    const recentIds = new Set(recentCommands.map((c) => c.id))
    const others = allCommands
      .filter((c) => !recentIds.has(c.id))
      .map((cmd) => ({ cmd, indices: null }))
    return [...recentCommands.map((cmd) => ({ cmd, indices: null })), ...others]
  }, [deferredQuery, searchResults, recentCommands, allCommands])

  // 分组（保持 GROUP_ORDER 顺序，空分组不渲染）
  const grouped = useMemo(() => {
    const groups = new Map<CommandGroup, Array<{ cmd: SlashCommand; indices: number[] | null }>>()
    for (const item of displayCommands) {
      const arr = groups.get(item.cmd.group) ?? []
      arr.push(item)
      groups.set(item.cmd.group, arr)
    }
    return GROUP_ORDER.filter((g) => groups.has(g) && groups.get(g)!.length > 0).map((g) => ({
      group: g,
      items: groups.get(g)!
    }))
  }, [displayCommands])

  // 扁平化用于 activeIndex 索引
  const flatList = useMemo(
    () => grouped.flatMap((g) => g.items.map((item) => ({ ...item.cmd, _indices: item.indices }))),
    [grouped]
  )

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

  // 选中处理：记录使用 + 回调
  const handleSelect = useCallback(
    (cmd: SlashCommand) => {
      recordUsage(cmd.id)
      setHistoryVersion((v) => v + 1)
      onSelect(cmd.insertText)
    },
    [onSelect]
  )

  // 键盘导航
  useEffect(() => {
    function handleKeyDown(e: globalThis.KeyboardEvent): void {
      const active = document.activeElement as HTMLElement | null
      if (active?.id !== 'message-input') return

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        lastInputSource.current = 'keyboard'
        setHoverIndex(-1)
        setActiveIndex((i) => (i + 1) % Math.max(flatList.length, 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        lastInputSource.current = 'keyboard'
        setHoverIndex(-1)
        setActiveIndex((i) => (i - 1 + flatList.length) % Math.max(flatList.length, 1))
      } else if (e.key === 'Enter' && !e.shiftKey) {
        const cmd = flatList[activeIndex]
        if (cmd) {
          e.preventDefault()
          e.stopPropagation()
          handleSelect(cmd)
        }
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [flatList, activeIndex, handleSelect, onClose])

  // 渲染带高亮的 label
  const renderLabel = (cmd: SlashCommand, indices: number[] | undefined): ReactNode => {
    // label 前面加 / 前缀，所以高亮索引需要 +1
    const adjustedIndices = indices ? indices.map((i) => i + 1) : undefined
    const segments = splitHighlight(`/${cmd.label}`, adjustedIndices)
    return segments.map((seg, i) =>
      seg.highlighted ? (
        <mark key={i} className="bg-primary/20 text-primary rounded-[2px] px-0.5 font-semibold">
          {seg.text}
        </mark>
      ) : (
        <span key={i}>{seg.text}</span>
      )
    )
  }

  // 空状态
  if (flatList.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-popover shadow-[0_20px_60px_-15px_rgba(0,0,0,0.25),0_8px_24px_-8px_rgba(0,0,0,0.12)] overflow-hidden">
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
          <Search className="size-6 text-muted-foreground/40" aria-hidden="true" />
          <div className="text-sm text-muted-foreground">没有匹配的指令</div>
          {query && (
            <div className="text-xs text-muted-foreground/70">
              未找到包含「{query}」的命令或技能
            </div>
          )}
        </div>
      </div>
    )
  }

  let runningIdx = -1
  const isSearching = deferredQuery.trim().length > 0

  return (
    <div
      className="rounded-2xl border border-border bg-popover/95 backdrop-blur-md shadow-[0_20px_60px_-15px_rgba(0,0,0,0.25),0_8px_24px_-8px_rgba(0,0,0,0.12)] overflow-hidden"
      role="listbox"
      aria-label="指令面板"
      aria-activedescendant={`slash-item-${activeIndex}`}
    >
      {/* 顶部：标题栏 */}
      <div className="flex items-center justify-between gap-2 px-3.5 h-9 border-b border-border/60 bg-surface-2/40">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <CommandIcon className="size-3" aria-hidden="true" />
          <span>命令面板</span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px]">
          {isSearching ? (
            <span className="text-muted-foreground">
              筛选: <span className="text-text font-medium">{deferredQuery}</span>
            </span>
          ) : (
            <span className="text-muted-foreground/70 flex items-center gap-1">
              <Sparkles className="size-2.5" aria-hidden="true" />
              输入以筛选
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
        {grouped.map(({ group, items }) => {
          const GroupIcon = GROUP_CONFIG[group]?.icon ?? Hash
          const groupLabel = GROUP_CONFIG[group]?.label ?? group
          return (
            <div key={group} className="mb-1.5 last:mb-0">
              <div className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-semibold text-muted-foreground/80 uppercase tracking-wider">
                <GroupIcon className="size-2.5" aria-hidden="true" />
                {groupLabel}
                <span className="text-muted-foreground/50 font-normal normal-case tracking-normal">
                  · {items.length}
                </span>
              </div>
              {items.map(({ cmd, indices }) => {
                runningIdx += 1
                const idx = runningIdx
                const active = idx === activeIndex
                const hovered = idx === hoverIndex
                // 视觉优先级：键盘 active > 鼠标 hover
                const isHighlighted = active || (hovered && lastInputSource.current === 'mouse')
                const Icon = cmd.icon
                return (
                  <button
                    key={cmd.id}
                    id={`slash-item-${idx}`}
                    type="button"
                    data-idx={idx}
                    role="option"
                    aria-selected={active}
                    // 用 onMouseMove 而非 mouseenter，避免快速滑动时抢夺键盘
                    onMouseMove={() => {
                      if (hoverIndex !== idx) {
                        lastInputSource.current = 'mouse'
                        setHoverIndex(idx)
                      }
                    }}
                    // 用 onMouseDown + preventDefault 防止 textarea 失焦
                    onMouseDown={(e) => {
                      e.preventDefault()
                      handleSelect(cmd)
                    }}
                    className={cn(
                      'relative w-full flex items-center gap-2.5 pl-3 pr-2 py-2 rounded-lg text-left transition-colors active:scale-[0.99]',
                      isHighlighted ? 'bg-primary/8 text-text' : 'text-text hover:bg-surface-2/40'
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
                        active ? 'bg-primary/15 text-primary' : 'bg-surface-3 text-muted-foreground'
                      )}
                    >
                      <Icon className="size-3.5" aria-hidden="true" />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">
                        {renderLabel(cmd, indices ?? undefined)}
                      </div>
                      <div className="text-[11px] text-muted-foreground truncate leading-tight mt-0.5">
                        {cmd.hint}
                      </div>
                    </div>
                    {/* 右侧：使用次数徽章（仅 recent）/ 选中提示 */}
                    {group === 'recent' &&
                      (cmd as SlashCommand & { _useCount?: number })._useCount && (
                        <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-surface-3 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground tabular-nums">
                          <Clock className="size-2.5" aria-hidden="true" />
                          {(cmd as SlashCommand & { _useCount?: number; _lastUsedAt?: number })
                            ._lastUsedAt
                            ? formatRelativeTime(
                                (cmd as SlashCommand & { _lastUsedAt?: number })._lastUsedAt!
                              )
                            : ''}
                        </span>
                      )}
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
        <span className="tabular-nums">
          {activeIndex + 1} / {flatList.length}
        </span>
      </div>
    </div>
  )
}
