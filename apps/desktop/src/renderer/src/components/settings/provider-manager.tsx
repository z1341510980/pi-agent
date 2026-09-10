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

/** Pi-ai SDK 原生思考强度档位 */
export type ReasoningEffortLevel = 'low' | 'medium' | 'high' | 'xhigh'
export const REASONING_EFFORT_LEVELS: ReasoningEffortLevel[] = ['low', 'medium', 'high', 'xhigh']
export const REASONING_EFFORT_LABELS: Record<ReasoningEffortLevel, string> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
}

/** Pi-ai SDK thinkingFormat 枚举 */
export type ThinkingFormat =
  | 'openai'
  | 'openrouter'
  | 'deepseek'
  | 'together'
  | 'zai'
  | 'qwen'
  | 'qwen-chat-template'
  | 'string-thinking'
  | 'ant-ling'

/** 默认思考强度取值；'auto' 表示透传请求层默认值 */
export type DefaultReasoningEffort = 'auto' | ReasoningEffortLevel

export interface ModelConfig {
  id: string
  name: string
  reasoning?: boolean
  /** 模型是否支持图片/视觉输入（对应 SDK input 数组含 image） */
  vision?: boolean
  /** 模型是否支持工具调用（业务层扩展） */
  toolCalling?: boolean
  /** 仅思考模式：UI 不显示"关闭"选项 */
  onlyThinking?: boolean
  /** 允许关闭思考：thinkingLevelMap 含 off */
  allowDisableThinking?: boolean
  /** 自定义协议：与 thinkingFormat 配合使用 */
  customProtocol?: boolean
  /** SDK compat.thinkingFormat */
  thinkingFormat?: ThinkingFormat
  /** 模型支持的思考强度档位 */
  supportedReasoningEfforts?: ReasoningEffortLevel[]
  /** 默认思考强度；auto = 透传 */
  defaultReasoningEffort?: DefaultReasoningEffort
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  contextWindow?: number
  maxTokens?: number
}

/** 上下文/输出窗口快捷预设（用于快速填入输入框） */
export const CONTEXT_PRESETS = [32_000, 64_000, 128_000, 256_000] as const
export const MAX_TOKENS_PRESETS = [8_000, 16_000, 32_000, 64_000] as const

export type MediaProtocol = 'openai-images' | 'apimart'

export interface ProviderEntry {
  /** Provider 的稳定唯一 ID；旧版 localStorage 数据可能没有此字段 */
  id?: string
  name: string
  api: string
  baseUrl: string
  apiKey: string
  authHeader?: boolean
  models: ModelConfig[]
  /** 图片生成协议；省略时使用 OpenAI Images 兼容协议。 */
  mediaProtocol?: MediaProtocol
  /** 独立图片模型；省略时由协议适配器选择默认值。 */
  mediaModel?: string
  /** 图片生成默认分辨率，例如 APIMart 的 1k/2k/4k。 */
  mediaResolution?: string
  /** 异步图片任务状态接口的语言参数。 */
  mediaLanguage?: string
  /** 是否已注册到后端 */
  registered?: boolean
  /** 仅用于区分新增表单与编辑表单；保存后不持久化 */
  isNew?: boolean
  /**
   * 本次会话内是否已通过"拉取模型/测试"以该 id 预注册过。
   * 为 true 时保存按覆盖更新处理（不传 createOnly），避免新增模式误报 409。
   */
  alreadyRegistered?: boolean
}

/** 后端 GET /api/providers 返回项（不含 apiKey） */
interface BackendProvider {
  id: string
  name: string
  baseUrl: string
  api: string
  authHeader?: boolean
  apiKey?: string
  models: ModelConfig[]
  mediaProtocol?: MediaProtocol
  mediaModel?: string
  mediaResolution?: string
  mediaLanguage?: string
  registered?: boolean
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
  vision: z.boolean().optional(),
  toolCalling: z.boolean().optional(),
  onlyThinking: z.boolean().optional(),
  allowDisableThinking: z.boolean().optional(),
  customProtocol: z.boolean().optional(),
  thinkingFormat: z
    .enum([
      'openai',
      'openrouter',
      'deepseek',
      'together',
      'zai',
      'qwen',
      'qwen-chat-template',
      'string-thinking',
      'ant-ling',
    ])
    .optional(),
  supportedReasoningEfforts: z
    .array(z.enum(['low', 'medium', 'high', 'xhigh']))
    .optional(),
  defaultReasoningEffort: z
    .union([z.literal('auto'), z.enum(['low', 'medium', 'high', 'xhigh'])])
    .optional(),
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
  id: z.string().optional(),
  name: providerNameSchema,
  api: z.string().min(1, 'API 类型不能为空'),
  baseUrl: apiBaseUrlSchema,
  apiKey: apiKeySchema,
  authHeader: z.boolean().optional(),
  models: z.array(modelSchema).min(1, '请至少添加一个模型'),
  registered: z.boolean().optional(),
  isNew: z.boolean().optional(),
})

