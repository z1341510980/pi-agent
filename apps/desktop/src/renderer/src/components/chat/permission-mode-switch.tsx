import { useState, useCallback, useRef, useEffect } from 'react'
import type { ReactElement } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { ShieldIcon, ShieldCheckIcon, ShieldAlertIcon, ShieldOffIcon, ChevronDownIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getApi, putApi } from '../../api'

/** 权限模式（与后端 Gate 保持一致） */
export type PermissionMode = 'auto' | 'plan' | 'readonly' | 'full'

interface GateData {
  mode: PermissionMode
}

interface PermissionModeSwitchProps {
  /** 紧凑模式（用于输入栏） */
  compact?: boolean
  /** 自定义样式类名 */
  className?: string
}

const MODE_META: Record<PermissionMode, {
  label: string
  hint: string
  badge?: 'default' | 'secondary' | 'destructive' | 'outline'
  icon: typeof ShieldIcon
  color: string
}> = {
  auto: {
    label: 'Auto',
    hint: '读自动，危险操作弹确认',
    badge: 'default',
    icon: ShieldCheckIcon,
    color: 'text-emerald-500',
  },
  plan: {
    label: 'Plan',
    hint: '写/危险操作先确认',
    badge: 'secondary',
    icon: ShieldIcon,
    color: 'text-amber-500',
  },
  readonly: {
    label: 'Read-only',
    hint: '禁止所有写操作和 shell',
    badge: 'destructive',
    icon: ShieldAlertIcon,
    color: 'text-destructive',
  },
  full: {
    label: 'Full',
    hint: '完全控制，所有操作自动执行',
    badge: 'outline',
    icon: ShieldOffIcon,
    color: 'text-red-600',
  },
}

const MODE_ORDER: PermissionMode[] = ['auto', 'plan', 'readonly', 'full']

