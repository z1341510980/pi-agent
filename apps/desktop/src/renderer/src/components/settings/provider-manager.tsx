import type { FormEvent, ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { PlusIcon, EditIcon, TrashIcon, EyeIcon, EyeOffIcon, RefreshCwIcon, CheckCircleIcon, XCircleIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { getAgui } from '../../api'

// ── 类型定义 ──

interface ModelInfo {
  provider: string
  id: string
  name?: string
}

interface ModelsResponse {
  threadId: string
  models: ModelInfo[]
}

interface AguiInfoResponse {
  protocol: string
  version: string
  agents: Array<{ id: string; name: string }>
}

export interface ProviderEntry {
  id: string
  name: string
  api: string
  baseUrl: string
  apiKey: string
  /** 是否为后端已注册（只读，不可编辑/删除） */
  readonly?: boolean
}

type TestState =
  | { state: 'idle' }
  | { state: 'testing' }
  | { state: 'success'; message: string }
  | { state: 'error'; message: string }

// ── 常量 ──

const storageKey = 'pi-agent.providers'

const apiTypes = [
  { value: 'openai-completions', label: 'OpenAI Completions' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'google-generative-ai', label: 'Google Generative AI' },
  { value: 'custom', label: '自定义' }
]

// ── 主组件 ──

export function ProviderManager(): ReactElement {
  const [backendProviders, setBackendProviders] = useState<ProviderEntry[]>([])
  const [backendModelCounts, setBackendModelCounts] = useState<Record<string, number>>({})
  const [localProviders, setLocalProviders] = useState<ProviderEntry[]>(() => loadLocalProviders())
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState<ProviderEntry | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  // 拉取后端已注册的模型，按 provider 分组
  useEffect(() => {
    let cancelled = false
    async function fetchProviders() {
      setLoading(true)
      setLoadError(null)
      try {
        const data = await getAgui<ModelsResponse>(
          '/ag-ui/agent/default/models?threadId=main'
        )
        if (cancelled) return
        const { providers, counts } = groupByProvider(data.models)
        setBackendProviders(providers)
        setBackendModelCounts(counts)
      } catch (err) {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : '加载 Provider 列表失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void fetchProviders()
    return () => {
      cancelled = true
    }
  }, [])

  // 持久化本地 Provider
  useEffect(() => {
    saveLocalProviders(localProviders)
  }, [localProviders])

  function handleAdd(): void {
    setEditing({
      id: '',
      name: '',
      api: 'openai-completions',
      baseUrl: '',
      apiKey: ''
    })
    setDialogOpen(true)
  }

  function handleEdit(provider: ProviderEntry): void {
    setEditing({ ...provider })
    setDialogOpen(true)
  }

  function handleDelete(id: string): void {
    setLocalProviders((prev) => prev.filter((p) => p.id !== id))
  }

  function handleSave(entry: ProviderEntry): void {
    if (entry.id) {
      setLocalProviders((prev) => prev.map((p) => (p.id === entry.id ? entry : p)))
    } else {
      const newEntry = { ...entry, id: crypto.randomUUID() }
      setLocalProviders((prev) => [...prev, newEntry])
    }
    setDialogOpen(false)
    setEditing(null)
  }

  return (
    <section className="p-6" aria-label="Provider 管理">
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-subtle text-xs font-[760] m-0">Provider</p>
          <h2 className="text-[22px] font-[780] leading-tight mt-0.5">Provider 管理</h2>
        </div>
        <Button size="sm" onClick={handleAdd} aria-label="添加 Provider">
          <PlusIcon className="size-3.5" />
          添加 Provider
        </Button>
      </div>

      {loading && (
        <p className="text-muted text-sm" role="status">
          正在加载 Provider 列表...
        </p>
      )}

      {loadError && (
        <p className="text-danger text-sm" role="alert">
          {loadError}
        </p>
      )}

      <div className="grid gap-2.5" aria-label="Provider 列表">
        {backendProviders.map((provider) => (
          <ProviderCard
            key={`backend-${provider.id}`}
            provider={provider}
            modelCount={backendModelCounts[provider.id] ?? 0}
            onEdit={handleEdit}
            onDelete={handleDelete}
          />
        ))}
        {localProviders.map((provider) => (
          <ProviderCard
            key={`local-${provider.id}`}
            provider={provider}
            onEdit={handleEdit}
            onDelete={handleDelete}
          />
        ))}
        {!loading && !loadError && backendProviders.length === 0 && localProviders.length === 0 && (
          <p className="text-muted text-sm">暂无已注册的 Provider，点击右上角"添加 Provider"开始配置。</p>
        )}
      </div>

      {editing && (
        <ProviderFormDialog
          open={dialogOpen}
          entry={editing}
          onOpenChange={(open) => {
            setDialogOpen(open)
            if (!open) setEditing(null)
          }}
          onSave={handleSave}
        />
      )}
    </section>
  )
}

// ── Provider 卡片 ──

interface ProviderCardProps {
  provider: ProviderEntry
  modelCount?: number
  onEdit: (provider: ProviderEntry) => void
  onDelete: (id: string) => void
}

function ProviderCard({ provider, modelCount, onEdit, onDelete }: ProviderCardProps): ReactElement {
  return (
    <div className="bg-surface-2 border border-border rounded-lg p-3 flex items-center gap-3">
      <div className="size-8 rounded-md bg-surface-3 flex items-center justify-center text-sm font-[780] shrink-0">
        {provider.name.charAt(0).toUpperCase() || '?'}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-[760]">{provider.name}</div>
        <div className="text-xs text-muted truncate">
          {provider.api}
          {provider.baseUrl ? ` · ${provider.baseUrl}` : ''}
        </div>
      </div>
      {typeof modelCount === 'number' && modelCount > 0 && (
        <span className="text-xs text-muted whitespace-nowrap">{modelCount} 模型</span>
      )}
      <Badge variant="secondary" className="shrink-0">
        {provider.readonly ? '已注册' : '本地'}
      </Badge>
      {!provider.readonly && (
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`编辑 ${provider.name}`}
            onClick={() => onEdit(provider)}
          >
            <EditIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`删除 ${provider.name}`}
            onClick={() => onDelete(provider.id)}
          >
            <TrashIcon className="size-3.5" />
          </Button>
        </div>
      )}
    </div>
  )
}

// ── 添加/编辑表单弹窗 ──

interface ProviderFormDialogProps {
  open: boolean
  entry: ProviderEntry
  onOpenChange: (open: boolean) => void
  onSave: (entry: ProviderEntry) => void
}

function ProviderFormDialog({ open, entry, onOpenChange, onSave }: ProviderFormDialogProps): ReactElement {
  const [form, setForm] = useState<ProviderEntry>(entry)
  const [showKey, setShowKey] = useState(false)
  const [testState, setTestState] = useState<TestState>({ state: 'idle' })

  // 当 entry 变化时重置表单
  useEffect(() => {
    setForm(entry)
    setTestState({ state: 'idle' })
    setShowKey(false)
  }, [entry])

  function updateField(field: keyof ProviderEntry, value: string): void {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  async function handleTestConnection(): Promise<void> {
    setTestState({ state: 'testing' })
    try {
      const info = await getAgui<AguiInfoResponse>('/ag-ui/info')
      setTestState({
        state: 'success',
        message: `连通性验证通过，协议 ${info.protocol} v${info.version}`
      })
    } catch (err) {
      setTestState({
        state: 'error',
        message: err instanceof Error ? err.message : '连接失败'
      })
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    onSave(form)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{form.id ? '编辑 Provider' : '添加 Provider'}</DialogTitle>
        </DialogHeader>
        <form className="grid gap-3.5" onSubmit={handleSubmit}>
          <div className="grid gap-1.5">
            <Label htmlFor="provider-name">名称</Label>
            <Input
              id="provider-name"
              value={form.name}
              onChange={(e) => updateField('name', e.target.value)}
              placeholder="OpenAI"
              required
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="provider-api">API 类型</Label>
            <Select
              value={form.api}
              onValueChange={(value) => updateField('api', value)}
            >
              <SelectTrigger id="provider-api" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {apiTypes.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="provider-baseurl">Base URL</Label>
            <Input
              id="provider-baseurl"
              value={form.baseUrl}
              onChange={(e) => updateField('baseUrl', e.target.value)}
              placeholder="https://api.openai.com/v1"
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="provider-apikey">API Key</Label>
            <div className="flex gap-2">
              <Input
                id="provider-apikey"
                type={showKey ? 'text' : 'password'}
                value={form.apiKey}
                onChange={(e) => updateField('apiKey', e.target.value)}
                placeholder="sk-..."
                className="flex-1 font-mono"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
                onClick={() => setShowKey((v) => !v)}
              >
                {showKey ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void handleTestConnection()}
                disabled={testState.state === 'testing'}
              >
                <RefreshCwIcon className={`size-3.5 ${testState.state === 'testing' ? 'animate-spin' : ''}`} />
                测试
              </Button>
            </div>
            {testState.state === 'success' && (
              <p className="text-xs text-success flex items-center gap-1.5" role="status">
                <CheckCircleIcon className="size-3.5" />
                {testState.message}
              </p>
            )}
            {testState.state === 'error' && (
              <p className="text-xs text-danger flex items-center gap-1.5" role="alert">
                <XCircleIcon className="size-3.5" />
                {testState.message}
              </p>
            )}
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">取消</Button>
            </DialogClose>
            <Button type="submit">保存</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── 工具函数 ──

function groupByProvider(models: ModelInfo[]): {
  providers: ProviderEntry[]
  counts: Record<string, number>
} {
  const counts: Record<string, number> = {}
  const map = new Map<string, ProviderEntry>()
  for (const model of models) {
    const providerId = model.provider || 'unknown'
    counts[providerId] = (counts[providerId] ?? 0) + 1
    if (!map.has(providerId)) {
      map.set(providerId, {
        id: providerId,
        name: providerId,
        api: '—',
        baseUrl: '',
        apiKey: '',
        readonly: true
      })
    }
  }
  return { providers: Array.from(map.values()), counts }
}

function loadLocalProviders(): ProviderEntry[] {
  if (typeof window === 'undefined') return []
  const raw = window.localStorage.getItem(storageKey)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as ProviderEntry[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveLocalProviders(providers: ProviderEntry[]): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(storageKey, JSON.stringify(providers))
}
