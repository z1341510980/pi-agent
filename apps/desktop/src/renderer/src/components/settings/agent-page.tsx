import { useEffect, useState, type ReactElement } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  BotIcon, SaveIcon, RotateCcwIcon, SparklesIcon, PlusIcon,
  EditIcon, Trash2Icon, XIcon, CircleDotIcon, SendIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  getAgents,
  getLimiterStats,
  dispatchSubtask,
  createAgent,
  updateAgent,
  deleteAgent,
  type AgentInfo,
  type DispatchResult,
} from '@/api/http-client'
import {
  getNovelAgentConfig,
  updateNovelAgentConfig,
  type NovelAgentType,
} from '@/api/novel-agent-config-client'

// ── 类型定义 ──

interface AgentConfig {
  systemPrompt: string
  temperature: number
}

/** 自定义人格模板 */
interface PersonaTemplate {
  id: string
  label: string
  desc: string
  prompt: string
  createdAt: number
}

/** subagent 派遣历史记录 */
interface DispatchHistoryEntry {
  id: string
  agentId: string
  task: string
  result?: DispatchResult
  status: 'pending' | 'running' | 'completed' | 'failed'
  timestamp: number
}

// ── 常量 ──

const configStorageKey = 'wenlang-agent.agent-config'
const templatesStorageKey = 'wenlang-agent.persona-templates'
const dispatchHistoryKey = 'wenlang-agent.dispatch-history'

const defaultConfig: AgentConfig = {
  systemPrompt: '',
  temperature: 0.7,
}

// 内置预设模板（不可编辑/删除）
const builtinPresets: Array<{ id: string; label: string; desc: string; prompt: string }> = [
  {
    id: 'default',
    label: '默认助手',
    desc: '通用对话助手，简洁专业地回答问题',
    prompt: '你是一个专业、简洁的 AI 助手。请用清晰的中文回答用户问题，必要时使用 Markdown 格式化输出。',
  },
  {
    id: 'coding',
    label: '编程专家',
    desc: '专注于代码生成、调试和架构设计',
    prompt: '你是一个资深软件工程师。专注于代码质量、系统架构和最佳实践。回答时优先给出可运行的代码示例，并解释关键设计决策。',
  },
  {
    id: 'analyst',
    label: '数据分析师',
    desc: '擅长数据分析、可视化和洞察提取',
    prompt: '你是一个数据分析师专家。擅长从数据中提取洞察、设计分析框架并用清晰的可视化呈现结论。回答时注重逻辑性和数据支撑。',
  },
  {
    id: 'writer',
    label: '技术写作',
    desc: '擅长文档撰写、技术博客和知识整理',
    prompt: '你是一个技术写作专家。擅长将复杂概念用通俗易懂的语言表达，注重结构清晰、示例恰当和读者体验。',
  },
]

// ── 主组件 ──