export function PermissionModeSwitch({ compact = false, className }: PermissionModeSwitchProps): ReactElement {
  const queryClient = useQueryClient()
  const [optimisticMode, setOptimisticMode] = useState<PermissionMode | null>(null)
  const [fullControlConfirmOpen, setFullControlConfirmOpen] = useState(false)
  const [pendingMode, setPendingMode] = useState<PermissionMode | null>(null)

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
      setOptimisticMode(null)
      queryClient.invalidateQueries({ queryKey: ['gate'] })
    },
    onSettled: () => {
      setOptimisticMode(null)
    },
  })

  const applyMode = useCallback((mode: PermissionMode) => {
    if (mode === 'full' && currentMode !== 'full') {
      setPendingMode(mode)
      setFullControlConfirmOpen(true)
      return
    }
    updateMutation.mutate(mode)
  }, [currentMode, updateMutation])

  const handleFullControlConfirm = useCallback(() => {
    setFullControlConfirmOpen(false)
    if (pendingMode) {
      updateMutation.mutate(pendingMode)
      setPendingMode(null)
    }
  }, [pendingMode, updateMutation])

  const handleFullControlCancel = useCallback(() => {
    setFullControlConfirmOpen(false)
    setPendingMode(null)
  }, [])

  const cycleMode = (): void => {
    const idx = MODE_ORDER.indexOf(currentMode)
    const next = MODE_ORDER[(idx + 1) % MODE_ORDER.length]
    applyMode(next)
  }

  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭下拉
  useEffect(() => {
    if (!dropdownOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [dropdownOpen])

  const handleSelect = useCallback((mode: PermissionMode) => {
    setDropdownOpen(false)
    applyMode(mode)
  }, [applyMode])

  const meta = MODE_META[currentMode]
  const Icon = meta.icon

  if (compact) {
    return (
      <>
        <div ref={dropdownRef} className="relative">
          <button
            type="button"
            onClick={() => setDropdownOpen((v) => !v)}
            disabled={updateMutation.isPending || gateQuery.isLoading}
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-1.5 py-1',
              'bg-transparent border border-border cursor-pointer',
              'hover:bg-surface-3 disabled:opacity-50 disabled:cursor-not-allowed',
              'transition-colors text-[12px]!',
              className,
            )}
          >
            <Icon className={cn('size-3', meta.color)} />
            <span className="text-text">{meta.label}</span>
            <ChevronDownIcon className="size-3 text-muted-foreground" />
          </button>

          {dropdownOpen && (
            <div className="absolute bottom-full mb-1 right-0 z-50 min-w-[180px] rounded-md border border-border bg-popover p-1 shadow-md">
              {MODE_ORDER.map((mode) => {
                const m = MODE_META[mode]
                const MIcon = m.icon
                const active = mode === currentMode
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => handleSelect(mode)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs transition-colors',
                      'hover:bg-accent text-left',
                      active && 'bg-accent/50',
                    )}
                  >
                    <MIcon className={cn('size-3.5 shrink-0', m.color)} />
                    <div className="flex flex-col min-w-0">
                      <span className={cn('font-medium', active ? 'text-text' : 'text-text-secondary')}>{m.label}</span>
                      <span className="text-[10px] text-muted-foreground truncate">{m.hint}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* 完全控制风险确认弹窗 */}
        <Dialog open={fullControlConfirmOpen} onOpenChange={(open) => { if (!open) handleFullControlCancel() }}>
          <DialogContent showCloseButton={false} className="sm:max-w-md">
            <DialogHeader>
              <div className="flex items-center gap-2.5">
                <ShieldOffIcon className="size-5 text-red-600" />
                <DialogTitle className="text-base">完全控制模式</DialogTitle>
              </div>
              <DialogDescription className="text-sm">
                你正在切换到完全控制模式，请确认你了解以下风险。
              </DialogDescription>
            </DialogHeader>
            <Alert variant="destructive" className="py-2.5">
              <AlertTitle className="text-sm">风险警告</AlertTitle>
              <AlertDescription className="text-xs leading-relaxed">
                完全控制模式下，Agent 执行的所有操作（包括运行 shell 命令、写入/删除文件、网络请求等）将自动执行，<strong>不再弹出确认对话框</strong>。这可能导致不可逆的数据变更或系统操作。请仅在可信环境中使用此模式。
              </AlertDescription>
            </Alert>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="outline" size="sm" onClick={handleFullControlCancel}>取消</Button>
              <Button variant="destructive" size="sm" onClick={handleFullControlConfirm}>
                我了解风险，启用完全控制
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    )
  }

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">权限模式</span>
        <Badge variant={meta.badge}>{meta.label}</Badge>
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {MODE_ORDER.map((mode) => {
          const m = MODE_META[mode]
          const active = mode === currentMode
          const MIcon = m.icon
          return (
            <Button
              key={mode}
              variant={active ? 'default' : 'outline'}
              size="sm"
              onClick={() => applyMode(mode)}
              disabled={updateMutation.isPending}
              className={cn('flex-col h-auto py-1.5 gap-0.5', mode === 'full' && !active && 'border-red-300 text-red-600 hover:bg-red-50')}
            >
              <MIcon className="size-3" />
              <span className="text-[10px]">{m.label}</span>
            </Button>
          )
        })}
      </div>
      <p className="text-xs text-muted-foreground leading-snug m-0">{meta.hint}</p>

      {/* 完全控制风险确认弹窗 */}
      <Dialog open={fullControlConfirmOpen} onOpenChange={(open) => { if (!open) handleFullControlCancel() }}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-2.5">
              <ShieldOffIcon className="size-5 text-red-600" />
              <DialogTitle className="text-base">完全控制模式</DialogTitle>
            </div>
            <DialogDescription className="text-sm">
              你正在切换到完全控制模式，请确认你了解以下风险。
            </DialogDescription>
          </DialogHeader>
          <Alert variant="destructive" className="py-2.5">
            <AlertTitle className="text-sm">风险警告</AlertTitle>
            <AlertDescription className="text-xs leading-relaxed">
              完全控制模式下，Agent 执行的所有操作将自动执行，<strong>不再弹出确认对话框</strong>。这可能导致不可逆的数据变更。请仅在可信环境中使用。
            </AlertDescription>
          </Alert>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" size="sm" onClick={handleFullControlCancel}>取消</Button>
            <Button variant="destructive" size="sm" onClick={handleFullControlConfirm}>
              我了解风险，启用完全控制
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
