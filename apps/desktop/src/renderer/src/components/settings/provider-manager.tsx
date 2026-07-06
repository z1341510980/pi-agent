import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
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
import { getApi, postApi, deleteApi, getAgui } from '../../api'

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

export interface ModelConfig {
  id: string
  name: string
  reasoning?: boolean
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  contextWindow?: number
  maxTokens?: number
}

export interface ProviderEntry {
  /** 添加时可能未生成 id，落库前由调用方用 `id || name` 推导 */
  id?: string
  name: string
  api: string
  baseUrl: string
  apiKey: string
  authHeader?: boolean
  models: ModelConfig[]
  /** 是否已注册到后端 */
  registered?: boolean
}

/** 后端 GET /api/providers 返回项（不含 apiKey） */
interface BackendProvider {
  id: string
  name: string
  baseUrl: string
  api: string
  authHeader?: boolean
  models: ModelConfig[]
}

type TestState =
  | { state: 'idle' }
  | { state: 'testing' }
  | { state: 'success'; message: string }
  | { state: 'error'; message: string }

// ── Zod 校验 schema ──

const providerIdSchema = z
  .string()
  .min(1, 'Provider ID 不能为空')
  .max(64, 'Provider ID 不能超过 64 个字符')
  .regex(/^[a-z0-9-]+$/, 'Provider ID 只能包含小写字母、数字和连字符')

const providerNameSchema = z
  .string()
  .min(1, '名称不能为空')
  .max(100, '名称不能超过 100 个字符')

const apiBaseUrlSchema = z
  .string()
  .refine(
    (val) => val === '' || /^https?:\/\/.+/.test(val),
    '请输入有效的 URL（以 http:// 或 https:// 开头）'
  )

const apiKeySchema = z
  .string()
  .refine(
    (val) => val === '' || val.length >= 10,
    'API Key 至少需要 10 个字符'
  )

const modelSchema = z.object({
  id: z.string().min(1, '模型 ID 不能为空'),
  name: z.string().min(1, '模型名称不能为空'),
  reasoning: z.boolean().optional(),
  cost: z
    .object({
      input: z.number(),
      output: z.number(),
      cacheRead: z.number().optional(),
      cacheWrite: z.number().optional(),
    })
    .optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
})

const providerFormSchema = z.object({
  id: z.string().optional(), // 添加时自动从名称生成
  name: providerNameSchema,
  api: z.string().min(1, 'API 类型不能为空'),
  baseUrl: apiBaseUrlSchema,
  apiKey: apiKeySchema,
  authHeader: z.boolean().optional(),
  models: z.array(modelSchema).min(1, '请至少添加一个模型'),
  registered: z.boolean().optional(),
})

type ProviderFormValues = z.infer<typeof providerFormSchema>

// ── 常量 ──

const storageKey = 'pi-agent.providers'

const apiTypes = [
  { value: 'openai-completions', label: 'OpenAI Completions' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'google-generative-ai', label: 'Google Generative AI' },
  { value: 'custom', label: '自定义' }
]

export const presetOptions = [
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'custom', label: '自定义' },
]

export const providerPresets: Record<string, { baseUrl: string; api: string; models: ModelConfig[] }> = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    api: 'openai-completions',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek V3 Chat', cost: { input: 0.27, output: 1.1 }, contextWindow: 65536, maxTokens: 8192 },
      { id: 'deepseek-reasoner', name: 'DeepSeek R1 Reasoner', reasoning: true, cost: { input: 0.55, output: 2.19 }, contextWindow: 65536, maxTokens: 8192 },
    ],
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    api: 'openai-completions',
    models: [
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', cost: { input: 0.4, output: 1.6 }, contextWindow: 1047576, maxTokens: 32768 },
      { id: 'gpt-4.1', name: 'GPT-4.1', cost: { input: 2, output: 8 }, contextWindow: 1047576, maxTokens: 32768 },
    ],
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    api: 'anthropic-messages',
    models: [
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', cost: { input: 3, output: 15 }, contextWindow: 200000, maxTokens: 16000 },
    ],
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    api: 'google-generative-ai',
    models: [
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', cost: { input: 0.1, output: 0.4 }, contextWindow: 1048576, maxTokens: 8192 },
    ],
  },
}

