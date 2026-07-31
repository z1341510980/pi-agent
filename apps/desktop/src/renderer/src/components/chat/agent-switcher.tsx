import { useMemo, useState } from 'react'
import { DropdownMenu } from 'radix-ui'
import { Check, Plus, Sparkles, Wrench } from 'lucide-react'
import { useActiveAgent } from '@/hooks/use-active-agent'
import { useSessionStore } from '@/stores/session-store'
import { AgentLogoIcon } from './agent-logo-icon'
import { cn } from '@/lib/utils'
import type { PresetAssistant } from '@/config/preset-assistants'

export interface AgentSwitcherProps {
  /** 打开 Agent 设置页 */
  onManageAgents?: () => void
  /** 紧凑模式：仅渲染 logo 图标，作为 ChatTitleEditor 的 leading */
  compact?: boolean
}

/**
 * AgentSwitcher：点击 AgentLogoIcon 触发的下拉切换器
 *
 * 借鉴 AionUi：
 *   - 默认模式：触发器是 logo + name 文本
 *   - compact 模式：触发器仅 logo 图标（用作 ChatTitleEditor leading）
 *   - 下拉分组：内置 / 自定义 / 插件
 *   - 选中后切换 activeAgentId
 *   - 底部"管理 Agent"入口跳转设置页
 */
export function AgentSwitcher({ onManageAgents, compact = false }: AgentSwitcherProps) {
  const { assistant: active, allAssistants } = useActiveAgent()
  const setActiveAgentId = useSessionStore((s) => s.setActiveAgentId)
  const [filter, setFilter] = useState('')

  // 过滤
  const filteredAssistants = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return allAssistants
    return allAssistants.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.description?.toLowerCase().includes(q) ||
        a.agentId.toLowerCase().includes(q),
    )
  }, [allAssistants, filter])

  // 分组
  const groups = useMemo(() => {
    const builtin: PresetAssistant[] = []
    const custom: PresetAssistant[] = []
    const plugin: PresetAssistant[] = []
    for (const a of filteredAssistants) {
      if (a.source === 'builtin') builtin.push(a)
      else if (a.source === 'plugin') plugin.push(a)
      else custom.push(a)
    }
    return [
      { label: '内置', items: builtin },
      { label: '自定义', items: custom },
      { label: '插件', items: plugin },
    ].filter((g) => g.items.length > 0)
  }, [filteredAssistants])

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={cn(
            'group flex items-center gap-1.5 rounded-md transition-colors [webkit-app-region:no-drag]',
            compact
              ? 'p-0 hover:bg-transparent'
              : 'px-1.5 py-1 -mx-1.5 -my-1 hover:bg-surface-3',
          )}
          aria-label="切换 Agent"
          title={compact ? `Agent: ${active.name}` : undefined}
        >
          <AgentLogoIcon
            agentId={active.agentId}
            agentName={active.name}
            icon={active.icon}
            size="sm"
            className="shrink-0"
          />
          {!compact && (
            <span className="text-xs font-medium text-text-secondary truncate max-w-[120px]">
              {active.name}
            </span>
          )}
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="z-50 w-72 rounded-lg bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10 animate-in fade-in-0 zoom-in-95"
          side="bottom"
          align="start"
          sideOffset={6}
        >
          {/* 搜索框 */}
          <div className="px-2 py-1.5 border-b border-border/60">
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="搜索 Agent…"
              className="w-full h-7 rounded-md bg-transparent px-2 text-xs text-text outline-none placeholder:text-hint"
              aria-label="搜索 Agent"
            />
          </div>

          {/* 分组列表 */}
          <div className="max-h-[320px] overflow-y-auto py-1">
            {groups.length === 0 ? (
              <div className="px-3 py-4 text-xs text-hint text-center">
                没有匹配的 Agent
              </div>
            ) : (
              groups.map((group) => (
                <div key={group.label} className="mb-1">
                  <div className="px-2 py-1 text-[11px] font-medium text-hint">
                    {group.label}
                  </div>
                  {group.items.map((a) => (
                    <DropdownMenu.Item
                      key={a.id}
                      className={cn(
                        'flex items-center gap-2 rounded px-2 py-1.5 text-xs outline-none cursor-pointer select-none',
                        'hover:bg-accent hover:text-accent-foreground',
                      )}
                      onSelect={() => setActiveAgentId(a.agentId)}
                    >
                      <AgentLogoIcon
                        agentId={a.agentId}
                        agentName={a.name}
                        icon={a.icon}
                        size="sm"
                        className="shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="truncate font-medium text-text">{a.name}</div>
                        {a.description && (
                          <div className="truncate text-[11px] text-hint">{a.description}</div>
                        )}
                      </div>
                      {a.id === active.id && (
                        <Check className="size-3.5 shrink-0 text-primary" />
                      )}
                    </DropdownMenu.Item>
                  ))}
                </div>
              ))
            )}
          </div>

          {/* 底部：管理 Agent */}
          <div className="border-t border-border/60 p-1">
            <DropdownMenu.Item
              className="flex items-center gap-2 rounded px-2 py-1.5 text-xs outline-none cursor-pointer hover:bg-accent hover:text-accent-foreground"
              onSelect={() => onManageAgents?.()}
            >
              <Plus className="size-3.5" />
              管理 Agent
            </DropdownMenu.Item>
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

// 重新导出常用图标，便于在 Header 等处统一使用
export { Sparkles, Wrench }