export function AgentPage(): ReactElement {
  const [config, setConfig] = useState<AgentConfig>(() => loadConfig())
  const [savedConfig, setSavedConfig] = useState<AgentConfig>(() => loadConfig())
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  // 自定义人格模板
  const [customTemplates, setCustomTemplates] = useState<PersonaTemplate[]>(() => loadTemplates())
  // 当前编辑的模板（null 表示未编辑）
  const [editingTemplate, setEditingTemplate] = useState<PersonaTemplate | null>(null)
  const [showTemplateEditor, setShowTemplateEditor] = useState(false)
  // Agent 编辑弹窗
  const [editingAgent, setEditingAgent] = useState<AgentInfo | null>(null)
  const [agentEditorOpen, setAgentEditorOpen] = useState(false)
  // Agent 创建弹窗
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  // Agent 删除确认弹窗
  const [deletingAgent, setDeletingAgent] = useState<AgentInfo | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  // 派遣弹窗
  const [dispatchAgentId, setDispatchAgentId] = useState<string | null>(null)
  const [dispatchTask, setDispatchTask] = useState('')
  const [dispatchLoading, setDispatchLoading] = useState(false)
  // 派遣历史
  const [dispatchHistory, setDispatchHistory] = useState<DispatchHistoryEntry[]>(() => loadDispatchHistory())

  // 从后端获取 Agent 列表
  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: () => getAgents(),
    refetchInterval: 15_000,
  })

  // 并发限流器状态
  const limiterQuery = useQuery({
    queryKey: ['limiter-stats'],
    queryFn: () => getLimiterStats(),
    refetchInterval: 10_000,
  })

  const agents = agentsQuery.data ?? []
  const limiter = limiterQuery.data

  const dirty =
    config.systemPrompt !== savedConfig.systemPrompt ||
    config.temperature !== savedConfig.temperature

  useEffect(() => {
    if (!saveMsg) return
    const t = window.setTimeout(() => setSaveMsg(null), 2500)
    return () => window.clearTimeout(t)
  }, [saveMsg])

  function handleSave(): void {
    saveConfig(config)
    setSavedConfig(config)
    setSaveMsg('Agent 配置已保存')
  }

  function handleReset(): void {
    setConfig(defaultConfig)
    saveConfig(defaultConfig)
    setSavedConfig(defaultConfig)
    setSaveMsg('已重置为默认配置')
  }

  function applyPreset(prompt: string): void {
    setConfig((prev) => ({ ...prev, systemPrompt: prompt }))
  }

  // 添加自定义模板
  function handleAddTemplate(template: PersonaTemplate): void {
    setCustomTemplates((prev) => {
      const next = [...prev, template]
      saveTemplates(next)
      return next
    })
    setShowTemplateEditor(false)
    setEditingTemplate(null)
  }

  // 更新自定义模板
  function handleUpdateTemplate(template: PersonaTemplate): void {
    setCustomTemplates((prev) => {
      const next = prev.map((t) => (t.id === template.id ? template : t))
      saveTemplates(next)
      return next
    })
    setShowTemplateEditor(false)
    setEditingTemplate(null)
  }

  // 删除自定义模板
  function handleDeleteTemplate(id: string): void {
    setCustomTemplates((prev) => {
      const next = prev.filter((t) => t.id !== id)
      saveTemplates(next)
      return next
    })
  }

  // 打开编辑器（新建）
  function handleNewTemplate(): void {
    setEditingTemplate(null)
    setShowTemplateEditor(true)
  }

  // 打开编辑器（编辑现有）
  function handleEditTemplate(template: PersonaTemplate): void {
    setEditingTemplate(template)
    setShowTemplateEditor(true)
  }

  // 编辑 Agent
  function handleEditAgent(agent: AgentInfo): void {
    setEditingAgent(agent)
    setAgentEditorOpen(true)
  }

  // 删除 Agent
  function handleDeleteAgent(agent: AgentInfo): void {
    setDeletingAgent(agent)
    setDeleteDialogOpen(true)
  }

  // 派遣子任务
  async function handleDispatch(): Promise<void> {
    if (!dispatchAgentId || !dispatchTask.trim()) return
    const entryId = `dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const entry: DispatchHistoryEntry = {
      id: entryId,
      agentId: dispatchAgentId,
      task: dispatchTask.trim(),
      status: 'running',
      timestamp: Date.now(),
    }
    setDispatchHistory((prev) => {
      const next = [entry, ...prev].slice(0, 50)
      saveDispatchHistory(next)
      return next
    })
    setDispatchLoading(true)
    try {
      const result = await dispatchSubtask(dispatchAgentId, dispatchTask.trim())
      setDispatchHistory((prev) => {
        const next = prev.map((e) =>
          e.id === entryId
            ? { ...e, status: 'completed' as const, result }
            : e,
        )
        saveDispatchHistory(next)
        return next
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : '派遣失败'
      setDispatchHistory((prev) => {
        const next = prev.map((e) =>
          e.id === entryId
            ? {
                ...e,
                status: 'failed' as const,
                result: {
                  agentId: dispatchAgentId,
                  task: dispatchTask.trim(),
                  result: '',
                  success: false,
                  error: message,
                  durationMs: 0,
                  depth: 0,
                },
              }
            : e,
        )
        saveDispatchHistory(next)
        return next
      })
    } finally {
      setDispatchLoading(false)
      setDispatchAgentId(null)
      setDispatchTask('')
    }
  }

  return (
    <section className="p-6 grid gap-5" aria-label="Agent 管理">
      <div>
        <p className="text-subtle text-xs font-[760] m-0">Agent</p>
        <h2 className="text-[22px] font-[780] leading-tight mt-0.5">Agent 管理</h2>
      </div>

      {saveMsg && (
        <div className="bg-success/10 border border-success/30 text-success rounded-lg p-3 text-sm">
          {saveMsg}
        </div>
      )}

      {/* ── Agent 列表 ── */}
      <div className="bg-surface-2 border border-border rounded-lg p-4 grid gap-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <BotIcon className="size-4 text-muted-foreground" />
            <Label>已注册 Agent</Label>
          </div>
          <div className="flex items-center gap-2">
            {limiter && (
              <span className="tabular-nums text-xs text-muted-foreground font-mono">
                并发 {limiter.activeCount}/{limiter.totalCount} · 队列 {limiter.queueLength}
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCreateDialogOpen(true)}
            >
              <PlusIcon className="size-3.5" />
              新建
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void agentsQuery.refetch()}
              disabled={agentsQuery.isFetching}
            >
              刷新
            </Button>
          </div>
        </div>

        {agentsQuery.isLoading ? (
          <p className="text-xs text-muted-foreground m-0">加载中...</p>
        ) : agents.length === 0 ? (
          <p className="text-xs text-muted-foreground m-0">暂无已注册 Agent</p>
        ) : (
          <div className="grid gap-2">
            {agents.map((agent) => (
              <div
                key={agent.id}
                className="flex items-center gap-3 p-3 rounded-lg border border-border bg-surface-3"
              >
                <div className="size-8 rounded-lg bg-accent text-accent-foreground flex items-center justify-center shrink-0">
                  <BotIcon className="size-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-[760] truncate">{agent.name}</span>
                    <code className="text-[10px] text-muted-foreground font-mono">{agent.id}</code>
                    {agent.id === 'default' && (
                      <Badge variant="secondary" className="px-1 py-0 text-[10px]">默认</Badge>
                    )}
                    {/* 在线状态指示 */}
                    <span
                      className="shrink-0 size-[7px] rounded-full bg-success shadow-[0_0_0_3px_rgba(47,209,124,0.16)]"
                      aria-label="在线"
                    />
                  </div>
                  {agent.description && (
                    <p className="text-xs text-muted-foreground m-0 mt-0.5 truncate">{agent.description}</p>
                  )}
                  {agent.model && (
                    <p className="text-[10px] text-muted-foreground font-mono m-0 mt-0.5">
                      {agent.model.provider}/{agent.model.modelId}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => handleEditAgent(agent)}
                    aria-label={`编辑 ${agent.name}`}
                  >
                    <EditIcon className="size-3" />
                  </Button>
                  {agent.id !== 'default' && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleDeleteAgent(agent)}
                      aria-label={`删除 ${agent.name}`}
                    >
                      <Trash2Icon className="size-3" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => {
                      setDispatchAgentId(agent.id)
                      setDispatchTask('')
                    }}
                    aria-label={`派遣任务给 ${agent.name}`}
                  >
                    <SendIcon className="size-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── 派遣历史 ── */}
      {dispatchHistory.length > 0 && (
        <div className="bg-surface-2 border border-border rounded-lg p-4 grid gap-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <CircleDotIcon className="size-4 text-muted-foreground" />
              <Label>派遣历史</Label>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDispatchHistory([])
                saveDispatchHistory([])
              }}
            >
              清空
            </Button>
          </div>
          <div className="grid gap-2 max-h-[300px] overflow-y-auto">
            {dispatchHistory.map((entry) => (
              <DispatchHistoryCard key={entry.id} entry={entry} />
            ))}
          </div>
        </div>
      )}

      {/* ── Agent 信息（默认） ── */}
      <div className="bg-surface-2 border border-border rounded-lg p-4 flex items-center gap-3">
        <div className="size-10 rounded-lg bg-accent text-accent-foreground flex items-center justify-center shrink-0">
          <BotIcon className="size-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-[780]">Default Agent</span>
            <Badge variant="secondary">内置</Badge>
          </div>
          <p className="text-xs text-muted-foreground m-0 mt-0.5">基于 Pi SDK 的通用 Agent，支持工具调用和流式响应</p>
        </div>
      </div>

      {/* ── 人格模板 ── */}
      <div className="bg-surface-2 border border-border rounded-lg p-4 grid gap-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <SparklesIcon className="size-4 text-muted-foreground" />
            <Label>人格模板</Label>
          </div>
          <Button variant="outline" size="sm" onClick={handleNewTemplate}>
            <PlusIcon className="size-3.5" />
            新建模板
          </Button>
        </div>
        <p className="text-xs text-muted-foreground m-0">选择预设模板快速设置 System Prompt，支持自定义模板</p>

        {/* 内置模板 */}
        <div className="grid grid-cols-2 gap-2">
          {builtinPresets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => applyPreset(preset.prompt)}
              className="flex flex-col gap-1 p-3 rounded-lg border border-border bg-surface-3 hover:bg-surface-3/70 text-left transition-colors active:scale-[0.96] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-[760]">{preset.label}</span>
                <Badge variant="secondary" className="px-1 py-0 text-[10px]">内置</Badge>
              </div>
              <span className="text-xs text-muted-foreground">{preset.desc}</span>
            </button>
          ))}
        </div>

        {/* 自定义模板 */}
        {customTemplates.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            {customTemplates.map((template) => (
              <div
                key={template.id}
                className="flex flex-col gap-1 p-3 rounded-lg border border-border bg-surface-3"
              >
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <button
                      type="button"
                      onClick={() => applyPreset(template.prompt)}
                      className="text-sm font-[760] truncate text-left hover:text-accent transition-colors"
                    >
                      {template.label}
                    </button>
                    <Badge variant="outline" className="shrink-0 px-1 py-0 text-[10px]">自定义</Badge>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      type="button"
                      className="rounded p-1 text-muted-foreground hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      onClick={() => handleEditTemplate(template)}
                      aria-label={`编辑模板 ${template.label}`}
                    >
                      <EditIcon className="size-3" />
                    </button>
                    <button
                      type="button"
                      className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      onClick={() => handleDeleteTemplate(template.id)}
                      aria-label={`删除模板 ${template.label}`}
                    >
                      <Trash2Icon className="size-3" />
                    </button>
                  </div>
                </div>
                <span className="text-xs text-muted-foreground">{template.desc}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── 人格模板编辑器 ── */}
      {showTemplateEditor && (
        <PersonaTemplateEditor
          template={editingTemplate}
          onSave={(template) => {
            if (editingTemplate) {
              handleUpdateTemplate(template)
            } else {
              handleAddTemplate(template)
            }
          }}
          onCancel={() => {
            setShowTemplateEditor(false)
            setEditingTemplate(null)
          }}
        />
      )}

      {/* ── System Prompt ── */}
      <div className="bg-surface-2 border border-border rounded-lg p-4 grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="system-prompt">System Prompt</Label>
          <span className="text-xs text-muted-foreground">{config.systemPrompt.length} 字符</span>
        </div>
        <textarea
          id="system-prompt"
          value={config.systemPrompt}
          onChange={(e) => setConfig((prev) => ({ ...prev, systemPrompt: e.target.value }))}
          placeholder="输入 Agent 的系统提示词，定义其角色、能力和约束..."
          rows={8}
          className="w-full bg-surface-3 border border-border rounded-md px-3 py-2 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent/60"
        />
        <p className="text-xs text-muted-foreground m-0">
          此 Prompt 将作为 Agent 对话的 System Message（仅本地存储，后端集成即将上线）
        </p>
      </div>

      {/* ── 全局默认温度 ── */}
      <div className="bg-surface-2 border border-border rounded-lg p-4 grid gap-3">
        <div>
          <h3 className="text-sm font-medium">全局默认温度</h3>
          <p className="text-xs text-muted-foreground mt-1">
            新建 Agent 时的默认温度值。各 Agent 可在编辑弹窗中单独覆盖。
          </p>
        </div>

        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="temperature" className="text-xs">Temperature</Label>
            <span className="tabular-nums text-xs font-mono text-muted-foreground">{config.temperature.toFixed(2)}</span>
          </div>
          <input
            id="temperature"
            type="range"
            min="0"
            max="2"
            step="0.05"
            value={config.temperature}
            onChange={(e) => setConfig((prev) => ({ ...prev, temperature: Number(e.target.value) }))}
            className="w-full accent-accent"
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>精确 (0)</span>
            <span>平衡 (0.7)</span>
            <span>创造 (2)</span>
          </div>
        </div>

        <p className="text-xs text-muted-foreground m-0">
          Max Tokens 由模型配置决定，可在「模型管理」或「Provider 管理」中设置
        </p>
      </div>

      {/* ── 操作按钮 ── */}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={handleReset} disabled={!dirty && config.systemPrompt === ''}>
          <RotateCcwIcon className="size-3.5" />
          重置
        </Button>
        <Button variant="default" size="sm" onClick={handleSave} disabled={!dirty}>
          <SaveIcon className="size-3.5" />
          保存配置
        </Button>
      </div>

      {/* ── 小说创作角色温度 ── */}
      <NovelAgentTemperatureSection />

      {/* ── Agent 编辑弹窗 ── */}
      <AgentEditorDialog
        agent={editingAgent}
        open={agentEditorOpen}
        onOpenChange={(open) => {
          setAgentEditorOpen(open)
          if (!open) setEditingAgent(null)
        }}
        onSave={() => {
          setAgentEditorOpen(false)
          setEditingAgent(null)
        }}
      />

      {/* ── Agent 创建弹窗 ── */}
      <AgentCreateDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onSuccess={() => {}}
      />

      {/* ── Agent 删除确认弹窗 ── */}
      <AgentDeleteDialog
        agent={deletingAgent}
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onSuccess={() => setDeletingAgent(null)}
      />

      {/* ── 派遣任务弹窗 ── */}
      <Dialog
        open={dispatchAgentId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDispatchAgentId(null)
            setDispatchTask('')
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>派遣子任务给 {dispatchAgentId}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="dispatch-task" className="text-xs">任务描述</Label>
              <textarea
                id="dispatch-task"
                value={dispatchTask}
                onChange={(e) => setDispatchTask(e.target.value)}
                placeholder="描述要派遣给该 Agent 的任务..."
                rows={4}
                className="w-full bg-surface-3 border border-border rounded-md px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent/60"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDispatchAgentId(null)
                setDispatchTask('')
              }}
            >
              取消
            </Button>
            <Button
              size="sm"
              disabled={!dispatchTask.trim() || dispatchLoading}
              onClick={() => void handleDispatch()}
            >
              <SendIcon className="size-3.5" />
              {dispatchLoading ? '派遣中...' : '派遣'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

// ── 派遣历史卡片 ──

function DispatchHistoryCard({ entry }: { entry: DispatchHistoryEntry }): ReactElement {
  const [expanded, setExpanded] = useState(false)

  const statusMeta: Record<DispatchHistoryEntry['status'], { label: string; dotClass: string; badgeVariant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
    pending: { label: '等待', dotClass: 'bg-accent shadow-[0_0_0_3px_rgba(242,193,78,0.16)]', badgeVariant: 'secondary' },
    running: { label: '运行中', dotClass: 'bg-accent shadow-[0_0_0_3px_rgba(242,193,78,0.16)] animate-pulse', badgeVariant: 'default' },
    completed: { label: '完成', dotClass: 'bg-success shadow-[0_0_0_3px_rgba(47,209,124,0.16)]', badgeVariant: 'outline' },
    failed: { label: '失败', dotClass: 'bg-danger shadow-[0_0_0_3px_rgba(255,107,107,0.16)]', badgeVariant: 'destructive' },
  }

  const meta = statusMeta[entry.status]

  return (
    <article className="bg-surface-3 border border-border rounded-lg px-3 py-2.5 grid gap-1.5">
      <header className="flex items-center gap-2 min-w-0">
        <span className={`shrink-0 size-[7px] rounded-full ${meta.dotClass}`} />
        <code className="text-xs font-mono font-[760] truncate">{entry.agentId}</code>
        <Badge variant={meta.badgeVariant} className="ml-auto shrink-0 text-[10px] px-1 py-0">
          {meta.label}
        </Badge>
      </header>
      <p className="text-xs text-muted-foreground m-0 truncate">{entry.task}</p>
      <footer className="flex items-center gap-2 text-subtle text-[10px] font-mono">
        <time>{new Date(entry.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}</time>
        {entry.result?.durationMs != null && entry.result.durationMs > 0 && (
          <span>· {entry.result.durationMs < 1000 ? `${entry.result.durationMs}ms` : `${(entry.result.durationMs / 1000).toFixed(1)}s`}</span>
        )}
        {entry.result && (
          <button
            type="button"
            className="text-accent hover:underline ml-auto"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? '收起' : '详情'}
          </button>
        )}
      </footer>
      {expanded && entry.result && (
        <div className="mt-1 p-2 rounded bg-surface-2 border border-border text-xs font-mono whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto">
          {entry.result.success ? entry.result.result : `错误: ${entry.result.error ?? '未知错误'}`}
        </div>
      )}
    </article>
  )
}

// ── Agent 编辑弹窗 ──

interface AgentEditorDialogProps {
  agent: AgentInfo | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: () => void
}

function AgentEditorDialog({ agent, open, onOpenChange, onSave }: AgentEditorDialogProps): ReactElement {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [modelProvider, setModelProvider] = useState('')
  const [modelId, setModelId] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [temperature, setTemperature] = useState(0.7)
  const [error, setError] = useState('')

  // 当 agent 变化时重置表单
  useEffect(() => {
    if (agent) {
      setName(agent.name)
      setDescription(agent.description ?? '')
      setModelProvider(agent.model?.provider ?? '')
      setModelId(agent.model?.modelId ?? '')
      setSystemPrompt(agent.systemPrompt ?? '')
      setTemperature(agent.temperature ?? 0.7)
      setError('')
    }
  }, [agent])

  const canSubmit = name.trim().length > 0

  const updateMutation = useMutation({
    mutationFn: (patch: Partial<AgentInfo>) => updateAgent(agent!.id, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
      onSave()
      onOpenChange(false)
    },
    onError: (err: Error) => setError(err.message),
  })

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault()
    if (!canSubmit || !agent) return
    setError('')
    const model = modelProvider.trim() && modelId.trim()
      ? { provider: modelProvider.trim(), modelId: modelId.trim() }
      : undefined
    updateMutation.mutate({
      name: name.trim(),
      description: description.trim() || undefined,
      model,
      systemPrompt: systemPrompt.trim() || undefined,
      temperature,
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>编辑 Agent: {agent?.id}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="edit-agent-name" className="text-xs">名称 *</Label>
            <Input
              id="edit-agent-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-agent-desc" className="text-xs">描述</Label>
            <Input
              id="edit-agent-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="edit-agent-model-provider" className="text-xs">模型 Provider</Label>
              <Input
                id="edit-agent-model-provider"
                value={modelProvider}
                onChange={(e) => setModelProvider(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-agent-model-id" className="text-xs">模型 ID</Label>
              <Input
                id="edit-agent-model-id"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-agent-system-prompt" className="text-xs">系统提示词</Label>
            <textarea
              id="edit-agent-system-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={4}
              className="w-full bg-surface-3 border border-border rounded-md px-3 py-2 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent/60"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-agent-temperature" className="text-xs">
              温度: {temperature.toFixed(2)}
            </Label>
            <input
              id="edit-agent-temperature"
              type="range"
              min="0"
              max="2"
              step="0.05"
              value={temperature}
              onChange={(e) => setTemperature(Number(e.target.value))}
              className="w-full accent-accent"
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit || updateMutation.isPending}>
              <SaveIcon className="size-3.5" />
              {updateMutation.isPending ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── Agent 创建弹窗 ──

/** 从 localStorage 读取全局默认温度 */
function readDefaultTemperature(): number {
  try {
    const saved = window.localStorage.getItem('wenlang-agent.agent-config')
    if (saved) {
      const parsed = JSON.parse(saved) as { temperature?: number }
      if (typeof parsed.temperature === 'number') return parsed.temperature
    }
  } catch { /* ignore */ }
  return 0.7
}

interface AgentCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}

function AgentCreateDialog({ open, onOpenChange, onSuccess }: AgentCreateDialogProps): ReactElement {
  const queryClient = useQueryClient()
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [modelProvider, setModelProvider] = useState('')
  const [modelId, setModelId] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [temperature, setTemperature] = useState(() => readDefaultTemperature())
  const [error, setError] = useState('')

  const canSubmit = id.trim().length > 0 && name.trim().length > 0

  const createMutation = useMutation({
    mutationFn: (agent: AgentInfo) => createAgent(agent),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
      handleReset()
      onSuccess()
      onOpenChange(false)
    },
    onError: (err: Error) => setError(err.message),
  })

  function handleReset(): void {
    setId('')
    setName('')
    setDescription('')
    setModelProvider('')
    setModelId('')
    setSystemPrompt('')
    setTemperature(readDefaultTemperature())
    setError('')
  }

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault()
    if (!canSubmit) return
    setError('')
    const model = modelProvider.trim() && modelId.trim()
      ? { provider: modelProvider.trim(), modelId: modelId.trim() }
      : undefined
    createMutation.mutate({
      id: id.trim(),
      name: name.trim(),
      description: description.trim() || undefined,
      model,
      systemPrompt: systemPrompt.trim() || undefined,
      temperature,
    })
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleReset(); onOpenChange(v) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建自定义 Agent</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="create-agent-id" className="text-xs">Agent ID *</Label>
            <Input
              id="create-agent-id"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="例如：coder"
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="create-agent-name" className="text-xs">名称 *</Label>
            <Input
              id="create-agent-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：编程助手"
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="create-agent-desc" className="text-xs">描述</Label>
            <Input
              id="create-agent-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Agent 的专长和用途"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="create-agent-model-provider" className="text-xs">模型 Provider</Label>
              <Input
                id="create-agent-model-provider"
                value={modelProvider}
                onChange={(e) => setModelProvider(e.target.value)}
                placeholder="openai"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="create-agent-model-id" className="text-xs">模型 ID</Label>
              <Input
                id="create-agent-model-id"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                placeholder="gpt-4o"
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="create-agent-system-prompt" className="text-xs">系统提示词</Label>
            <textarea
              id="create-agent-system-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="定义 Agent 的角色、能力和约束..."
              rows={4}
              className="w-full bg-surface-3 border border-border rounded-md px-3 py-2 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent/60"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="create-agent-temperature" className="text-xs">
              温度: {temperature.toFixed(2)}
            </Label>
            <input
              id="create-agent-temperature"
              type="range"
              min="0"
              max="2"
              step="0.05"
              value={temperature}
              onChange={(e) => setTemperature(Number(e.target.value))}
              className="w-full accent-accent"
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit || createMutation.isPending}>
              <PlusIcon className="size-3.5" />
              {createMutation.isPending ? '创建中...' : '创建'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── Agent 删除确认弹窗 ──

interface AgentDeleteDialogProps {
  agent: AgentInfo | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}

function AgentDeleteDialog({ agent, open, onOpenChange, onSuccess }: AgentDeleteDialogProps): ReactElement {
  const queryClient = useQueryClient()
  const [error, setError] = useState('')

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteAgent(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
      setError('')
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
        <p className="text-sm text-muted-foreground m-0">
          确认删除 Agent「{agent?.name}」？此操作不可撤销。
        </p>
        {error && <p className="text-xs text-destructive m-0">{error}</p>}
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
            <Trash2Icon className="size-3.5" />
            {deleteMutation.isPending ? '删除中...' : '删除'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── 人格模板编辑器 ──

interface PersonaTemplateEditorProps {
  template: PersonaTemplate | null
  onSave: (template: PersonaTemplate) => void
  onCancel: () => void
}

function PersonaTemplateEditor({ template, onSave, onCancel }: PersonaTemplateEditorProps): ReactElement {
  const [label, setLabel] = useState(template?.label ?? '')
  const [desc, setDesc] = useState(template?.desc ?? '')
  const [prompt, setPrompt] = useState(template?.prompt ?? '')

  const canSubmit = label.trim() && prompt.trim()

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault()
    if (!canSubmit) return
    onSave({
      id: template?.id ?? `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      label: label.trim(),
      desc: desc.trim() || '自定义模板',
      prompt: prompt.trim(),
      createdAt: template?.createdAt ?? Date.now(),
    })
  }

  return (
    <form
      className="bg-surface-2 border border-border rounded-lg p-4 grid gap-3"
      onSubmit={handleSubmit}
      aria-label={template ? '编辑人格模板' : '新建人格模板'}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-[780]">{template ? '编辑模板' : '新建模板'}</span>
        <button
          type="button"
          className="relative rounded p-1 text-muted-foreground hover:bg-surface-3 before:absolute before:-inset-[10px] before:content-[''] active:scale-[0.96] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={onCancel}
          aria-label="取消"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="tpl-label" className="text-xs">模板名称 *</Label>
        <input
          id="tpl-label"
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="例如：产品经理"
          className="bg-surface-3 border border-border rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent/60"
          required
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="tpl-desc" className="text-xs">描述（可选）</Label>
        <input
          id="tpl-desc"
          type="text"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="简要描述模板用途"
          className="bg-surface-3 border border-border rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent/60"
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="tpl-prompt" className="text-xs">System Prompt *</Label>
        <textarea
          id="tpl-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="输入该模板对应的 System Prompt..."
          rows={6}
          className="bg-surface-3 border border-border rounded-md px-3 py-2 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent/60"
          required
        />
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" size="sm" disabled={!canSubmit}>
          <SaveIcon className="size-3.5" />
          {template ? '保存' : '创建'}
        </Button>
      </div>
    </form>
  )
}

