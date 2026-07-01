import { useState, type ReactElement } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { BotIcon, PlusIcon, PencilIcon, TrashIcon } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  getAgents,
  createAgent,
  updateAgent,
  deleteAgent,
  type AgentInfo,
} from '@/api/http-client'
import { useSessionStore } from '@/stores/session-store'

/** Agent 选择器属性 */
export interface AgentSelectorProps {
  /** 是否禁用 */
  disabled?: boolean
}

/** 弹窗模式：创建或编辑 */
type DialogMode = 'create' | 'edit'

/** Agent 表单弹窗属性 */
interface AgentFormDialogProps {
  open: boolean
  mode: DialogMode
  agent?: AgentInfo | null
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}

/** Agent 表单弹窗（创建 + 编辑共用） */
function AgentFormDialog({ open, mode, agent, onOpenChange, onSuccess }: AgentFormDialogProps): ReactElement {
  const isEdit = mode === 'edit'
  const [id, setId] = useState(agent?.id ?? '')
  const [name, setName] = useState(agent?.name ?? '')
  const [description, setDescription] = useState(agent?.description ?? '')
  const [modelProvider, setModelProvider] = useState(agent?.model?.provider ?? '')
  const [modelId, setModelId] = useState(agent?.model?.modelId ?? '')
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? '')
  const [error, setError] = useState('')

  const canSubmit = isEdit ? name.trim().length > 0 : id.trim().length > 0 && name.trim().length > 0

  const createMutation = useMutation({
    mutationFn: (agent: AgentInfo) => createAgent(agent),
    onSuccess: () => {
      onSuccess()
      handleClose()
    },
    onError: (err: Error) => setError(err.message),
  })

  const updateMutation = useMutation({
    mutationFn: (patch: Partial<AgentInfo>) => updateAgent(agent!.id, patch),
    onSuccess: () => {
      onSuccess()
      handleClose()
    },
    onError: (err: Error) => setError(err.message),
  })

  function handleClose(): void {
    setId('')
    setName('')
    setDescription('')
    setModelProvider('')
    setModelId('')
    setSystemPrompt('')
    setError('')
    onOpenChange(false)
  }

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault()
    if (!canSubmit) return
    setError('')

    const model = modelProvider.trim() && modelId.trim()
      ? { provider: modelProvider.trim(), modelId: modelId.trim() }
      : undefined

    if (isEdit) {
      updateMutation.mutate({
        name: name.trim(),
        description: description.trim() || undefined,
        model,
        systemPrompt: systemPrompt.trim() || undefined,
      })
    } else {
      createMutation.mutate({
        id: id.trim(),
        name: name.trim(),
        description: description.trim() || undefined,
        model,
        systemPrompt: systemPrompt.trim() || undefined,
      })
    }
  }

  const isPending = createMutation.isPending || updateMutation.isPending

  return (
    <Dialog open={open} onOpenChange={(v) => v ? null : handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? '编辑 Agent' : '添加自定义 Agent'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-3">
          {!isEdit && (
            <div className="grid gap-1.5">
              <Label htmlFor="agent-id" className="text-xs">Agent ID *</Label>
              <Input
                id="agent-id"
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="例如：coder"
                required
              />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="agent-name" className="text-xs">名称 *</Label>
            <Input
              id="agent-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：编程助手"
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="agent-desc" className="text-xs">描述</Label>
            <Input
              id="agent-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Agent 的专长和用途"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="agent-model-provider" className="text-xs">模型 Provider</Label>
              <Input
                id="agent-model-provider"
                value={modelProvider}
                onChange={(e) => setModelProvider(e.target.value)}
                placeholder="openai"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="agent-model-id" className="text-xs">模型 ID</Label>
              <Input
                id="agent-model-id"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                placeholder="gpt-4o"
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="agent-system-prompt" className="text-xs">系统提示词</Label>
            <textarea
              id="agent-system-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="定义 Agent 的角色、能力和约束..."
              rows={4}
              className="w-full bg-surface-3 border border-border rounded-md px-3 py-2 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent/60"
            />
          </div>
          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={handleClose}>
              取消
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit || isPending}>
              {isEdit ? '保存' : '添加'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** 删除确认弹窗 */
function DeleteConfirmDialog({
  open,
  agent,
  onOpenChange,
  onSuccess,
}: {
  open: boolean
  agent: AgentInfo | null
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}): ReactElement {
  const [error, setError] = useState('')
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteAgent(id),
    onSuccess: () => {
      onSuccess()
      onOpenChange(false)
    },
    onError: (err: Error) => setError(err.message),
  })

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) setError(''); onOpenChange(v) }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>删除 Agent</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          确认删除 Agent「{agent?.name}」？此操作不可撤销。
        </p>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={deleteMutation.isPending}
            onClick={() => agent && deleteMutation.mutate(agent.id)}
          >
            {deleteMutation.isPending ? '删除中...' : '删除'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * AgentSelector：Agent 下拉选择器
 *
 * - 从 GET /api/agents 获取可用 Agent 列表
 * - 选择后更新 session-store 的 activeAgentId
 * - 支持创建自定义 Agent（调用后端 API 持久化）
 * - 支持编辑和删除 Agent
 */
export function AgentSelector({ disabled = false }: AgentSelectorProps): ReactElement {
  const queryClient = useQueryClient()
  const activeAgentId = useSessionStore((s) => s.activeAgentId)
  const setActiveAgentId = useSessionStore((s) => s.setActiveAgentId)

  const [formOpen, setFormOpen] = useState(false)
  const [formMode, setFormMode] = useState<DialogMode>('create')
  const [editTarget, setEditTarget] = useState<AgentInfo | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AgentInfo | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)

  // 从后端获取 Agent 列表
  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: () => getAgents(),
    refetchInterval: 30_000,
  })

  const agents = agentsQuery.data ?? []
  const currentAgent = agents.find((a) => a.id === activeAgentId)

  function invalidateAgents(): void {
    queryClient.invalidateQueries({ queryKey: ['agents'] })
  }

  function handleOpenCreate(): void {
    setFormMode('create')
    setEditTarget(null)
    setFormOpen(true)
  }

  function handleOpenEdit(agent: AgentInfo): void {
    setFormMode('edit')
    setEditTarget(agent)
    setFormOpen(true)
  }

  function handleOpenDelete(agent: AgentInfo): void {
    setDeleteTarget(agent)
    setDeleteOpen(true)
  }

  return (
    <div className="flex items-center gap-2">
      <Select
        value={activeAgentId}
        onValueChange={(id) => setActiveAgentId(id)}
        disabled={disabled}
      >
        <SelectTrigger size="sm" className="min-w-[160px] max-w-[240px] h-8">
          <SelectValue placeholder="选择 Agent">
            {currentAgent ? (
              <span className="truncate flex items-center gap-1.5">
                <BotIcon className="size-3.5 shrink-0" />
                <span className="truncate">{currentAgent.name}</span>
              </span>
            ) : (
              <span className="text-muted-foreground truncate">{activeAgentId}</span>
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {agents.length === 0 ? (
            <div className="px-2 py-4 text-center text-xs text-muted-foreground">
              暂无可用 Agent
            </div>
          ) : (
            <SelectGroup>
              <SelectLabel>可用 Agent</SelectLabel>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  <div className="flex items-center gap-1.5 min-w-0 w-full">
                    <span className="truncate flex-1">{agent.name}</span>
                    {agent.id === 'default' && (
                      <Badge variant="secondary" className="px-1 py-0 text-[10px] shrink-0">
                        默认
                      </Badge>
                    )}
                    {agent.id !== 'default' && (
                      <span className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          className="size-7 flex items-center justify-center hover:text-accent rounded"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleOpenEdit(agent)
                          }}
                        >
                          <PencilIcon className="size-3" />
                        </button>
                        <button
                          type="button"
                          className="size-7 flex items-center justify-center hover:text-destructive rounded"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleOpenDelete(agent)
                          }}
                        >
                          <TrashIcon className="size-3" />
                        </button>
                      </span>
                    )}
                  </div>
                </SelectItem>
              ))}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={handleOpenCreate}
        disabled={disabled}
        aria-label="添加自定义 Agent"
      >
        <PlusIcon className="size-3.5" />
      </Button>
      {currentAgent?.description && (
        <span className="text-xs text-muted-foreground truncate max-w-[200px] hidden sm:inline">
          {currentAgent.description}
        </span>
      )}
      <AgentFormDialog
        open={formOpen}
        mode={formMode}
        agent={editTarget}
        onOpenChange={setFormOpen}
        onSuccess={invalidateAgents}
      />
      <DeleteConfirmDialog
        open={deleteOpen}
        agent={deleteTarget}
        onOpenChange={setDeleteOpen}
        onSuccess={invalidateAgents}
      />
    </div>
  )
}