type ProviderFormValues = z.infer<typeof providerFormSchema>

// ── 常量 ──

const storageKey = 'wenlang-agent.providers'

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
      {
        id: 'deepseek-reasoner',
        name: 'DeepSeek R1 Reasoner',
        reasoning: true,
        // DeepSeek 推理模型支持 thinkingFormat='deepseek'（deepseek-provider 的 thinking 协议）
        thinkingFormat: 'deepseek',
        supportedReasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'auto',
        allowDisableThinking: true,
        toolCalling: false,
        cost: { input: 0.55, output: 2.19 },
        contextWindow: 65536,
        maxTokens: 8192,
      },
    ],
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    api: 'openai-completions',
    models: [
      { id: 'gpt-5.4', name: 'GPT-5.4', cost: { input: 2, output: 8 }, contextWindow: 1047576, maxTokens: 32768 },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', cost: { input: 0.4, output: 1.6 }, contextWindow: 1047576, maxTokens: 32768 },
      { id: 'gpt-5.5', name: 'GPT-5.5', cost: { input: 2.5, output: 10 }, contextWindow: 1047576, maxTokens: 32768 },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', cost: { input: 3, output: 12 }, contextWindow: 1047576, maxTokens: 32768 },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', cost: { input: 3, output: 12 }, contextWindow: 1047576, maxTokens: 32768 },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', cost: { input: 3, output: 12 }, contextWindow: 1047576, maxTokens: 32768 },
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
  const [backendProviders, setBackendProviders] = useState<BackendProvider[]>([])
  const [localProviders, setLocalProviders] = useState<ProviderEntry[]>(() => loadLocalProviders())
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState<ProviderEntry | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [defaultProviderId, setDefaultProviderId] = useState<string | null>(null)

  const localById = new Map(localProviders.map((p) => [p.id, p]))
  const backendIds = new Set(backendProviders.map((p) => p.id))

  // 合并后的 backend providers（带 local apiKey）
  const mergedBackendProviders: ProviderEntry[] = backendProviders.map((p) => ({
    ...p,
    apiKey:
      localById.get(p.id)?.apiKey ??
      localProviders.find((local) => isLegacyMatch(local, p))?.apiKey ??
      p.apiKey ??
      '',
  }))

  // 仅本地的 providers（未注册到后端）。旧缓存没有 id 时，也要按配置匹配后端，
  // 否则同一个 Provider 会在列表中出现两次。
  const localOnlyProviders = localProviders.filter(
    (p) => (!p.id || !backendIds.has(p.id)) && !backendProviders.some((backend) => isLegacyMatch(p, backend))
  )

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
      const [data, defaultRes] = await Promise.all([
        getApi<BackendProvider[]>('/api/providers'),
        // 默认 Provider 是附属信息，取不到时不应影响主列表渲染
        getApi<{ id: string | null } | null>('/api/providers/default').catch(() => null),
      ])
      const nextBackendProviders: BackendProvider[] = (data ?? []).map((p) => ({
        ...p,
        apiKey: '',
        models: p.models ?? [],
        registered: true,
      }))
      setBackendProviders(nextBackendProviders)
      // 迁移旧版 localStorage：旧数据可能没有 id，与后端同一 Provider 会被渲染成两条。
      // 能匹配到后端时复用后端 ID，匹配不到时分配新的随机 ID，避免继续使用名称作为 ID。
      setLocalProviders((prev) => reconcileLocalProviders(prev, nextBackendProviders))
      setDefaultProviderId(defaultRes?.id ?? null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '加载 Provider 列表失败')
    } finally {
      setLoading(false)
    }
  }

  async function handleSetDefault(id: string): Promise<void> {
    const prevId = defaultProviderId
    setDefaultProviderId(id) // 乐观更新
    try {
      await postApi('/api/providers/default', { id })
      void queryClient.invalidateQueries({ queryKey: ['agui-models'] })
    } catch (err) {
      setDefaultProviderId(prevId) // 回滚
      setLoadError(err instanceof Error ? err.message : '设置默认 Provider 失败')
    }
  }

  function handleAdd(): void {
    const existingIds = new Set(
      [...backendProviders, ...localProviders]
        .map((p) => p.id)
        .filter((id): id is string => Boolean(id))
    )
    setEditing({
      id: generateProviderId(existingIds),
      name: '',
      api: 'openai-completions',
      baseUrl: '',
      apiKey: '',
      models: [],
      isNew: true,
    })
    setDialogOpen(true)
  }

  function handleEdit(provider: ProviderEntry): void {
    const existingIds = new Set(
      [...backendProviders, ...localProviders]
        .map((p) => p.id)
        .filter((id): id is string => Boolean(id))
    )
    const backendProvider = backendProviders.find(
      (p) => (provider.id !== undefined && p.id === provider.id) || isLegacyMatch(provider, p)
    )
    const id = provider.id || backendProvider?.id || generateProviderId(existingIds)
    // 旧缓存没有 id 时，编辑前就补上稳定 ID，避免保存后旧记录仍留在 localStorage。
    if (!provider.id) {
      setLocalProviders((prev) => prev.map((p) => (p === provider ? { ...p, id } : p)))
    }
    setEditing({ ...provider, id, isNew: false })
    setDialogOpen(true)
  }

  async function handleDelete(provider: ProviderEntry): Promise<void> {
    // 兼容旧版无 id 缓存：按完整配置找到对应后端 Provider，不能再把名称拼到删除 URL。
    const registeredProvider = backendProviders.find(
      (p) => (provider.id !== undefined && p.id === provider.id) || isLegacyMatch(provider, p)
    )
    const id = registeredProvider?.id

    if (id) {
      try {
        await deleteApi(`/api/providers/${encodeURIComponent(id)}`)
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : '删除 Provider 失败')
        return
      }
    }

    setLocalProviders((prev) =>
      prev.filter((p) => {
        if (p === provider) return false
        if (id && p.id === id) return false
        return !(registeredProvider && isLegacyMatch(p, registeredProvider))
      })
    )
    if (id) {
      void refreshBackendProviders()
      // Provider 变更后，使模型列表缓存失效，让对话界面的模型选择器重新获取
      void queryClient.invalidateQueries({ queryKey: ['agui-models'] })
    }
  }

  async function handleSave(entry: ProviderEntry): Promise<void> {
    if (entry.models.length === 0) {
      throw new Error('请至少添加一个模型')
    }
    // 新增时 ID 已在打开表单时分配；这里仅为旧数据/异常调用保留随机 ID 兜底。
    const existingIds = new Set(
      [...backendProviders, ...localProviders]
        .map((p) => p.id)
        .filter((id): id is string => Boolean(id))
    )
    const id =
      entry.id ||
      generateProviderId(existingIds)
    const { isNew: _isNew, alreadyRegistered: _alreadyRegistered, ...persistedEntry } = entry
    const config: ProviderEntry = { ...persistedEntry, id }

    await postApi('/api/providers', {
      id: config.id,
      name: config.name,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      api: config.api,
      authHeader: config.authHeader ?? true,
      models: config.models,
      // 新增模式且本会话未预注册过该 id：后端兜底拒绝覆盖已存在 Provider。
      createOnly: entry.isNew === true && !entry.alreadyRegistered,
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
            isDefault={defaultProviderId === provider.id}
            onSetDefault={(id) => void handleSetDefault(id)}
            onEdit={handleEdit}
            onDelete={handleDelete}
          />
        ))}
        {localOnlyProviders.map((provider, index) => (
          <ProviderCard
            key={`local-${provider.id ?? provider.name}-${index}`}
            provider={provider}
            isDefault={false}
            onSetDefault={() => {}}
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
  isDefault: boolean
  onSetDefault: (id: string) => void
  onEdit: (provider: ProviderEntry) => void
  onDelete: (provider: ProviderEntry) => void
}

function ProviderCard({ provider, isDefault, onSetDefault, onEdit, onDelete }: ProviderCardProps): ReactElement {
  const providerId = provider.id
  return (
    <div className="bg-surface-2 border border-border rounded-lg p-3 flex items-center gap-3">
      {/* 默认 Provider 单选圆圈 */}
      <button
        type="button"
        className="size-4 rounded-full border-2 border-border flex items-center justify-center shrink-0 transition-colors hover:border-accent"
        aria-label={isDefault ? `${provider.name} 是默认 Provider` : `将 ${provider.name} 设为默认`}
        aria-pressed={isDefault}
        title={isDefault ? '默认 Provider' : '点击设为默认 Provider'}
        onClick={() => {
          if (providerId) onSetDefault(providerId)
        }}
      >
        {isDefault && <span className="size-2 rounded-full bg-accent" />}
      </button>
      <div className="size-8 rounded-md bg-surface-3 flex items-center justify-center text-sm font-[780] shrink-0">
        {provider.name.charAt(0).toUpperCase() || '?'}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-[760] flex items-center gap-1.5">
          {provider.name}
          {isDefault && (
            <Badge variant="default" className="text-[9px] px-1 py-0">默认</Badge>
          )}
        </div>
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
          onClick={() => void onDelete(provider)}
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
  // 手动添加模型表单状态
  const [showAddModelForm, setShowAddModelForm] = useState(false)
  const [newModelId, setNewModelId] = useState('')
  const [newModelName, setNewModelName] = useState('')
  const [newModelCtx, setNewModelCtx] = useState('')
  const [newModelMaxTokens, setNewModelMaxTokens] = useState('')
  // 本次会话内通过"拉取模型/测试"预注册过的 id 集合
  // 保存时若命中集合，说明该 id 是本次会话自己创建的，按覆盖更新处理（不传 createOnly）
  const [tempRegisteredIds, setTempRegisteredIds] = useState<Set<string>>(new Set())

  // 当 entry 变化时重置表单
  useEffect(() => {
    reset(entry)
    setTestState({ state: 'idle' })
    setShowKey(false)
    setSaveError(null)
    setPresetKey('')
    setShowAddModelForm(false)
    setNewModelId('')
    setNewModelName('')
    setNewModelCtx('')
    setNewModelMaxTokens('')
    setTempRegisteredIds(new Set())
  }, [entry, reset])

  const models = watch('models')
  const isNew = watch('isNew')
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
    if (!form.name.trim()) {
      setSaveError('请先填写 Provider 名称')
      return
    }
    if (!form.baseUrl || (form.isNew === true && !form.apiKey.trim())) {
      setSaveError(form.isNew === true ? '请先填写 Base URL 和 API Key' : '请先填写 Base URL')
      return
    }
    // 新增表单的 ID 在打开时已分配；旧表单没有 ID 时在首次预注册前补齐。
    const id = computeDialogId(form)
    if (!form.id) setValue('id', id)

    setFetchingModels(true)
    setSaveError(null)
    try {
      // 先注册到后端（确保 ProviderConfigStore 有配置）。
      // 此处不带 createOnly：id 已由前端唯一化，不会覆盖已有 Provider；
      // 且带 createOnly 会导致后续保存同 id 时误报 409。
      await postApi('/api/providers', {
        id,
        name: form.name || id,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
        api: form.api || 'openai-completions',
        authHeader: form.authHeader ?? true,
        models: form.models.length > 0 ? form.models : [{ id: 'placeholder', name: 'placeholder' }],
      })
      setTempRegisteredIds((prev) => new Set(prev).add(id))

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
      // 拉取失败时清掉占位模型（避免 placeholder 残留导致保存时误提交）
      const currentModels = getValues('models')
      if (currentModels.length === 1 && currentModels[0].id === 'placeholder') {
        setValue('models', [])
      }
      setSaveError(err instanceof Error ? err.message : '拉取模型失败')
    } finally {
      setFetchingModels(false)
    }
  }

  // 手动添加一个模型到列表（不依赖远端拉取）
  function handleAddModelManually(): void {
    const id = newModelId.trim()
    if (!id) {
      setSaveError('请填写 Model ID')
      return
    }
    const name = newModelName.trim() || id
    const existing = getValues('models')
    if (existing.some((m) => m.id === id)) {
      setSaveError(`模型 "${id}" 已存在`)
      return
    }
    const ctx = newModelCtx ? Number(newModelCtx) : undefined
    const maxTok = newModelMaxTokens ? Number(newModelMaxTokens) : undefined
    if (ctx !== undefined && (!Number.isFinite(ctx) || ctx <= 0)) {
      setSaveError('上下文窗口必须是正数')
      return
    }
    if (maxTok !== undefined && (!Number.isFinite(maxTok) || maxTok <= 0)) {
      setSaveError('最大输出必须是正数')
      return
    }
    const newModel: ModelConfig = {
      id,
      name,
      contextWindow: ctx,
      maxTokens: maxTok,
    }
    setValue('models', [...existing, newModel], { shouldValidate: true })
    setNewModelId('')
    setNewModelName('')
    setNewModelCtx('')
    setNewModelMaxTokens('')
    setShowAddModelForm(false)
    setSaveError(null)
  }

  async function handleTestConnection(): Promise<void> {
    setTestState({ state: 'testing' })
    setSaveError(null)
    try {
      const form = getValues()
      if (!form.name.trim()) {
        throw new Error('请先填写名称')
      }
      if (form.models.length === 0) {
        throw new Error('请先添加至少一个模型')
      }
      // 新增表单的 ID 在打开时已分配；旧表单没有 ID 时在首次预注册前补齐。
      const id = computeDialogId(form)
      if (!form.id) setValue('id', id)
      // 先注册到后端（不带 createOnly，理由同 handleFetchModels）
      await postApi('/api/providers', {
        id,
        name: form.name,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
        api: form.api,
        authHeader: form.authHeader ?? true,
        models: form.models,
      })
      setTempRegisteredIds((prev) => new Set(prev).add(id))
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
      // 若本次会话已通过"拉取模型/测试"预注册过该 id，
      // 保存属于对临时数据的覆盖更新（不传 createOnly，避免误报 409）
      const actualId = computeDialogId(values)
      await onSave({
        ...values,
        alreadyRegistered: tempRegisteredIds.has(actualId),
      })
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isNew ? '添加 Provider' : '编辑 Provider'}</DialogTitle>
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
                placeholder={isNew ? 'sk-...' : '留空以保留当前 Key'}
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
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => { setShowAddModelForm((v) => !v); setSaveError(null) }}
                >
                  <PlusIcon className="size-3.5" />
                  手动添加
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={fetchingModels || !baseUrl || (isNew === true && !apiKey)}
                  onClick={() => void handleFetchModels()}
                >
                  <RefreshCwIcon className={`size-3.5 ${fetchingModels ? 'animate-spin' : ''}`} />
                  {fetchingModels ? '拉取中...' : '拉取模型'}
                </Button>
              </div>
            </div>

            {/* 手动添加模型表单 */}
            {showAddModelForm && (
              <div className="grid gap-2 rounded-md border border-input bg-surface-3 p-3">
                <div className="grid grid-cols-2 gap-2">
                  <div className="grid gap-1">
                    <label className="text-[9px] text-muted-foreground">Model ID *</label>
                    <input
                      type="text"
                      placeholder="gpt-5.4"
                      value={newModelId}
                      onChange={(e) => setNewModelId(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddModelManually() } }}
                      className="bg-surface-2 border border-border rounded px-1.5 py-1 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-accent/40"
                    />
                  </div>
                  <div className="grid gap-1">
                    <label className="text-[9px] text-muted-foreground">显示名称</label>
                    <input
                      type="text"
                      placeholder="GPT-5.4"
                      value={newModelName}
                      onChange={(e) => setNewModelName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddModelManually() } }}
                      className="bg-surface-2 border border-border rounded px-1.5 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-accent/40"
                    />
                  </div>
                  <div className="grid gap-1">
                    <label className="text-[9px] text-muted-foreground">上下文窗口</label>
                    <input
                      type="number"
                      min="0"
                      placeholder="128000"
                      value={newModelCtx}
                      onChange={(e) => setNewModelCtx(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddModelManually() } }}
                      className="bg-surface-2 border border-border rounded px-1.5 py-1 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-accent/40"
                    />
                  </div>
                  <div className="grid gap-1">
                    <label className="text-[9px] text-muted-foreground">最大输出</label>
                    <input
                      type="number"
                      min="0"
                      placeholder="8192"
                      value={newModelMaxTokens}
                      onChange={(e) => setNewModelMaxTokens(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddModelManually() } }}
                      className="bg-surface-2 border border-border rounded px-1.5 py-1 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-accent/40"
                    />
                  </div>
                </div>
                <div className="flex items-center justify-end gap-1.5">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setShowAddModelForm(false)}>
                    取消
                  </Button>
                  <Button type="button" size="sm" disabled={!newModelId.trim()} onClick={handleAddModelManually}>
                    <PlusIcon className="size-3" />
                    添加
                  </Button>
                </div>
              </div>
            )}

            {models.length > 0 ? (
              <div className="grid gap-1.5 rounded-md border border-input bg-transparent p-3">
                {models.map((m, idx) => (
                  <ModelEditor
                    key={m.id}
                    model={m}
                    index={idx}
                    models={models}
                    onChange={(next) => setValue('models', next, { shouldValidate: true })}
                    onRemove={() => {
                      const updated = [...models]
                      updated.splice(idx, 1)
                      setValue('models', updated, { shouldValidate: true })
                    }}
                  />
                ))}
              </div>
            ) : (
              <div className="flex items-center justify-center rounded-md border border-dashed border-input bg-transparent p-4 min-h-[80px]">
                <span className="text-xs text-muted-foreground text-center">
                  点击「手动添加」填写模型，或填写 Base URL 和 API Key 后「拉取模型」自动获取
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

// ── 单模型编辑器（卡片 + 高级配置折叠面板） ──

interface ModelEditorProps {
  model: ModelConfig
  index: number
  models: ModelConfig[]
  onChange: (next: ModelConfig[]) => void
  onRemove: () => void
}

/** 把数字格式化为 "32K / 128K / 1M" 等紧凑形式（用于快捷按钮文案） */
function formatTokenPreset(n: number): string {
  if (n >= 1_000_000) return `${n / 1_000_000}M`
  if (n >= 1_000) return `${n / 1_000}K`
  return String(n)
}

function ModelEditor({ model, index, models, onChange, onRemove }: ModelEditorProps): ReactElement {
  const [expanded, setExpanded] = useState(false)

  // 更新单个字段（不可变更新 models 数组）
  const patch = (changes: Partial<ModelConfig>): void => {
    const updated = [...models]
    updated[index] = { ...updated[index], ...changes }
    onChange(updated)
  }

  // 切换 supportedReasoningEfforts 数组中的某一档
  const toggleEffort = (level: ReasoningEffortLevel): void => {
    const current = model.supportedReasoningEfforts ?? []
    const next = current.includes(level)
      ? current.filter((l) => l !== level)
      : [...current, level]
    patch({ supportedReasoningEfforts: next.length > 0 ? next : undefined })
  }

  return (
    <div className="flex items-start gap-2 bg-surface-3 rounded-md px-2.5 py-2">
      <div className="flex-1 min-w-0 grid gap-1.5">
        {/* 标题行：模型 ID + 名称 + 能力徽章 */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs font-mono font-[760] truncate">{model.id}</span>
          {model.name !== model.id && (
            <span className="text-xs text-muted-foreground truncate">{model.name}</span>
          )}
          {model.reasoning && (
            <Badge variant="outline" className="shrink-0 text-[9px] px-1 py-0">推理</Badge>
          )}
          {model.vision && (
            <Badge variant="outline" className="shrink-0 text-[9px] px-1 py-0">视觉</Badge>
          )}
          {model.toolCalling && (
            <Badge variant="outline" className="shrink-0 text-[9px] px-1 py-0">工具</Badge>
          )}
        </div>

        {/* 上下文窗口 + 最大输出（带快捷按钮） */}
        <div className="flex items-end gap-3 flex-wrap">
          <div className="grid gap-0.5">
            <label className="text-[9px] text-muted-foreground">输入 · 上下文窗口</label>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min="0"
                placeholder="128000"
                value={model.contextWindow ?? ''}
                onChange={(e) =>
                  patch({ contextWindow: e.target.value ? Number(e.target.value) : undefined })
                }
                className="w-24 bg-surface-2 border border-border rounded px-1.5 py-0.5 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-accent/40"
              />
              <div className="flex items-center gap-0.5">
                {CONTEXT_PRESETS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => patch({ contextWindow: n })}
                    className="text-[10px] px-1 py-0.5 rounded text-muted-foreground hover:bg-surface-2 hover:text-foreground transition-colors"
                    aria-label={`设为 ${formatTokenPreset(n)}`}
                  >
                    {formatTokenPreset(n)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="grid gap-0.5">
            <label className="text-[9px] text-muted-foreground">输出 · 最大 token</label>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min="0"
                placeholder="8192"
                value={model.maxTokens ?? ''}
                onChange={(e) =>
                  patch({ maxTokens: e.target.value ? Number(e.target.value) : undefined })
                }
                className="w-20 bg-surface-2 border border-border rounded px-1.5 py-0.5 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-accent/40"
              />
              <div className="flex items-center gap-0.5">
                {MAX_TOKENS_PRESETS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => patch({ maxTokens: n })}
                    className="text-[10px] px-1 py-0.5 rounded text-muted-foreground hover:bg-surface-2 hover:text-foreground transition-colors"
                    aria-label={`设为 ${formatTokenPreset(n)}`}
                  >
                    {formatTokenPreset(n)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* 高级配置折叠按钮 */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto text-[10px] h-6 px-2"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={expanded ? '收起高级配置' : '展开高级配置'}
          >
            {expanded ? '收起' : '高级配置'}
          </Button>
        </div>

        {/* 高级配置面板 */}
        {expanded && (
          <div className="grid gap-2 mt-1 rounded border border-input bg-surface-2/40 p-2.5">
            {/* 能力开关（6 个） */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1.5">
              <CapabilityCheckbox
                label="工具调用"
                checked={model.toolCalling ?? false}
                onChange={(v) => patch({ toolCalling: v })}
              />
              <CapabilityCheckbox
                label="图片输入"
                checked={model.vision ?? false}
                onChange={(v) => patch({ vision: v })}
              />
              <CapabilityCheckbox
                label="思考模式"
                checked={model.reasoning ?? false}
                onChange={(v) => {
                  // 关闭思考时清空相关字段
                  patch({
                    reasoning: v,
                    ...(v
                      ? {}
                      : {
                          supportedReasoningEfforts: undefined,
                          defaultReasoningEffort: undefined,
                          allowDisableThinking: undefined,
                          onlyThinking: undefined,
                        }),
                  })
                }}
              />
              <CapabilityCheckbox
                label="仅思考模式"
                checked={model.onlyThinking ?? false}
                onChange={(v) => patch({ onlyThinking: v })}
                disabled={!model.reasoning}
              />
              <CapabilityCheckbox
                label="允许关闭思考"
                checked={model.allowDisableThinking ?? false}
                onChange={(v) => patch({ allowDisableThinking: v })}
                disabled={!model.reasoning}
              />
              <CapabilityCheckbox
                label="自定义协议"
                checked={model.customProtocol ?? false}
                onChange={(v) => {
                  patch({
                    customProtocol: v,
                    // 关闭时清空 thinkingFormat
                    ...(v ? {} : { thinkingFormat: undefined }),
                  })
                }}
              />
            </div>

            {/* 思考强度配置（仅在 reasoning=true 时显示） */}
            {model.reasoning && (
              <div className="grid gap-1.5 pt-1.5 border-t border-border/60">
                <div className="text-[9px] text-muted-foreground">
                  支持的思考强度（4 档，对齐 pi-ai SDK 原生档位）
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  {REASONING_EFFORT_LEVELS.map((level) => (
                    <label key={level} className="flex items-center gap-1 text-[11px]">
                      <input
                        type="checkbox"
                        checked={(model.supportedReasoningEfforts ?? []).includes(level)}
                        onChange={() => toggleEffort(level)}
                        className="size-3 accent-accent"
                      />
                      <span>{REASONING_EFFORT_LABELS[level]}</span>
                    </label>
                  ))}
                </div>

                <div className="grid gap-0.5">
                  <label className="text-[9px] text-muted-foreground">默认思考强度</label>
                  <select
                    value={model.defaultReasoningEffort ?? 'auto'}
                    onChange={(e) =>
                      patch({
                        defaultReasoningEffort: e.target.value as DefaultReasoningEffort,
                      })
                    }
                    className="bg-surface-2 border border-border rounded px-1.5 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-accent/40 w-32"
                  >
                    <option value="auto">自动（透传请求层）</option>
                    <option value="low">低</option>
                    <option value="medium">中</option>
                    <option value="high">高</option>
                    <option value="xhigh">极高</option>
                  </select>
                </div>
              </div>
            )}

            {/* thinkingFormat（仅在 customProtocol=true 时显示） */}
            {model.customProtocol && (
              <div className="grid gap-0.5 pt-1.5 border-t border-border/60">
                <label className="text-[9px] text-muted-foreground">自定义协议（thinkingFormat）</label>
                <select
                  value={model.thinkingFormat ?? 'string-thinking'}
                  onChange={(e) => patch({ thinkingFormat: e.target.value as ThinkingFormat })}
                  className="bg-surface-2 border border-border rounded px-1.5 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-accent/40 w-44"
                >
                  <option value="openai">openai（OpenAI reasoning_effort）</option>
                  <option value="openrouter">openrouter</option>
                  <option value="deepseek">deepseek（DeepSeek thinking）</option>
                  <option value="together">together</option>
                  <option value="zai">zai</option>
                  <option value="qwen">qwen（顶层 enable_thinking）</option>
                  <option value="qwen-chat-template">qwen-chat-template</option>
                  <option value="string-thinking">string-thinking</option>
                  <option value="ant-ling">ant-ling</option>
                </select>
              </div>
            )}
          </div>
        )}
      </div>

      <button
        type="button"
        className="relative mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground hover:text-danger transition-colors before:absolute before:-inset-3 before:content-[''] active:scale-[0.96]"
        aria-label={`移除 ${model.id}`}
        onClick={onRemove}
      >
        <XCircleIcon className="size-3.5" />
      </button>
    </div>
  )
}

/** 复选框小组件（能力开关） */
function CapabilityCheckbox({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}): ReactElement {
  return (
    <label className={`flex items-center gap-1.5 text-[11px] ${disabled ? 'opacity-50' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="size-3 accent-accent"
      />
      <span>{label}</span>
    </label>
  )
}

// ── 工具函数 ──

/**
 * 从名称派生 Provider ID（小写 + 非字母数字替换为连字符）
 * 例如：'OpenAI Custom' → 'openai-custom'；'硅基流动' → ''（需调用方回退随机 id）
 */
export function deriveProviderId(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * 确保 Provider ID 唯一：与已有 id 冲突时追加 -2/-3... 后缀。
 * 新增 Provider 必须经过此函数去重，否则同名派生 id（如 openai/deepseek）
 * 会命中后端 upsert 语义，覆盖已有 Provider（尤其是默认 Provider）的数据。
 * excludeId 用于编辑场景排除自身（当前调用方均为新增场景，可不传）。
 */
export function ensureUniqueProviderId(baseId: string, existingIds: Set<string>, excludeId?: string): string {
  if (!baseId) return baseId
  if (!existingIds.has(baseId) || baseId === excludeId) return baseId
  let index = 2
  while (existingIds.has(`${baseId}-${index}`)) index += 1
  return `${baseId}-${index}`
}

/**
 * 计算表单对应的 Provider ID：
 * - 编辑模式（已有 id）：直接使用原 id
 * - 新增模式：使用表单已分配的 ID；旧表单没有 ID 时生成随机 ID
 *
 * 拉取模型 / 测试连接 / 保存三处共用本函数，保证会话内计算出的 id 一致，
 * 避免"拉取模型"预注册的 id 与"保存"时算出的 id 不一致导致残留或误判。
 */
function computeDialogId(
  form: Pick<ProviderFormValues, 'id'>
): string {
  return form.id || generateProviderId()
}

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

/**
 * 将旧版本地缓存与后端 Provider 对齐。
 *
 * 旧版本可能把名称派生值（如 openai-2）或空值写入 localStorage，
 * 导致后端同一配置被渲染成另一条本地 Provider。只有看起来像旧版派生 ID
 * 的记录才按名称和连接配置匹配，新的随机 ID 即使配置相同也必须保留。
 */
export function reconcileLocalProviders(
  localProviders: ProviderEntry[],
  backendProviders: BackendProvider[]
): ProviderEntry[] {
  const usedIds = new Set(backendProviders.map((provider) => provider.id))
  const reconciled: ProviderEntry[] = []

  for (const provider of localProviders) {
    const backendProvider = backendProviders.find(
      (candidate) =>
        (provider.id !== undefined && candidate.id === provider.id) ||
        isLegacyMatch(provider, candidate)
    )
    const id = backendProvider?.id ?? (provider.id || generateProviderId(usedIds))
    const normalized = { ...provider, id }
    const existingIndex = reconciled.findIndex((item) => item.id === id)

    if (existingIndex >= 0) {
      const previous = reconciled[existingIndex]
      reconciled[existingIndex] = {
        ...previous,
        ...normalized,
        // 不要因为旧缓存中的空值覆盖另一条缓存中的 API Key。
        apiKey: normalized.apiKey || previous.apiKey,
      }
    } else {
      reconciled.push(normalized)
    }
    usedIds.add(id)
  }

  return reconciled
}

function isLegacyMatch(local: ProviderEntry, backend: BackendProvider): boolean {
  if (local.id && !isLegacyProviderId(local.id, local.name)) return false
  return (
    local.name.trim().toLowerCase() === backend.name.trim().toLowerCase() &&
    local.api === backend.api &&
    normalizeProviderUrl(local.baseUrl) === normalizeProviderUrl(backend.baseUrl)
  )
}

function isLegacyProviderId(id: string, name: string): boolean {
  const baseId = deriveProviderId(name)
  if (!baseId) return false
  return id === baseId || new RegExp(`^${escapeRegExp(baseId)}-\\d+$`).test(id)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeProviderUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase()
}

/** 创建不依赖名称的 Provider 稳定唯一 ID。 */
export function generateProviderId(existingIds: Set<string> = new Set()): string {
  let id = ''
  do {
    const randomPart =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2, 14)
    id = `provider-${randomPart}`
  } while (existingIds.has(id))
  return id
}

function saveLocalProviders(providers: ProviderEntry[]): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(storageKey, JSON.stringify(providers))
}

// 保留 providerIdSchema 供外部使用（如 ID 派生校验）
export { providerIdSchema }
