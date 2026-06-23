import { useState } from 'react'
import type { ReactElement } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { getApi, putApi } from '../../api'

/** 权限模式（与后端 Gate 保持一致） */
export type PermissionMode = 'auto' | 'plan' | 'readonly'

interface GateData {
  mode: PermissionMode
}

interface PermissionModeSwitchProps {
  /** 紧凑模式（用于状态栏） */
  compact?: boolean
  /** 自定义 badge 样式类名（紧凑模式下生效） */
  badgeClassName?: string
}

const MODE_META: Record<PermissionMode, { label: string; hint: string; badge?: 'default' | 'secondary' | 'destructive' }> = {
  auto: {
    label: 'Auto',
    hint: '读自动，危险操作弹确认',
    badge: 'default',
  },
  plan: {
    label: 'Plan',
    hint: '写/危险操作先确认',
    badge: 'secondary',
  },
  readonly: {
    label: 'Read-only',
    hint: '禁止所有写操作和 shell',
    badge: 'destructive',
  },
}

const MODE_ORDER: PermissionMode[] = ['auto', 'plan', 'readonly']

export function PermissionModeSwitch({ compact = false, badgeClassName }: PermissionModeSwitchProps): ReactElement {
  const queryClient = useQueryClient()
  const [optimisticMode, setOptimisticMode] = useState<PermissionMode | null>(null)

  const gateQuery = useQuery({
    queryKey: ['gate'],
    queryFn: () => getApi<GateData>('/api/gate'),
    refetchInterval: 15_000,
  })

  const currentMode = optimisticMode ?? gateQuery.data?.mode ?? 'auto'

  const updateMutation = useMutation({
    mutationFn: (mode: PermissionMode) => putApi<GateData>('/api/gate/mode', { mode }),
    onMutate: async (mode) => {
      setOptimisticMode(mode)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gate'] })
    },
    onError: () => {
      // 回滚乐观更新
      setOptimisticMode(null)
      queryClient.invalidateQueries({ queryKey: ['gate'] })
    },
    onSettled: () => {
      setOptimisticMode(null)
    },
  })

  const cycleMode = (): void => {
    const idx = MODE_ORDER.indexOf(currentMode)
    const next = MODE_ORDER[(idx + 1) % MODE_ORDER.length]
    updateMutation.mutate(next)
  }

  const meta = MODE_META[currentMode]

  if (compact) {
    return (
      <button
        type="button"
        onClick={cycleMode}
        disabled={updateMutation.isPending || gateQuery.isLoading}
        className="inline-flex items-center gap-1.5 bg-transparent border-0 text-muted-foreground text-xs cursor-pointer hover:text-text disabled:opacity-50 disabled:cursor-not-allowed"
        title={meta.hint}
      >
        {meta.badge && (
          <Badge variant={meta.badge} className={cn('h-4 px-1.5 text-[10px]', badgeClassName)}>
            {currentMode === 'auto' ? 'Auto 模式' : meta.label}
          </Badge>
        )}
      </button>
    )
  }

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <span className="text-subtle text-xs font-[760]">权限模式</span>
        {meta.badge && (
          <Badge variant={meta.badge}>{meta.label}</Badge>
        )}
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {MODE_ORDER.map((mode) => {
          const m = MODE_META[mode]
          const active = mode === currentMode
          return (
            <Button
              key={mode}
              variant={active ? 'default' : 'outline'}
              size="sm"
              onClick={() => updateMutation.mutate(mode)}
              disabled={updateMutation.isPending}
              className="flex-col h-auto py-1.5 gap-0.5"
            >
              <span className="text-xs font-[760]">{m.label}</span>
            </Button>
          )
        })}
      </div>
      <p className="text-muted-foreground text-xs leading-snug m-0">{meta.hint}</p>
    </div>
  )
}