// ── 主组件 ──

export function ProviderManager(): ReactElement {
  const queryClient = useQueryClient()
  const [backendProviders, setBackendProviders] = useState<ProviderEntry[]>([])
  const [localProviders, setLocalProviders] = useState<ProviderEntry[]>(() => loadLocalProviders())
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState<ProviderEntry | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  const localById = new Map(localProviders.map((p) => [p.id, p]))
  const backendIds = new Set(backendProviders.map((p) => p.id))

  // 合并后的 backend providers（带 local apiKey）
  const mergedBackendProviders = backendProviders.map((p) => ({
    ...p,
    apiKey: localById.get(p.id)?.apiKey ?? p.apiKey,
  }))

  // 仅本地的 providers（未注册到后端）
  const localOnlyProviders = localProviders.filter((p) => !backendIds.has(p.id))

  // 拉取后端已注册的 Provider
  useEffect(() => {
    void refreshBackendProviders()
  }, [])

  // 持久化本地 Provider
  useEffect(() => {
    saveLocalProviders(localProviders)
  }, [localProviders])

  async function refreshBackendProviders(): Promise<void> {
    setLoading(true)
    setLoadError(null)
    try {
      const data = await getApi<BackendProvider[]>('/api/providers')
      setBackendProviders(
        data.map((p) => ({
          ...p,
          apiKey: '',
          models: p.models ?? [],
          registered: true,
        }))
      )
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '加载 Provider 列表失败')
    } finally {
      setLoading(false)
    }
  }

  function handleAdd(): void {
    setEditing({
      id: '',
      name: '',
      api: 'openai-completions',
      baseUrl: '',
      apiKey: '',
      models: [],
    })
    setDialogOpen(true)
  }

  function handleEdit(provider: ProviderEntry): void {
    setEditing({ ...provider })
    setDialogOpen(true)
  }

  async function handleDelete(id: string): Promise<void> {
    const isRegistered = backendProviders.some((p) => p.id === id)
    if (isRegistered) {
      try {
        await deleteApi(`/api/providers/${id}`)
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : '删除 Provider 失败')
        return
      }
    }
    setLocalProviders((prev) => prev.filter((p) => p.id !== id))
    if (isRegistered) {
      void refreshBackendProviders()
      // Provider 变更后，使模型列表缓存失效，让对话界面的模型选择器重新获取
      void queryClient.invalidateQueries({ queryKey: ['agui-models'] })
    }
  }

  async function handleSave(entry: ProviderEntry): Promise<void> {
    // ID 优先使用已有值，否则从名称自动生成（小写+连字符）
    const id = entry.id || entry.name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
    if (!id) {
      throw new Error('请填写 Provider 名称')
    }
    if (entry.models.length === 0) {
      throw new Error('请至少添加一个模型')
    }
    const config: ProviderEntry = { ...entry, id }

    await postApi('/api/providers', {
      id: config.id,
      name: config.name,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      api: config.api,
      authHeader: config.authHeader ?? true,
      models: config.models,
    })

    // 更新 localStorage 缓存
    setLocalProviders((prev) => {
      const exists = prev.some((p) => p.id === config.id)
      return exists
        ? prev.map((p) => (p.id === config.id ? config : p))
        : [...prev, config]
    })

    // 刷新后端列表
    await refreshBackendProviders()

    // Provider 变更后，使模型列表缓存失效，让对话界面的模型选择器重新获取
    void queryClient.invalidateQueries({ queryKey: ['agui-models'] })

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
        <p className="text-muted-foreground text-sm" role="status">
          正在加载 Provider 列表...
        </p>
      )}

      {loadError && (
        <p className="text-danger text-sm" role="alert">
          {loadError}
        </p>
      )}

      <div className="grid gap-2.5" aria-label="Provider 列表">
        {mergedBackendProviders.map((provider) => (
          <ProviderCard
            key={`backend-${provider.id}`}
            provider={provider}
            onEdit={handleEdit}
            onDelete={handleDelete}
          />
        ))}
        {localOnlyProviders.map((provider) => (
          <ProviderCard
            key={`local-${provider.id}`}
            provider={provider}
            onEdit={handleEdit}
            onDelete={handleDelete}
          />
        ))}
        {!loading && !loadError && mergedBackendProviders.length === 0 && localOnlyProviders.length === 0 && (
          <p className="text-muted-foreground text-sm">暂无已注册的 Provider，点击右上角"添加 Provider"开始配置。</p>
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
  onEdit: (provider: ProviderEntry) => void
  onDelete: (id: string) => void
}

function ProviderCard({ provider, onEdit, onDelete }: ProviderCardProps): ReactElement {
  return (
    <div className="bg-surface-2 border border-border rounded-lg p-3 flex items-center gap-3">
      <div className="size-8 rounded-md bg-surface-3 flex items-center justify-center text-sm font-[780] shrink-0">
        {provider.name.charAt(0).toUpperCase() || '?'}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-[760]">{provider.name}</div>
        <div className="text-xs text-muted-foreground truncate">
          {provider.api}
          {provider.baseUrl ? ` · ${provider.baseUrl}` : ''}
        </div>
      </div>
      {provider.models.length > 0 && (
        <span className="tabular-nums text-xs text-muted-foreground whitespace-nowrap">{provider.models.length} 模型</span>
      )}
      <Badge variant="secondary" className="shrink-0">
        {provider.registered ? '已注册' : '本地'}
      </Badge>
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
          onClick={() => void onDelete(provider.id ?? provider.name)}
        >
          <TrashIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}

// ── 添加/编辑表单弹窗 ──

function FieldErrorMessage({ error }: { error: unknown }): ReactElement | null {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: string }).message
    if (typeof message === 'string') {
      return <p className="text-xs text-danger" role="alert">{message}</p>
    }
  }
  return null
}

