import { getApi } from '@/api/http-client'
import type { AgentRuntime, AgentRuntimeType, RuntimeModel, RuntimeModelGroup } from '@/types/runtime'

interface BackendAgent {
  id: string
  name: string
  type?: string
  description?: string
}

interface BackendProvider {
  id: string
  name: string
  models: Array<{ id: string; name?: string; contextWindow?: number }>
}

export const chatApiRuntime: AgentRuntime = {
  type: 'chat-api',
  label: 'API 模型',
  icon: 'Cloud',
  description: 'OpenAI / Anthropic / Gemini 等 API 直连',
  async listModels(): Promise<RuntimeModelGroup[]> {
    const providers = await getApi<BackendProvider[]>('/providers')
    return providers.map((p) => ({
      key: p.id,
      title: p.name,
      models: p.models.map((m) => ({
        id: `${p.id}:${m.id}`,
        label: m.name ?? m.id,
        description: m.contextWindow ? `${m.contextWindow} tokens` : undefined,
      })),
    }))
  },
}

export const teamRuntime: AgentRuntime = {
  type: 'team',
  label: 'Team 协作',
  icon: 'Users',
  description: '多 Agent 并行 / 流水线 / 协调执行',
  async listModels(): Promise<RuntimeModel[]> {
    const teams = await getApi<Array<{ id: string; name: string; description?: string }>>('/teams')
    return teams.map((t) => ({ id: t.id, label: t.name, description: t.description }))
  },
}

export const agentPluginRuntime: AgentRuntime = {
  type: 'agent-plugin',
  label: '插件 Agent',
  icon: 'Bot',
  description: 'novel-plugin 等注册的 Agent',
  async listModels(): Promise<RuntimeModel[]> {
    const agents = await getApi<BackendAgent[]>('/agents')
    return agents.map((a) => ({ id: a.id, label: a.name, description: a.description ?? a.type }))
  },
}

export const ALL_RUNTIMES: AgentRuntime[] = [chatApiRuntime, teamRuntime, agentPluginRuntime]

export function getRuntime(type: AgentRuntimeType): AgentRuntime | undefined {
  return ALL_RUNTIMES.find((r) => r.type === type)
}
