import { useState } from 'react'
import { Popover } from 'radix-ui'
import { Wrench, Cpu, Hash } from 'lucide-react'
import type { PresetAssistant } from '@/config/preset-assistants'
import { AgentLogoIcon } from './agent-logo-icon'

export interface AgentDetailCardProps {
  /** 当前 Agent 信息 */
  assistant: PresetAssistant
  /** 触发器节点（一般为 AgentLogoIcon） */
  children: React.ReactNode
}

/**
 * AgentDetailCard：Hover AgentLogoIcon 时显示的气泡详情卡片
 *
 * 借鉴 AionUi 的气泡卡片样式：
 *   - name + description
 *   - 当前模型 / 工具数 / Agent ID
 *   - radix Popover 实现，hover 触发
 */
export function AgentDetailCard({ assistant, children }: AgentDetailCardProps) {
  const [open, setOpen] = useState(false)

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <span
          className="inline-flex cursor-default"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
        >
          {children}
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          align="start"
          side="bottom"
          className="z-50 w-64 rounded-lg bg-popover p-3 text-popover-foreground shadow-lg ring-1 ring-foreground/10 animate-in fade-in-0 zoom-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-95 pointer-events-none outline-none"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {/* 顶部：logo + name */}
          <div className="flex items-center gap-2 mb-2">
            <AgentLogoIcon
              agentId={assistant.agentId}
              agentName={assistant.name}
              icon={assistant.icon}
              size="md"
              className="shrink-0"
            />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-text truncate">
                {assistant.name}
              </div>
              <div className="text-[11px] text-hint truncate">
                {assistant.source === 'builtin'
                  ? '内置'
                  : assistant.source === 'plugin'
                    ? '插件'
                    : '自定义'}
              </div>
            </div>
          </div>

          {/* 描述 */}
          {assistant.description && (
            <p className="text-xs text-text-secondary leading-relaxed mb-2.5">
              {assistant.description}
            </p>
          )}

          {/* 元信息 */}
          <div className="space-y-1 text-[11px] text-hint">
            {assistant.defaultModel && (
              <div className="flex items-center gap-1.5">
                <Cpu className="size-3 shrink-0" />
                <span className="truncate">
                  {assistant.defaultModel.provider}/{assistant.defaultModel.modelId}
                </span>
              </div>
            )}
            {assistant.tools && assistant.tools.length > 0 && (
              <div className="flex items-center gap-1.5">
                <Wrench className="size-3 shrink-0" />
                <span>{assistant.tools.length} 个工具</span>
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <Hash className="size-3 shrink-0" />
              <span className="truncate">{assistant.agentId}</span>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
