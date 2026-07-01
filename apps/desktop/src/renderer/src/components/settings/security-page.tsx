import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { ShieldIcon, ShieldCheckIcon, ShieldAlertIcon, EyeIcon, FolderIcon, PlusIcon, TrashIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { getApi, putApi } from '../../api'
import { ApiClientError } from '../../api'

// ── 类型定义 ──

type GateMode = 'auto' | 'plan' | 'readonly'

interface GateState {
  mode: GateMode
}

// ── 常量 ──

const whitelistStorageKey = 'pi-agent.dir-whitelist'

const modeConfig: Record<GateMode, { label: string; icon: typeof ShieldIcon; desc: string; badge: 'default' | 'secondary' | 'destructive' }> = {
  auto: {
    label: '自动模式',
    icon: ShieldCheckIcon,
    desc: 'Agent 可自动执行所有工具，包括文件写入和命令执行（危险工具仍会触发确认）。',
    badge: 'default',
  },
  plan: {
    label: '计划模式',
    icon: ShieldIcon,
    desc: 'Agent 只能制定计划，不能执行任何修改性操作，需用户确认后才能执行。',
    badge: 'secondary',
  },
  readonly: {
    label: '只读模式',
    icon: ShieldAlertIcon,
    desc: 'Agent 只能读取信息，禁止所有写入和命令执行操作。',
    badge: 'destructive',
  },
}

// ── 主组件 ──

export function SecurityPage(): ReactElement {
  const [mode, setMode] = useState<GateMode>('auto')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

  const [whitelist, setWhitelist] = useState<string[]>(() => loadWhitelist())
  const [newDir, setNewDir] = useState('')

  // 加载当前权限模式
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const data = await getApi<GateState>('/api/gate')
        if (!cancelled) {
          setMode(data.mode)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiClientError ? err.message : '加载权限模式失败')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 持久化白名单
  useEffect(() => {
    saveWhitelist(whitelist)
  }, [whitelist])

  async function handleModeChange(newMode: GateMode): Promise<void> {
    if (newMode === mode || saving) return
    setSaving(true)
    setError(null)
    setSuccessMsg(null)
    try {
      const data = await putApi<GateState>('/api/gate/mode', { mode: newMode })
      setMode(data.mode)
      setSuccessMsg(`权限模式已切换为「${modeConfig[data.mode].label}」`)
      window.setTimeout(() => setSuccessMsg(null), 2500)
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '切换权限模式失败')
    } finally {
      setSaving(false)
    }
  }

  function handleAddDir(): void {
    const trimmed = newDir.trim()
    if (!trimmed) return
    if (whitelist.includes(trimmed)) {
      setNewDir('')
      return
    }
    setWhitelist((prev) => [...prev, trimmed])
    setNewDir('')
  }

  function handleRemoveDir(dir: string): void {
    setWhitelist((prev) => prev.filter((d) => d !== dir))
  }

  return (
    <section className="p-6 grid gap-5" aria-label="权限与安全">
      <div>
        <p className="text-subtle text-xs font-[760] m-0">Security</p>
        <h2 className="text-[22px] font-[780] leading-tight mt-0.5">权限与安全</h2>
      </div>

      {error && (
        <div className="bg-destructive/10 border border-destructive/30 text-destructive rounded-lg p-3 text-sm">
          {error}
        </div>
      )}
      {successMsg && (
        <div className="bg-success/10 border border-success/30 text-success rounded-lg p-3 text-sm">
          {successMsg}
        </div>
      )}

      {/* ── 权限模式 ── */}
      <div className="bg-surface-2 border border-border rounded-lg p-4 grid gap-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ShieldIcon className="size-4 text-muted-foreground" />
            <Label>权限模式</Label>
          </div>
          {loading ? (
            <Badge variant="secondary">加载中...</Badge>
          ) : (
            <Badge variant={modeConfig[mode].badge}>{modeConfig[mode].label}</Badge>
          )}
        </div>

        <div className="grid gap-2">
          {(Object.keys(modeConfig) as GateMode[]).map((m) => {
            const cfg = modeConfig[m]
            const Icon = cfg.icon
            const active = mode === m
            return (
              <button
                key={m}
                type="button"
                onClick={() => handleModeChange(m)}
                disabled={saving || loading}
                className={`flex items-start gap-3 p-3 rounded-lg border text-left transition-colors active:scale-[0.96] ${
                  active
                    ? 'border-accent bg-accent/10'
                    : 'border-border bg-surface-3 hover:bg-surface-3/70'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                <Icon className={`size-4 shrink-0 mt-0.5 ${active ? 'text-accent' : 'text-muted-foreground'}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-[760]">{cfg.label}</div>
                  <p className="text-pretty text-xs text-muted-foreground m-0 mt-0.5 leading-relaxed">{cfg.desc}</p>
                </div>
                {active && (
                  <ShieldCheckIcon className="size-4 text-accent shrink-0 mt-0.5" />
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* ── 目录白名单 ── */}
      <div className="bg-surface-2 border border-border rounded-lg p-4 grid gap-3">
        <div className="flex items-center gap-2">
          <FolderIcon className="size-4 text-muted-foreground" />
          <Label>目录白名单</Label>
        </div>
        <p className="text-xs text-muted-foreground m-0">
          Agent 在自动模式下可在以下目录中执行文件操作（仅本地存储，后端校验即将上线）。
        </p>

        <div className="flex gap-2">
          <Input
            value={newDir}
            onChange={(e) => setNewDir(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleAddDir()
              }
            }}
            placeholder="例如：D:\Projects 或 /home/user/workspace"
            className="flex-1"
          />
          <Button type="button" variant="secondary" size="sm" onClick={handleAddDir} disabled={!newDir.trim()}>
            <PlusIcon className="size-3.5" />
            添加
          </Button>
        </div>

        {whitelist.length === 0 ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground bg-surface-3 rounded-md p-3">
            <EyeIcon className="size-3.5" />
            暂无白名单目录，Agent 将使用默认工作目录
          </div>
        ) : (
          <ul className="grid gap-1.5 m-0 list-none p-0">
            {whitelist.map((dir) => (
              <li
                key={dir}
                className="flex items-center justify-between gap-2 bg-surface-3 rounded-md px-3 py-2"
              >
                <code className="text-xs font-mono text-text truncate min-w-0">{dir}</code>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6 shrink-0"
                  onClick={() => handleRemoveDir(dir)}
                  aria-label={`移除 ${dir}`}
                >
                  <TrashIcon className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

// ── 工具函数 ──

function loadWhitelist(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(whitelistStorageKey)
    if (!raw) return []
    const data = JSON.parse(raw)
    return Array.isArray(data) ? data.filter((d): d is string => typeof d === 'string') : []
  } catch {
    return []
  }
}

function saveWhitelist(dirs: string[]): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(whitelistStorageKey, JSON.stringify(dirs))
}