// ── 小说创作角色温度配置 ──

const NOVEL_AGENT_LABELS: Record<NovelAgentType, string> = {
  director: '导演 Agent（规划稳定）',
  writer: '写作 Agent（创作发散）',
  reviewer: '审稿 Agent（审稿严谨）',
  memory: '记忆 Agent（沉淀确定）',
}

function NovelAgentTemperatureSection(): ReactElement {
  const queryClient = useQueryClient()
  const [temps, setTemps] = useState<Record<NovelAgentType, number>>({
    director: 0.5,
    writer: 0.9,
    reviewer: 0.3,
    memory: 0.2,
  })

  const { data } = useQuery({
    queryKey: ['novel-agent-config'],
    queryFn: getNovelAgentConfig,
  })

  useEffect(() => {
    if (data) {
      const next = { director: 0.5, writer: 0.9, reviewer: 0.3, memory: 0.2 }
      for (const item of data) {
        next[item.agentType] = item.temperature
      }
      setTemps(next)
    }
  }, [data])

  const updateMutation = useMutation({
    mutationFn: (items: Array<{ agentType: NovelAgentType; temperature: number }>) =>
      updateNovelAgentConfig(items),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['novel-agent-config'] })
    },
  })

  function handleChange(agentType: NovelAgentType, value: number): void {
    setTemps((prev) => ({ ...prev, [agentType]: value }))
  }

  function handleSave(): void {
    const items = (Object.entries(temps) as Array<[NovelAgentType, number]>).map(
      ([agentType, temperature]) => ({ agentType, temperature }),
    )
    updateMutation.mutate(items)
  }

  return (
    <div className="rounded-lg border border-border bg-surface-2 p-4 space-y-4">
      <div>
        <h3 className="text-sm font-medium">小说创作角色温度</h3>
        <p className="text-xs text-muted-foreground mt-1">
          为 4 个创作角色独立配置 LLM 温度，影响生成结果的发散性与稳定性。
        </p>
      </div>
      <div className="space-y-3">
        {(Object.keys(NOVEL_AGENT_LABELS) as NovelAgentType[]).map((agentType) => (
          <div key={agentType} className="grid gap-1.5">
            <Label className="text-xs">
              {NOVEL_AGENT_LABELS[agentType]}: {temps[agentType].toFixed(2)}
            </Label>
            <input
              type="range"
              min="0"
              max="2"
              step="0.05"
              value={temps[agentType]}
              onChange={(e) => handleChange(agentType, Number(e.target.value))}
              className="w-full accent-accent"
            />
          </div>
        ))}
      </div>
      <div className="flex justify-end">
        <Button size="sm" onClick={handleSave} disabled={updateMutation.isPending}>
          {updateMutation.isPending ? '保存中...' : '保存角色温度'}
        </Button>
      </div>
    </div>
  )
}

