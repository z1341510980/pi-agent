import { useEffect, useState, type ReactElement } from 'react'
import { LayersIcon, RefreshCwIcon, CpuIcon, DollarSignIcon, BrainIcon, PlusIcon, Trash2Icon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { getApi } from '../../api'
import { ApiClientError } from '../../api'

// ── 类型定义 ──

interface ModelConfig {
  id: string
  name: string
  reasoning?: boolean
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  contextWindow?: number
  maxTokens?: number
}

interface ProviderEntry {
  id: string
  name: string
  baseUrl: string
  api: string
  authHeader?: boolean
  models: ModelConfig[]
}

/** 自定义模型（本地存储） */
interface CustomModel {
  id: string
  provider: string
  modelId: string
  name: string
  contextWindow?: number
  maxTokens?: number
  createdAt: number
}

// ── 常量 ──

const CUSTOM_MODELS_STORAGE_KEY = 'pi-agent.custom-models'

// ── 主组件 ──

export function ModelsPage(): ReactElement {
  const [providers, setProviders] = useState<ProviderEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [customModels, setCustomModels] = useState<CustomModel[]>(() => loadCustomModels())
  const [showAddForm, setShowAddForm] = useState(false)

  async function loadProviders(): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      const data = await getApi<ProviderEntry[]>('/api/providers')
      setProviders(data)
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '加载模型列表失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadProviders()
  }, [])

  const totalModels =
    providers.reduce((sum, p) => sum + p.models.length, 0) + customModels.length

  // 添加自定义模型
  function handleAddCustom(model: CustomModel): void {
    setCustomModels((prev) => {
      const next = [...prev, model]
      saveCustomModels(next)
      return next
    })
    setShowAddForm(false)
  }

  // 删除自定义模型
  function handleDeleteCustom(id: string): void {
    setCustomModels((prev) => {
      const next = prev.filter((m) => m.id !== id)
      saveCustomModels(next)
      return next
    })
  }

  return (
    <section className="p-6 grid gap-5" aria-label="模型管理">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-subtle text-xs font-[760] m-0">Models</p>
          <h2 className="text-[22px] font-[780] leading-tight mt-0.5">模型管理</h2>
          <p className="text-xs text-muted-foreground m-0 mt-1">
            共 {providers.length} 个 Provider，{totalModels} 个模型（含 {customModels.length} 个自定义）
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowAddForm(true)}>
            <PlusIcon className="size-3.5" />
            添加自定义模型
          </Button>
          <Button variant="outline" size="sm" onClick={() => void loadProviders()} disabled={loading}>
            <RefreshCwIcon className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </Button>
        </div>
      </div>

      {error && (
        <div className="bg-destructive/10 border border-destructive/30 text-destructive rounded-lg p-3 text-sm">
          {error}
        </div>
      )}

      {/* ── 自定义模型区 ── */}
      {customModels.length > 0 && (
        <div className="bg-surface-2 border border-border rounded-lg p-4 grid gap-3">
          <div className="flex items-center gap-2">
            <LayersIcon className="size-4 text-muted-foreground" />
            <span className="text-sm font-[780]">自定义模型</span>
            <Badge variant="secondary">{customModels.length}</Badge>
          </div>
          <div className="grid gap-1.5">
            {customModels.map((model) => (
              <div
                key={model.id}
                className="flex items-center justify-between gap-3 bg-surface-3 rounded-md px-3 py-2"
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className="text-sm font-[760] truncate">{model.name}</span>
                  <Badge variant="outline" className="shrink-0">
                    {model.provider}:{model.modelId}
                  </Badge>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                  {model.contextWindow && (
                    <span className="tabular-nums" title="上下文窗口">{formatTokens(model.contextWindow)} ctx</span>
                  )}
                  {model.maxTokens && (
                    <span className="tabular-nums" title="最大输出">{formatTokens(model.maxTokens)} out</span>
                  )}
                  <button
                    className="relative rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors before:absolute before:-inset-[10px] before:content-[''] active:scale-[0.96] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={() => handleDeleteCustom(model.id)}
                    aria-label={`删除自定义模型 ${model.name}`}
                  >
                    <Trash2Icon className="size-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── 添加自定义模型表单 ── */}
      {showAddForm && (
        <AddCustomModelForm
          onSubmit={handleAddCustom}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {loading ? (
        <div className="bg-surface-2 border border-border rounded-lg p-8 text-center text-sm text-muted-foreground">
          加载中...
        </div>
      ) : providers.length === 0 && customModels.length === 0 ? (
        <div className="bg-surface-2 border border-border rounded-lg p-8 grid gap-2 text-center">
          <LayersIcon className="size-8 text-muted-foreground mx-auto" />
          <p className="text-sm font-[760] m-0">暂无已注册模型</p>
          <p className="text-xs text-muted-foreground m-0">请先在「Provider 管理」中添加 Provider 并拉取模型，或添加自定义模型</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {providers.map((provider) => (
            <div
              key={provider.id}
              className="bg-surface-2 border border-border rounded-lg p-4 grid gap-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <CpuIcon className="size-4 text-muted-foreground shrink-0" />
                  <span className="text-sm font-[780] truncate">{provider.name}</span>
                  <Badge variant="secondary">{provider.models.length} 模型</Badge>
                </div>
                <code className="text-xs font-mono text-muted-foreground truncate">{provider.id}</code>
              </div>

              <div className="grid gap-1.5">
                {provider.models.map((model) => (
                  <div
                    key={model.id}
                    className="flex items-center justify-between gap-3 bg-surface-3 rounded-md px-3 py-2"
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className="text-sm font-[760] truncate">{model.name}</span>
                      {model.reasoning && (
                        <Badge variant="outline" className="shrink-0">
                          <BrainIcon className="size-3 mr-1" />
                          推理
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                      {model.contextWindow && (
                        <span className="tabular-nums" title="上下文窗口">
                          {formatTokens(model.contextWindow)} ctx
                        </span>
                      )}
                      {model.maxTokens && (
                        <span title="最大输出">
                          {formatTokens(model.maxTokens)} out
                        </span>
                      )}
                      {model.cost && (model.cost.input > 0 || model.cost.output > 0) && (
                        <span title="成本（每百万 token）" className="flex items-center gap-0.5">
                          <DollarSignIcon className="size-3" />
                          {formatCost(model.cost.input)}/{formatCost(model.cost.output)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

// ── 添加自定义模型表单 ──

interface AddCustomModelFormProps {
  onSubmit: (model: CustomModel) => void
  onCancel: () => void
}

function AddCustomModelForm({ onSubmit, onCancel }: AddCustomModelFormProps): ReactElement {
  const [provider, setProvider] = useState('')
  const [modelId, setModelId] = useState('')
  const [name, setName] = useState('')
  const [contextWindow, setContextWindow] = useState('')
  const [maxTokens, setMaxTokens] = useState('')

  const canSubmit = provider.trim() && modelId.trim() && name.trim()

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault()
    if (!canSubmit) return
    onSubmit({
      id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      provider: provider.trim(),
      modelId: modelId.trim(),
      name: name.trim(),
      contextWindow: contextWindow ? Number(contextWindow) : undefined,
      maxTokens: maxTokens ? Number(maxTokens) : undefined,
      createdAt: Date.now(),
    })
  }

  return (
    <form
      className="bg-surface-2 border border-border rounded-lg p-4 grid gap-3"
      onSubmit={handleSubmit}
      aria-label="添加自定义模型"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-[780]">添加自定义模型</span>
        <button
          type="button"
          className="relative rounded p-1 text-muted-foreground hover:bg-surface-3 before:absolute before:-inset-[10px] before:content-[''] active:scale-[0.96] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={onCancel}
          aria-label="取消"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="custom-provider" className="text-xs">Provider *</Label>
          <input
            id="custom-provider"
            type="text"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            placeholder="openai / anthropic / ..."
            className="bg-surface-3 border border-border rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent/60"
            required
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="custom-model-id" className="text-xs">Model ID *</Label>
          <input
            id="custom-model-id"
            type="text"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            placeholder="gpt-4o / claude-3-5-sonnet / ..."
            className="bg-surface-3 border border-border rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent/60"
            required
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="custom-name" className="text-xs">显示名称 *</Label>
          <input
            id="custom-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="GPT-4o"
            className="bg-surface-3 border border-border rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent/60"
            required
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="custom-ctx" className="text-xs">上下文窗口（可选）</Label>
          <input
            id="custom-ctx"
            type="number"
            value={contextWindow}
            onChange={(e) => setContextWindow(e.target.value)}
            placeholder="128000"
            min="0"
            className="bg-surface-3 border border-border rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent/60"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="custom-max-tokens" className="text-xs">最大输出（可选）</Label>
          <input
            id="custom-max-tokens"
            type="number"
            value={maxTokens}
            onChange={(e) => setMaxTokens(e.target.value)}
            placeholder="8192"
            min="0"
            className="bg-surface-3 border border-border rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent/60"
          />
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" size="sm" disabled={!canSubmit}>
          <PlusIcon className="size-3.5" />
          添加
        </Button>
      </div>
    </form>
  )
}

// ── 工具函数 ──

function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}K`
  }
  return String(tokens)
}

function formatCost(cost: number): string {
  if (cost === 0) return '0'
  if (cost < 0.01) return cost.toFixed(3)
  return cost.toFixed(2)
}

// ── 自定义模型本地存储 ──

function loadCustomModels(): CustomModel[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(CUSTOM_MODELS_STORAGE_KEY)
    if (!raw) return []
    const data = JSON.parse(raw)
    if (!Array.isArray(data)) return []
    return data.filter((m): m is CustomModel =>
      m && typeof m.id === 'string' && typeof m.provider === 'string' && typeof m.modelId === 'string' && typeof m.name === 'string'
    )
  } catch {
    return []
  }
}

function saveCustomModels(models: CustomModel[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(CUSTOM_MODELS_STORAGE_KEY, JSON.stringify(models))
  } catch {
    // 忽略存储失败
  }
}
