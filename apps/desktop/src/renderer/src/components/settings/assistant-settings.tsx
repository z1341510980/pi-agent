import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BotIcon,
  PlusIcon,
  EditIcon,
  Trash2Icon,
  SearchIcon,
} from 'lucide-react'
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
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  createAgent,
  updateAgent,
  deleteAgent,
  getApi,
  type AgentInfo,
} from '@/api/http-client'
import { useActiveAgent, type PresetAssistant } from '@/hooks/use-active-agent'
import { BUILTIN_PRESETS } from '@/config/preset-assistants'
import { AgentLogoIcon } from '@/components/chat/agent-logo-icon'
import { SettingsPageHeader, SettingsCard } from './setting-primitives'

// ── 类型定义 ──

/** 后端 GET /api/providers 返回项（仅取需要的字段） */
interface ProviderBrief {
  id: string
  name: string
  models: Array<{ id: string; name: string }>
}

/** 自定义 Assistant 编辑表单值 */
interface AssistantFormValue {
  agentId: string
  name: string
  description: string
  defaultModelProvider: string
  defaultModelId: string
  tools: string
}

// ── 常量 ──

const EMPTY_FORM: AssistantFormValue = {
  agentId: '',
  name: '',
  description: '',
  defaultModelProvider: '',
  defaultModelId: '',
  tools: '',
}

// ── 主组件 ──