// ── 工具函数 ──

function loadConfig(): AgentConfig {
  if (typeof window === 'undefined') return defaultConfig
  try {
    const raw = window.localStorage.getItem(configStorageKey)
    if (!raw) return defaultConfig
    const data = JSON.parse(raw) as Partial<AgentConfig>
    return {
      systemPrompt: typeof data.systemPrompt === 'string' ? data.systemPrompt : defaultConfig.systemPrompt,
      temperature: typeof data.temperature === 'number' ? data.temperature : defaultConfig.temperature,
    }
  } catch {
    return defaultConfig
  }
}

function saveConfig(config: AgentConfig): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(configStorageKey, JSON.stringify(config))
}

// ── 自定义模板本地存储 ──

function loadTemplates(): PersonaTemplate[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(templatesStorageKey)
    if (!raw) return []
    const data = JSON.parse(raw)
    if (!Array.isArray(data)) return []
    return data.filter((t): t is PersonaTemplate =>
      t && typeof t.id === 'string' && typeof t.label === 'string' && typeof t.prompt === 'string'
    )
  } catch {
    return []
  }
}

function saveTemplates(templates: PersonaTemplate[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(templatesStorageKey, JSON.stringify(templates))
  } catch {
    // 忽略存储失败
  }
}

// ── 派遣历史本地存储 ──

function loadDispatchHistory(): DispatchHistoryEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(dispatchHistoryKey)
    if (!raw) return []
    const data = JSON.parse(raw)
    if (!Array.isArray(data)) return []
    return data.filter((e): e is DispatchHistoryEntry =>
      e && typeof e.id === 'string' && typeof e.agentId === 'string'
    )
  } catch {
    return []
  }
}

function saveDispatchHistory(history: DispatchHistoryEntry[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(dispatchHistoryKey, JSON.stringify(history))
  } catch {
    // 忽略存储失败
  }
}
