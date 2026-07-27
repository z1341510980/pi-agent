import { type ReactElement, useEffect, useState } from 'react'
import { DropdownMenu } from 'radix-ui'
import { Check, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useRuntimeStore } from '@/stores/runtime-store'
import { getRuntime } from '@/utils/agent/runtime-registry'
import type { RuntimeModel, RuntimeModelGroup } from '@/types/runtime'
import { cn } from '@/lib/utils'

interface RuntimeSelectorMenuProps {
  className?: string
}

function isGrouped(g: RuntimeModel[] | RuntimeModelGroup[]): g is RuntimeModelGroup[] {
  return Array.isArray(g) && g.length > 0 && 'models' in g[0]
}

function getCurrentLabel(
  runtime: string,
  modelId: string | undefined,
  teamId: string | undefined,
  groups: RuntimeModel[] | RuntimeModelGroup[],
): string {
  if (runtime === 'team') {
    const list = groups as RuntimeModel[]
    return list.find((m) => m.id === teamId)?.label ?? '选择 Team'
  }
  const flat = isGrouped(groups)
    ? (groups as RuntimeModelGroup[]).flatMap((g) => g.models)
    : (groups as RuntimeModel[])
  return flat.find((m) => m.id === modelId)?.label ?? '选择模型'
}

/**
 * RuntimeSelectorMenu：Runtime 模型/Team 选择菜单
 *
 * 根据当前 Runtime 类型，从对应 Runtime 拉取可选项列表：
 * - chat-api：按 Provider 分组展示模型
 * - team：平铺展示 Team 列表
 * - agent-plugin：平铺展示插件 Agent 列表
 */
export function RuntimeSelectorMenu({ className }: RuntimeSelectorMenuProps): ReactElement {
  const runtime = useRuntimeStore((s) => s.runtime)
  const modelId = useRuntimeStore((s) => s.modelId)
  const teamId = useRuntimeStore((s) => s.teamId)
  const setModel = useRuntimeStore((s) => s.setModel)
  const setTeam = useRuntimeStore((s) => s.setTeam)

  const [groups, setGroups] = useState<RuntimeModel[] | RuntimeModelGroup[]>([])

  useEffect(() => {
    const rt = getRuntime(runtime)
    if (!rt) {
      setGroups([])
      return
    }
    let cancelled = false
    rt.listModels()
      .then((data) => {
        if (!cancelled) setGroups(data)
      })
      .catch(() => {
        if (!cancelled) setGroups([])
      })
    return () => {
      cancelled = true
    }
  }, [runtime])

  const currentLabel = getCurrentLabel(runtime, modelId, teamId, groups)
  const isTeam = runtime === 'team'

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="sm" className={cn('h-7 gap-1 text-xs', className)}>
          <span className="max-w-[160px] truncate">{currentLabel}</span>
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 max-h-64 min-w-72 overflow-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 animate-in fade-in-0 zoom-in-95"
        >
          <DropdownMenu.Label className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
            {isTeam ? '选择 Team' : '选择模型 / Agent'}
          </DropdownMenu.Label>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />

          {groups.length === 0 && (
            <div className="px-2 py-4 text-center text-xs text-muted-foreground">
              暂无可用选项
            </div>
          )}

          {isTeam &&
            (groups as RuntimeModel[]).map((m) => (
              <DropdownMenu.Item
                key={m.id}
                onSelect={() => setTeam(m.id)}
                className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 text-sm outline-none select-none hover:bg-accent hover:text-accent-foreground"
              >
                {teamId === m.id ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <span className="h-4 w-4" />
                )}
                <div className="flex flex-col">
                  <span className="text-sm">{m.label ?? m.id}</span>
                  {m.description && (
                    <span className="text-xs text-muted-foreground">{m.description}</span>
                  )}
                </div>
              </DropdownMenu.Item>
            ))}

          {!isTeam &&
            isGrouped(groups) &&
            groups.map((g) => (
              <DropdownMenu.Group key={g.key}>
                <DropdownMenu.Label className="px-2 py-1 text-xs font-medium text-muted-foreground">
                  {g.title}
                </DropdownMenu.Label>
                {g.models.map((m) => (
                  <DropdownMenu.Item
                    key={m.id}
                    onSelect={() => setModel(m.id)}
                    className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 text-sm outline-none select-none hover:bg-accent hover:text-accent-foreground"
                  >
                    {modelId === m.id ? (
                      <Check className="h-4 w-4" />
                    ) : (
                      <span className="h-4 w-4" />
                    )}
                    <div className="flex flex-col">
                      <span className="text-sm">{m.label ?? m.id}</span>
                      {m.description && (
                        <span className="text-xs text-muted-foreground">{m.description}</span>
                      )}
                    </div>
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Group>
            ))}

          {!isTeam &&
            !isGrouped(groups) &&
            (groups as RuntimeModel[]).map((m) => (
              <DropdownMenu.Item
                key={m.id}
                onSelect={() => setModel(m.id)}
                className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 text-sm outline-none select-none hover:bg-accent hover:text-accent-foreground"
              >
                {modelId === m.id ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <span className="h-4 w-4" />
                )}
                <span className="text-sm">{m.label ?? m.id}</span>
              </DropdownMenu.Item>
            ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