export function AssistantSettings(): ReactElement {
  const { allAssistants } = useActiveAgent()
  const [keyword, setKeyword] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingTarget, setEditingTarget] = useState<PresetAssistant | null>(null)
  const [deletingTarget, setDeletingTarget] = useState<PresetAssistant | null>(null)

  // 内置预设的 id 集合（用于判断是否可删）
  const builtinIds = useMemo(() => new Set(Object.keys(BUILTIN_PRESETS)), [])

  // 过滤后的助手列表
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return allAssistants
    return allAssistants.filter((a) => {
      const name = a.name.toLowerCase()
      const desc = a.description?.toLowerCase() ?? ''
      const id = a.agentId.toLowerCase()
      return name.includes(kw) || desc.includes(kw) || id.includes(kw)
    })
  }, [allAssistants, keyword])

  function handleOpenCreate(): void {
    setEditingTarget(null)
    setEditorOpen(true)
  }

  function handleOpenEdit(assistant: PresetAssistant): void {
    setEditingTarget(assistant)
    setEditorOpen(true)
  }

  function handleOpenDelete(assistant: PresetAssistant): void {
    setDeletingTarget(assistant)
  }

  return (
    <section className="grid gap-5 p-6" aria-label="助手管理">
      <SettingsPageHeader
        eyebrow="Assistant"
        title="助手"
        description="管理内置与自定义助手。内置助手不可删除，但可绑定模型与工具；自定义助手可自由创建、编辑、删除。"
        actions={
          <Button variant="default" size="sm" onClick={handleOpenCreate}>
            <PlusIcon className="size-3.5" />
            新建
          </Button>
        }
      />

      {/* ── 搜索栏 ── */}
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索助手名称、描述或 ID…"
          className="pl-9"
          aria-label="搜索助手"
        />
      </div>

      {/* ── 助手列表 ── */}
      <SettingsCard className="p-0">
        {filtered.length === 0 ? (
          <div className="p-8 text-center">
            <BotIcon className="mx-auto size-8 text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground m-0">
              {keyword ? '没有匹配的助手' : '暂无助手'}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border" role="list">
            {filtered.map((assistant) => {
              const isBuiltin = builtinIds.has(assistant.agentId) || assistant.source === 'builtin'
              const sourceLabel = sourceToLabel(assistant.source)
              return (
                <li
                  key={assistant.agentId}
                  className="flex items-center gap-3 p-3 transition-colors hover:bg-surface-2"
                >
                  <div
                    className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-3"
                    aria-hidden
                  >
                    <AgentLogoIcon
                      agentId={assistant.agentId}
                      agentName={assistant.name}
                      icon={assistant.icon}
                      size="md"
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-[760] text-text">{assistant.name}</span>
                      <Badge
                        variant={sourceLabel.variant}
                        className="px-1 py-0 text-[10px]"
                      >
                        {sourceLabel.text}
                      </Badge>
                      <code className="text-[10px] font-mono text-hint">{assistant.agentId}</code>
                    </div>
                    {assistant.description && (
                      <p className="m-0 mt-0.5 truncate text-xs text-hint">{assistant.description}</p>
                    )}
                    {(assistant.defaultModel || (assistant.tools && assistant.tools.length > 0)) && (
                      <p className="m-0 mt-0.5 truncate text-[10px] font-mono text-hint">
                        {assistant.defaultModel && `${assistant.defaultModel.provider}/${assistant.defaultModel.modelId}`}
                        {assistant.defaultModel && assistant.tools && assistant.tools.length > 0 && ' · '}
                        {assistant.tools && assistant.tools.length > 0 && `${assistant.tools.length} 个工具`}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleOpenEdit(assistant)}
                      aria-label={`编辑 ${assistant.name}`}
                    >
                      <EditIcon className="size-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleOpenDelete(assistant)}
                      disabled={isBuiltin}
                      aria-label={isBuiltin ? '内置助手不可删除' : `删除 ${assistant.name}`}
                    >
                      <Trash2Icon className="size-3" />
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </SettingsCard>

      {/* ── 编辑/新建弹窗 ── */}
      <AssistantEditorDialog
        target={editingTarget}
        open={editorOpen}
        onOpenChange={(open) => {
          setEditorOpen(open)
          if (!open) setEditingTarget(null)
        }}
      />

      {/* ── 删除确认弹窗 ── */}
      <AssistantDeleteDialog
        target={deletingTarget}
        onOpenChange={(open) => {
          if (!open) setDeletingTarget(null)
        }}
      />
    </section>
  )
}

// ── 编辑/新建弹窗 ──

interface AssistantEditorDialogProps {
  target: PresetAssistant | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

function AssistantEditorDialog({
  target,
  open,
  onOpenChange,
}: AssistantEditorDialogProps): ReactElement {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<AssistantFormValue>(EMPTY_FORM)
  const [error, setError] = useState<string | null>(null)

  const isEdit = target !== null

  // 获取 provider 列表（用于下拉选择）
  const providersQuery = useQuery({
    queryKey: ['providers-for-assistant'],
    queryFn: () => getApi<ProviderBrief[]>('/api/providers'),
    staleTime: 5 * 60 * 1000,
  })
  const providers = providersQuery.data ?? []
  const availableModels = providers.find((p) => p.id === form.defaultModelProvider)?.models ?? []

  // 当 target 变化时同步表单
  useEffect(() => {
    if (!open) return
    if (target) {
      setForm({
        agentId: target.agentId,
        name: target.name,
        description: target.description ?? '',
        defaultModelProvider: target.defaultModel?.provider ?? '',
        defaultModelId: target.defaultModel?.modelId ?? '',
        tools: (target.tools ?? []).join(', '),
      })
    } else {
      setForm(EMPTY_FORM)
    }
    setError(null)
  }, [target, open])

  // 切换 provider 后，若当前模型不在新 provider 列表中则清空
  useEffect(() => {
    if (
      form.defaultModelId &&
      availableModels.length > 0 &&
      !availableModels.some((m) => m.id === form.defaultModelId)
    ) {
      setForm((prev) => ({ ...prev, defaultModelId: '' }))
    }
  }, [form.defaultModelProvider, form.defaultModelId, availableModels])

  const createMutation = useMutation({
    mutationFn: (agent: AgentInfo) => createAgent(agent),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
      onOpenChange(false)
    },
    onError: (err: Error) => setError(err.message),
  })

  const updateMutation = useMutation({
    mutationFn: (patch: Partial<AgentInfo>) => updateAgent(target!.agentId, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
      onOpenChange(false)
    },
    onError: (err: Error) => setError(err.message),
  })

  const canSubmit = form.agentId.trim().length > 0 && form.name.trim().length > 0

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault()
    if (!canSubmit) return
    setError(null)

    const model =
      form.defaultModelProvider.trim() && form.defaultModelId.trim()
        ? {
            provider: form.defaultModelProvider.trim(),
            modelId: form.defaultModelId.trim(),
          }
        : undefined

    const toolsList = form.tools
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)

    if (isEdit) {
      updateMutation.mutate({
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        model,
        tools: toolsList.length > 0 ? toolsList : undefined,
      })
    } else {
      createMutation.mutate({
        id: form.agentId.trim(),
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        model,
        tools: toolsList.length > 0 ? toolsList : undefined,
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? `编辑助手：${target?.name}` : '新建自定义助手'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-3">
          <div className="grid grid-cols-1 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="assistant-name" className="text-xs">名称 *</Label>
              <Input
                id="assistant-name"
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="例如：编程助手"
                required
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="assistant-agent-id" className="text-xs">Agent ID *</Label>
            <Input
              id="assistant-agent-id"
              value={form.agentId}
              onChange={(e) => setForm((prev) => ({ ...prev, agentId: e.target.value }))}
              placeholder="例如：coder"
              disabled={isEdit}
              required
            />
            {isEdit && (
              <p className="m-0 text-[10px] text-hint">Agent ID 创建后不可修改</p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="assistant-desc" className="text-xs">描述</Label>
            <Input
              id="assistant-desc"
              value={form.description}
              onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
              placeholder="助手的专长与用途"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="assistant-model-provider" className="text-xs">默认 Provider</Label>
              {providersQuery.isLoading ? (
                <p className="m-0 text-xs text-muted-foreground">加载中...</p>
              ) : providers.length === 0 ? (
                <Input
                  id="assistant-model-provider"
                  value={form.defaultModelProvider}
                  onChange={(e) => setForm((prev) => ({ ...prev, defaultModelProvider: e.target.value }))}
                  placeholder="provider id"
                />
              ) : (
                <Select
                  value={form.defaultModelProvider}
                  onValueChange={(v) => setForm((prev) => ({ ...prev, defaultModelProvider: v, defaultModelId: '' }))}
                >
                  <SelectTrigger id="assistant-model-provider" className="w-full">
                    <SelectValue placeholder="选择 Provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name || p.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="assistant-model-id" className="text-xs">默认模型</Label>
              {providersQuery.isLoading ? (
                <p className="m-0 text-xs text-muted-foreground">加载中...</p>
              ) : providers.length === 0 ? (
                <Input
                  id="assistant-model-id"
                  value={form.defaultModelId}
                  onChange={(e) => setForm((prev) => ({ ...prev, defaultModelId: e.target.value }))}
                  placeholder="model id"
                />
              ) : (
                <Select
                  value={form.defaultModelId}
                  onValueChange={(v) => setForm((prev) => ({ ...prev, defaultModelId: v }))}
                  disabled={!form.defaultModelProvider || availableModels.length === 0}
                >
                  <SelectTrigger id="assistant-model-id" className="w-full">
                    <SelectValue
                      placeholder={
                        !form.defaultModelProvider
                          ? '先选 Provider'
                          : availableModels.length === 0
                            ? '无模型'
                            : '选择模型'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {availableModels.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.name || m.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="assistant-tools" className="text-xs">工具（逗号分隔）</Label>
            <Input
              id="assistant-tools"
              value={form.tools}
              onChange={(e) => setForm((prev) => ({ ...prev, tools: e.target.value }))}
              placeholder="例如：read_file, write_file, bash"
            />
            <p className="m-0 text-[10px] text-hint">留空则继承后端默认工具集</p>
          </div>
          {error && <p className="m-0 text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!canSubmit || createMutation.isPending || updateMutation.isPending}
            >
              {createMutation.isPending || updateMutation.isPending
                ? '保存中...'
                : isEdit
                  ? '保存'
                  : '创建'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── 删除确认弹窗 ──

interface AssistantDeleteDialogProps {
  target: PresetAssistant | null
  onOpenChange: (open: boolean) => void
}

function AssistantDeleteDialog({ target, onOpenChange }: AssistantDeleteDialogProps): ReactElement {
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteAgent(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
      setError(null)
      onOpenChange(false)
    },
    onError: (err: Error) => setError(err.message),
  })

  // 当 target 清空时重置错误
  useEffect(() => {
    if (target === null) setError(null)
  }, [target])

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>删除助手</DialogTitle>
        </DialogHeader>
        <p className="m-0 text-sm text-muted-foreground">
          确认删除助手「{target?.name}」？此操作不可撤销。
        </p>
        {error && <p className="m-0 text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={deleteMutation.isPending}
            onClick={() => target && deleteMutation.mutate(target.agentId)}
          >
            {deleteMutation.isPending ? '删除中...' : '删除'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── 工具函数 ──

function sourceToLabel(source: PresetAssistant['source']): { text: string; variant: 'secondary' | 'outline' | 'default' } {
  switch (source) {
    case 'builtin':
      return { text: '内置', variant: 'secondary' }
    case 'custom':
      return { text: '自定义', variant: 'outline' }
    case 'plugin':
      return { text: '插件', variant: 'default' }
    default:
      return { text: source, variant: 'secondary' }
  }
}
