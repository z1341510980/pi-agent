import { useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BotIcon, PlusIcon } from 'lucide-react'
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
import { getAgents, type AgentInfo } from '@/api/http-client'
import { useSessionStore } from '@/stores/session-store'

/** Agent 选择器属性 */
export interface AgentSelectorProps {
  /** 是否禁用 */
  disabled?: boolean
}

/** 添加自定义 Agent 弹窗属性 */
interface AddAgentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdd: (agent: AgentInfo) => void
}

/** 添加自定义 Agent 弹窗 */
function AddAgentDialog({ open, onOpenChange, onAdd }: AddAgentDialogProps): ReactElement {
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [modelProvider, setModelProvider] = useState('')
  const [modelId, setModelId] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')

  const canSubmit = id.trim() && name.trim()

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault()
    if (!canSubmit) return
    onAdd({
      id: id.trim(),
      name: name.trim(),
      description: description.trim() || undefined,
      model: modelProvider.trim() && modelId.trim()
        ? { provider: modelProvider.trim(), modelId: modelId.trim() }
        : undefined,
      systemPrompt: systemPrompt.trim() || undefined,
    })
    // 重置表单
    setId('')
    setName('')
    setDescription('')
    setModelProvider('')
    setModelId('')
    setSystemPrompt('')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>添加自定义 Agent</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-3">
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
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit}>
              <PlusIcon className="size-3.5" />
              添加
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * AgentSelector：Agent 下拉选择器
 *
 * - 从 GET /api/agents 获取可用 Agent 列表
 * - 选择后更新 session-store 的 activeAgentId
 * - 显示当前 Agent 名称和描述
 * - 支持添加自定义 Agent（弹窗表单）
 */
export function AgentSelector({ disabled = false }: AgentSelectorProps): ReactElement {
  const activeAgentId = useSessionStore((s) => s.activeAgentId)
  const setActiveAgentId = useSessionStore((s) => s.setActiveAgentId)
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  // 本地自定义 Agent 列表（后端可能尚未注册）
  const [localAgents, setLocalAgents] = useState<AgentInfo[]>([])

  // 从后端获取 Agent 列表
  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: () => getAgents(),
    refetchInterval: 30_000,
  })

  // 合并后端和本地 Agent
  const allAgents = [
    ...(agentsQuery.data ?? []),
    ...localAgents.filter(
      (local) => !(agentsQuery.data ?? []).some((a) => a.id === local.id),
    ),
  ]

  const currentAgent = allAgents.find((a) => a.id === activeAgentId)

  function handleAddAgent(agent: AgentInfo): void {
    setLocalAgents((prev) => [...prev, agent])
    // 自动选中新添加的 Agent
    setActiveAgentId(agent.id)
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
          {allAgents.length === 0 ? (
            <div className="px-2 py-4 text-center text-xs text-muted-foreground">
              暂无可用 Agent
            </div>
          ) : (
            <SelectGroup>
              <SelectLabel>可用 Agent</SelectLabel>
              {allAgents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="truncate">{agent.name}</span>
                    {agent.id === 'default' && (
                      <Badge variant="secondary" className="px-1 py-0 text-[10px] shrink-0">
                        默认
                      </Badge>
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
        onClick={() => setAddDialogOpen(true)}
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
      <AddAgentDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        onAdd={handleAddAgent}
      />
    </div>
  )
}
