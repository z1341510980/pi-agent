import { type ReactElement } from 'react'
import { DropdownMenu } from 'radix-ui'
import { ChevronDown, Cloud, Users, Bot } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useRuntimeStore } from '@/stores/runtime-store'
import { ALL_RUNTIMES } from '@/utils/agent/runtime-registry'
import { RUNTIME_LABELS } from '@/utils/agent/runtime-types'
import { cn } from '@/lib/utils'

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Cloud,
  Users,
  Bot,
}

interface RuntimeSelectorPillProps {
  compact?: boolean
  className?: string
}

/**
 * RuntimeSelectorPill：Runtime 类型选择胶囊
 *
 * 显示当前 Runtime（图标 + 标签），点击展开所有 Runtime 选项。
 * 用于在 ModelSelector 旁边快速切换执行后端。
 */
export function RuntimeSelectorPill({
  compact = false,
  className,
}: RuntimeSelectorPillProps): ReactElement {
  const runtime = useRuntimeStore((s) => s.runtime)
  const setRuntime = useRuntimeStore((s) => s.setRuntime)
  const meta = RUNTIME_LABELS[runtime]
  const Icon = ICONS[meta.icon] ?? Cloud

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn('h-7 gap-1 rounded-full px-2 text-xs', className)}
        >
          <Icon className="h-3.5 w-3.5" />
          {!compact && <span className="max-w-[100px] truncate">{meta.label}</span>}
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-56 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 animate-in fade-in-0 zoom-in-95"
        >
          <DropdownMenu.Label className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
            Runtime
          </DropdownMenu.Label>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          {ALL_RUNTIMES.map((r) => {
            const ItemIcon = ICONS[r.icon] ?? Cloud
            const selected = runtime === r.type
            return (
              <DropdownMenu.Item
                key={r.type}
                onSelect={() => setRuntime(r.type)}
                className={cn(
                  'flex cursor-default items-start gap-2 rounded px-2 py-1.5 text-sm outline-none select-none hover:bg-accent hover:text-accent-foreground',
                  selected && 'bg-accent',
                )}
              >
                <ItemIcon className="mt-0.5 h-4 w-4" />
                <div className="flex flex-col">
                  <span className="text-sm">{r.label}</span>
                  <span className="text-xs text-muted-foreground">{r.description}</span>
                </div>
              </DropdownMenu.Item>
            )
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