interface ProviderFormDialogProps {
  open: boolean
  entry: ProviderEntry
  onOpenChange: (open: boolean) => void
  onSave: (entry: ProviderEntry) => Promise<void>
}

function ProviderFormDialog({ open, entry, onOpenChange, onSave }: ProviderFormDialogProps): ReactElement {
  const {
    register,
    control,
    handleSubmit,
    setValue,
    getValues,
    reset,
    watch,
    formState: { errors },
  } = useForm<ProviderFormValues>({
    resolver: zodResolver(providerFormSchema),
    defaultValues: entry,
  })
  const [showKey, setShowKey] = useState(false)
  const [testState, setTestState] = useState<TestState>({ state: 'idle' })
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [presetKey, setPresetKey] = useState<string>('')
  const [fetchingModels, setFetchingModels] = useState(false)

  // 当 entry 变化时重置表单
  useEffect(() => {
    reset(entry)
    setTestState({ state: 'idle' })
    setShowKey(false)
    setSaveError(null)
    setPresetKey('')
  }, [entry, reset])

  const models = watch('models')
  const formId = watch('id')
  const baseUrl = watch('baseUrl')
  const apiKey = watch('apiKey')

  function applyPreset(key: string): void {
    setPresetKey(key)
    if (key === 'custom') return
    const preset = providerPresets[key]
    if (!preset) return
    const option = presetOptions.find((o) => o.value === key)
    setValue('name', option?.label ?? key)
    setValue('api', preset.api)
    setValue('baseUrl', preset.baseUrl)
    setValue('models', preset.models)
  }

  async function handleFetchModels(): Promise<void> {
    const form = getValues()
    const id = form.id || form.name.toLowerCase().trim()
    if (!id) {
      setSaveError('请先填写 Provider 名称')
      return
    }
    if (!form.baseUrl || !form.apiKey) {
      setSaveError('请先填写 Base URL 和 API Key')
      return
    }

    setFetchingModels(true)
    setSaveError(null)
    try {
      // 先注册到后端（确保 ProviderConfigStore 有配置）
      await postApi('/api/providers', {
        id,
        name: form.name || id,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
        api: form.api || 'openai-completions',
        authHeader: true,
        models: form.models.length > 0 ? form.models : [{ id: 'placeholder', name: 'placeholder' }],
      })

      // 拉取远端模型列表
      const remoteModels = await getApi<Array<{ id: string; name?: string }>>(
        `/api/providers/${id}/models`
      )

      const preset = providerPresets[presetKey]
      const fetchedModels: ModelConfig[] = remoteModels.map((m) => {
        const presetModel = preset?.models.find((pm) => pm.id === m.id)
        if (presetModel) {
          // 优先使用预设的完整配置（名称、cost、contextWindow 等）
          // 仅当远端返回了更有意义的名称时才覆盖
          const remoteName = m.name && m.name !== m.id ? m.name : undefined
          return { ...presetModel, name: remoteName ?? presetModel.name }
        }
        // 非预设模型：使用远端名称，或从 ID 生成可读名称
        const readableName = m.name && m.name !== m.id
          ? m.name
          : generateReadableName(m.id)
        return { id: m.id, name: readableName }
      })

      setValue('models', fetchedModels)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : '拉取模型失败')
    } finally {
      setFetchingModels(false)
    }
  }

  async function handleTestConnection(): Promise<void> {
    setTestState({ state: 'testing' })
    setSaveError(null)
    try {
      const form = getValues()
      const id = form.id || form.name.toLowerCase().trim()
      if (!id) {
        throw new Error('请先填写名称')
      }
      if (form.models.length === 0) {
        throw new Error('请先添加至少一个模型')
      }
      // 先注册到后端
      await postApi('/api/providers', {
        id,
        name: form.name,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
        api: form.api,
        authHeader: form.authHeader ?? true,
        models: form.models,
      })
      // 再调用 ag-ui 验证模型列表
      const data = await getAgui<ModelsResponse>('/ag-ui/agent/default/models?threadId=main')
      const providerModels = data.models.filter((m) => m.provider === id)
      if (providerModels.length > 0) {
        setTestState({
          state: 'success',
          message: `验证通过，已注册 ${providerModels.length} 个模型`,
        })
      } else {
        setTestState({
          state: 'error',
          message: `后端未返回 Provider "${id}" 的模型，请检查配置`,
        })
      }
    } catch (err) {
      setTestState({
        state: 'error',
        message: err instanceof Error ? err.message : '连接失败',
      })
    }
  }

  async function onSubmit(values: ProviderFormValues): Promise<void> {
    setSaving(true)
    setSaveError(null)
    try {
      await onSave(values)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{formId ? '编辑 Provider' : '添加 Provider'}</DialogTitle>
        </DialogHeader>
        <form className="grid gap-3.5" onSubmit={handleSubmit(onSubmit, (validationErrors) => {
          // 校验失败时显示第一个错误
          const firstError = Object.values(validationErrors).find((e) => e?.message)
          if (firstError?.message) {
            setSaveError(firstError.message)
          }
        })}>
          <div className="grid gap-1.5">
            <Label htmlFor="provider-preset">Provider 预设</Label>
            <Select value={presetKey} onValueChange={applyPreset}>
              <SelectTrigger id="provider-preset" className="w-full">
                <SelectValue placeholder="选择预设自动填充..." />
              </SelectTrigger>
              <SelectContent>
                {presetOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="provider-name">名称</Label>
            <Input
              id="provider-name"
              placeholder="OpenAI"
              aria-invalid={errors.name ? true : undefined}
              {...register('name')}
            />
            <FieldErrorMessage error={errors.name} />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="provider-api">API 类型</Label>
            <Controller
              control={control}
              name="api"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
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
              )}
            />
            <FieldErrorMessage error={errors.api} />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="provider-baseurl">Base URL</Label>
            <Input
              id="provider-baseurl"
              placeholder="https://api.openai.com/v1"
              aria-invalid={errors.baseUrl ? true : undefined}
              {...register('baseUrl')}
            />
            <FieldErrorMessage error={errors.baseUrl} />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="provider-apikey">API Key</Label>
            <div className="flex gap-2">
              <Input
                id="provider-apikey"
                type={showKey ? 'text' : 'password'}
                placeholder="sk-..."
                className="flex-1 font-mono"
                aria-invalid={errors.apiKey ? true : undefined}
                {...register('apiKey')}
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
            <FieldErrorMessage error={errors.apiKey} />
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

          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label>模型列表</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={fetchingModels || !baseUrl || !apiKey}
                onClick={() => void handleFetchModels()}
              >
                <RefreshCwIcon className={`size-3.5 mr-1.5 ${fetchingModels ? 'animate-spin' : ''}`} />
                {fetchingModels ? '拉取中...' : '拉取模型'}
              </Button>
            </div>
            {models.length > 0 ? (
              <div className="grid gap-1.5 rounded-md border border-input bg-transparent p-3">
                {models.map((m, idx) => (
                  <div key={m.id} className="flex items-start gap-2 bg-surface-3 rounded-md px-2.5 py-2">
                    <div className="flex-1 min-w-0 grid gap-1.5">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-mono font-[760] truncate">{m.id}</span>
                        {m.name !== m.id && (
                          <span className="text-xs text-muted-foreground truncate">{m.name}</span>
                        )}
                        {m.reasoning && (
                          <Badge variant="outline" className="shrink-0 text-[9px] px-1 py-0">推理</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="grid gap-0.5">
                          <label className="text-[9px] text-muted-foreground">上下文窗口</label>
                          <input
                            type="number"
                            min="0"
                            placeholder="128000"
                            value={m.contextWindow ?? ''}
                            onChange={(e) => {
                              const updated = [...models]
                              updated[idx] = {
                                ...updated[idx],
                                contextWindow: e.target.value ? Number(e.target.value) : undefined,
                              }
                              setValue('models', updated, { shouldValidate: true })
                            }}
                            className="w-24 bg-surface-2 border border-border rounded px-1.5 py-0.5 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-accent/40"
                          />
                        </div>
                        <div className="grid gap-0.5">
                          <label className="text-[9px] text-muted-foreground">最大输出</label>
                          <input
                            type="number"
                            min="0"
                            placeholder="8192"
                            value={m.maxTokens ?? ''}
                            onChange={(e) => {
                              const updated = [...models]
                              updated[idx] = {
                                ...updated[idx],
                                maxTokens: e.target.value ? Number(e.target.value) : undefined,
                              }
                              setValue('models', updated, { shouldValidate: true })
                            }}
                            className="w-20 bg-surface-2 border border-border rounded px-1.5 py-0.5 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-accent/40"
                          />
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="relative mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground hover:text-danger transition-colors before:absolute before:-inset-3 before:content-[''] active:scale-[0.96]"
                      aria-label={`移除 ${m.id}`}
                      onClick={() => {
                        const updated = [...models]
                        updated.splice(idx, 1)
                        setValue('models', updated, { shouldValidate: true })
                      }}
                    >
                      <XCircleIcon className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex items-center justify-center rounded-md border border-dashed border-input bg-transparent p-4 min-h-[80px]">
                <span className="text-xs text-muted-foreground">
                  填写 Base URL 和 API Key 后点击「拉取模型」自动获取
                </span>
              </div>
            )}
            <FieldErrorMessage error={errors.models} />
          </div>

          {saveError && (
            <p className="text-xs text-danger" role="alert">
              {saveError}
            </p>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={saving}>取消</Button>
            </DialogClose>
            <Button type="submit" disabled={saving}>
              {saving ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── 工具函数 ──

/**
 * 从模型 ID 生成可读名称
 * 例如：'deepseek-chat' → 'Deepseek Chat', 'gpt-4o-mini' → 'Gpt 4o Mini'
 */
function generateReadableName(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => {
      // 保留版本号原样（如 4o, 3.5）
      if (/^\d/.test(part)) return part
      // 首字母大写
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join(' ')
}

function loadLocalProviders(): ProviderEntry[] {
  if (typeof window === 'undefined') return []
  const raw = window.localStorage.getItem(storageKey)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as ProviderEntry[]
    if (!Array.isArray(parsed)) return []
    // 确保每个 entry 都有 models 字段（向后兼容）
    return parsed.map((p) => ({ ...p, models: p.models ?? [] }))
  } catch {
    return []
  }
}

function saveLocalProviders(providers: ProviderEntry[]): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(storageKey, JSON.stringify(providers))
}

// 保留 providerIdSchema 供外部使用（如 ID 派生校验）
export { providerIdSchema }
