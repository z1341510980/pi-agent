import type { ComponentType, FormEvent, ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import {
  AudioLinesIcon,
  EditIcon,
  EyeIcon,
  EyeOffIcon,
  ImageIcon,
  PlusIcon,
  TrashIcon,
  TypeIcon,
  VideoIcon
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogClose
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Segmented } from '@/components/ui/segmented'
import { SettingsPageHeader } from './setting-primitives'
import { ProviderManager } from './provider-manager'
import {
  createMediaProvider,
  deleteMediaProvider,
  listMediaAdapters,
  listMediaProviders,
  setMediaProviderDefault,
  updateMediaProvider,
  type MediaAdapterMeta,
  type MediaModality,
  type MediaProviderRow,
  type StoredMediaModality
} from '@/api/media-provider-client'

/**
 * MediaSettings —— 设置页「媒体生成」分区（spec §5）
 *
 * 四模态 tab：
 * - 文字：内嵌现有 ProviderManager（LLM Provider 体系即文字生成体系，共享同一数据源，
 *   与「模型与 Provider」页保持单一真实来源，不迁移数据）
 * - 图片：Provider 卡片列表 + 新增/编辑表单（adapter formSchema 驱动动态字段）
 * - 视频/音频：阶段一空态引导卡，待阶段二 adapter 上线后 formSchema 自动可用
 *
 * 数据流：挂载加载 adapters 元数据一次；各模态 Provider 列表在首次切到该 tab 时懒加载，
 * 增删改/默认切换后仅刷新当前模态。
 */

const MODALITY_TABS: ReadonlyArray<{
  value: MediaModality
  label: string
  icon: ComponentType<{ className?: string }>
}> = [
  { value: 'text', label: '文字', icon: TypeIcon },
  { value: 'image', label: '图片', icon: ImageIcon },
  { value: 'video', label: '视频', icon: VideoIcon },
  { value: 'audio', label: '音频', icon: AudioLinesIcon }
]

const MODALITY_LABELS: Record<StoredMediaModality, string> = {
  image: '图片',
  video: '视频',
  audio: '音频'
}

/** 新增/编辑表单的受控快照；打开时由调用方构造，Dialog 挂载即初始化 */
interface MediaProviderFormState {
  mode: 'create' | 'edit'
  row: MediaProviderRow | null
  modality: StoredMediaModality
  name: string
  adapter: string
  baseUrl: string
  apiKey: string
  model: string
  params: Record<string, string>
}

export function MediaSettings(): ReactElement {
  const [tab, setTab] = useState<MediaModality>('text')
  const [adapters, setAdapters] = useState<MediaAdapterMeta[]>([])
  const [providersByModality, setProvidersByModality] = useState<
    Partial<Record<StoredMediaModality, MediaProviderRow[]>>
  >({})
  const [loadedModalities, setLoadedModalities] = useState<ReadonlySet<StoredMediaModality>>(
    () => new Set()
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [formState, setFormState] = useState<MediaProviderFormState | null>(null)

  // adapters 元数据（含 formSchema）挂载时加载一次
  useEffect(() => {
    let cancelled = false
    listMediaAdapters()
      .then((res) => {
        if (!cancelled) setAdapters(res.adapters ?? [])
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '加载适配器清单失败')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const loadProviders = useCallback(async (modality: StoredMediaModality): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const rows = await listMediaProviders(modality)
      setProvidersByModality((prev) => ({ ...prev, [modality]: rows }))
      setLoadedModalities((prev) => {
        const next = new Set(prev)
        next.add(modality)
        return next
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载 Provider 列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  function handleTabChange(next: MediaModality): void {
    setTab(next)
    // tab 切换懒加载：文字 tab 由 ProviderManager 自取数据，其余模态首次进入时拉取
    if (next !== 'text' && !loadedModalities.has(next)) void loadProviders(next)
  }

  function openCreateForm(): void {
    // 新增入口只出现在非文字 tab（文字复用 ProviderManager），此处收窄类型
    if (tab === 'text') return
    const modality: StoredMediaModality = tab
    const options = adapters.filter((a) => a.modality === modality)
    setFormState({
      mode: 'create',
      row: null,
      modality,
      name: '',
      adapter: options[0]?.id ?? '',
      baseUrl: '',
      apiKey: '',
      model: '',
      params: {}
    })
  }

  function openEditForm(row: MediaProviderRow): void {
    // 编辑表单 apiKey 恒为空串：提交时空值不发送，由后端保留旧 Key
    setFormState({
      mode: 'edit',
      row,
      modality: row.modality,
      name: row.name,
      adapter: row.adapter,
      baseUrl: row.baseUrl,
      apiKey: '',
      model: row.model,
      params: { ...row.params }
    })
  }

  async function handleSetDefault(row: MediaProviderRow): Promise<void> {
    try {
      await setMediaProviderDefault(row.id)
      await loadProviders(row.modality)
    } catch (err) {
      setError(err instanceof Error ? err.message : '设置默认 Provider 失败')
    }
  }

  async function handleDelete(row: MediaProviderRow): Promise<void> {
    if (!window.confirm(`确定删除 Provider "${row.name}"？此操作无法恢复。`)) return
    try {
      await deleteMediaProvider(row.id)
      await loadProviders(row.modality)
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除 Provider 失败')
    }
  }

  const tabAdapters = adapters.filter((a) => a.modality === tab)
  const rows = tab !== 'text' ? (providersByModality[tab] ?? []) : []

  return (
    <section className="grid gap-5 p-6" aria-label="媒体生成">
      <SettingsPageHeader
        eyebrow="Media"
        title="媒体生成"
        description="按模态管理生成 Provider：图片 / 视频 / 音频各自可配置多个实例并指定默认。文字生成复用「模型与 Provider」的 LLM Provider 体系。"
      />

      <div>
        <Segmented
          ariaLabel="媒体模态"
          options={MODALITY_TABS}
          value={tab}
          onChange={handleTabChange}
        />
      </div>

      {error && (
        <p className="text-danger text-sm" role="alert">
          {error}
        </p>
      )}
      {loading && (
        <p className="text-muted-foreground text-sm" role="status">
          正在加载 Provider 列表...
        </p>
      )}

      {/* 文字 tab：内嵌现有 ProviderManager（零适配，共享同一数据源） */}
      {tab === 'text' && <ProviderManager />}

      {/* 视频/音频：阶段一暂无 adapter，渲染引导卡（阶段二 adapter 上线后自动进入列表模式） */}
      {tab !== 'text' && tabAdapters.length === 0 && (
        <div className="rounded-[18px] border border-dashed border-border bg-surface-1/40 p-8 text-center">
          <p className="text-sm font-medium text-text">该模态即将支持，将在后续版本提供配置</p>
          <p className="mt-2 text-xs text-hint">
            当前版本暂无{MODALITY_LABELS[tab]}模态适配器，适配器上线后此处即可新增 Provider。
          </p>
        </div>
      )}

      {tab !== 'text' && tabAdapters.length > 0 && (
        <>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-muted-foreground">
              <ImageIcon className="size-4" />
              <span className="text-xs font-medium">{MODALITY_LABELS[tab]}生成 Provider 列表</span>
            </div>
            {rows.length > 0 && (
              <Button size="sm" aria-label="新增 Provider" onClick={openCreateForm}>
                <PlusIcon className="size-3.5" />
                新增 Provider
              </Button>
            )}
          </div>

          <div className="grid gap-2.5" aria-label={`${MODALITY_LABELS[tab]} Provider 列表`}>
            {rows.map((row) => (
              <MediaProviderCard
                key={row.id}
                row={row}
                adapterLabel={tabAdapters.find((a) => a.id === row.adapter)?.label ?? row.adapter}
                onSetDefault={() => void handleSetDefault(row)}
                onEdit={() => openEditForm(row)}
                onDelete={() => void handleDelete(row)}
              />
            ))}
          </div>

          {!loading && rows.length === 0 && (
            <div className="rounded-[18px] border border-dashed border-border bg-surface-1/40 p-8 text-center">
              <p className="text-sm text-hint">
                尚未配置{MODALITY_LABELS[tab]}生成 Provider，新增后即可在画布生成图片
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-3"
                aria-label="新增 Provider"
                onClick={openCreateForm}
              >
                <PlusIcon className="size-3.5" />
                新增 Provider
              </Button>
            </div>
          )}
        </>
      )}

      {formState && (
        <MediaProviderFormDialog
          state={formState}
          adapters={adapters}
          onClose={() => setFormState(null)}
          onSaved={async () => {
            await loadProviders(formState.modality)
          }}
        />
      )}
    </section>
  )
}

// ── Provider 卡片（对齐 provider-manager 的卡片视觉与交互） ──

interface MediaProviderCardProps {
  row: MediaProviderRow
  adapterLabel: string
  onSetDefault: () => void
  onEdit: () => void
  onDelete: () => void
}

function MediaProviderCard({
  row,
  adapterLabel,
  onSetDefault,
  onEdit,
  onDelete
}: MediaProviderCardProps): ReactElement {
  return (
    <div className="bg-surface-2 border border-border rounded-lg p-3 flex items-center gap-3">
      <div className="size-8 rounded-md bg-surface-3 flex items-center justify-center text-sm font-[780] shrink-0">
        {row.name.charAt(0).toUpperCase() || '?'}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-[760] flex items-center gap-1.5">
          <span className="truncate">{row.name}</span>
          {row.isDefault && (
            <Badge variant="default" className="text-[9px] px-1 py-0">
              默认
            </Badge>
          )}
          {!row.enabled && (
            <Badge variant="outline" className="text-[9px] px-1 py-0">
              已停用
            </Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground truncate">
          {adapterLabel}
          {row.model ? ` · ${row.model}` : ''}
        </div>
        <div className="text-xs text-hint truncate">Key：{row.keyHint || '未设置'}</div>
      </div>
      {!row.isDefault && (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`将 ${row.name} 设为默认`}
          onClick={onSetDefault}
        >
          设为默认
        </Button>
      )}
      <div className="flex items-center gap-1 shrink-0">
        <Button variant="ghost" size="icon-sm" aria-label={`编辑 ${row.name}`} onClick={onEdit}>
          <EditIcon className="size-3.5" />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={`删除 ${row.name}`} onClick={onDelete}>
          <TrashIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}

// ── 新增/编辑表单弹窗（固定字段 + adapter formSchema 动态字段） ──

interface MediaProviderFormDialogProps {
  state: MediaProviderFormState
  adapters: MediaAdapterMeta[]
  onClose: () => void
  onSaved: () => Promise<void>
}

function MediaProviderFormDialog({
  state,
  adapters,
  onClose,
  onSaved
}: MediaProviderFormDialogProps): ReactElement {
  const [name, setName] = useState(state.name)
  const [adapter, setAdapter] = useState(state.adapter)
  const [baseUrl, setBaseUrl] = useState(state.baseUrl)
  const [apiKey, setApiKey] = useState(state.apiKey)
  const [model, setModel] = useState(state.model)
  const [params, setParams] = useState<Record<string, string>>(state.params)
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const adapterOptions = adapters.filter((a) => a.modality === state.modality)
  const selectedAdapter = adapterOptions.find((a) => a.id === adapter) ?? null

  function setParam(key: string, value: string): void {
    setParams((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!name.trim()) {
      setSaveError('请填写名称')
      return
    }
    if (!adapter) {
      setSaveError('请选择适配器')
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      // 参数里留空的字段不提交，避免空串覆盖 adapter 默认值
      const cleanedParams = Object.fromEntries(
        Object.entries(params).filter(([, value]) => value !== '')
      )
      if (state.mode === 'create') {
        await createMediaProvider({
          name: name.trim(),
          modality: state.modality,
          adapter,
          baseUrl: baseUrl.trim(),
          apiKey,
          model: model.trim(),
          params: cleanedParams
        })
      } else if (state.row) {
        await updateMediaProvider(state.row.id, {
          name: name.trim(),
          adapter,
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          params: cleanedParams,
          // 空 Key 不发送：后端保留旧值（与「留空以保留当前 Key」占位一致）
          ...(apiKey ? { apiKey } : {})
        })
      }
      await onSaved()
      onClose()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {state.mode === 'create' ? '新增' : '编辑'}
            {MODALITY_LABELS[state.modality]}生成 Provider
          </DialogTitle>
        </DialogHeader>
        <form className="grid gap-3.5" onSubmit={handleSubmit}>
          <div className="grid gap-1.5">
            <Label htmlFor="media-form-adapter">适配器</Label>
            <Select value={adapter} onValueChange={setAdapter}>
              <SelectTrigger id="media-form-adapter" className="w-full">
                <SelectValue placeholder="选择适配器..." />
              </SelectTrigger>
              <SelectContent>
                {adapterOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedAdapter && (
              <p className="text-[10px] text-muted-foreground">
                能力：生成{selectedAdapter.capabilities.edit ? ' / 图生图' : ''}
                {selectedAdapter.capabilities.mask === true ? ' / 蒙版重绘' : ''}
                {selectedAdapter.capabilities.analyze ? ' / 反推提示词' : ''}
              </p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="media-form-name">名称</Label>
            <Input
              id="media-form-name"
              placeholder="例如：OpenAI 官方"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="media-form-baseurl">Base URL</Label>
            <Input
              id="media-form-baseurl"
              placeholder="https://api.openai.com/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="media-form-apikey">API Key</Label>
            <div className="flex gap-2">
              <Input
                id="media-form-apikey"
                type={showKey ? 'text' : 'password'}
                placeholder={state.mode === 'edit' ? '留空以保留当前 Key' : 'sk-...'}
                className="flex-1 font-mono"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
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
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="media-form-model">模型</Label>
            <Input
              id="media-form-model"
              placeholder="留空使用适配器默认模型"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </div>

          {/* adapter 特有参数：按 formSchema 动态渲染，值存 params[key] */}
          {selectedAdapter?.formSchema.map((field) => (
            <div key={field.key} className="grid gap-1.5">
              <Label htmlFor={`media-form-param-${field.key}`}>{field.label}</Label>
              {field.type === 'select' ? (
                <Select
                  value={params[field.key] ?? ''}
                  onValueChange={(value) => setParam(field.key, value)}
                >
                  <SelectTrigger id={`media-form-param-${field.key}`} className="w-full">
                    <SelectValue placeholder={`选择${field.label}...`} />
                  </SelectTrigger>
                  <SelectContent>
                    {(field.options ?? []).map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id={`media-form-param-${field.key}`}
                  type={field.type === 'number' ? 'number' : 'text'}
                  placeholder={field.placeholder}
                  value={params[field.key] ?? ''}
                  onChange={(e) => setParam(field.key, e.target.value)}
                />
              )}
            </div>
          ))}

          {saveError && (
            <p className="text-xs text-danger" role="alert">
              {saveError}
            </p>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={saving}>
                取消
              </Button>
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
