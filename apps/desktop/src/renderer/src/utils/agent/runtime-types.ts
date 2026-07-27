import type { AgentRuntimeType } from '@/types/runtime'

export const RUNTIME_LABELS: Record<AgentRuntimeType, { label: string; icon: string; description: string }> = {
  'chat-api': { label: 'API 模型', icon: 'Cloud', description: 'OpenAI / Anthropic / Gemini 等 API 直连' },
  'team': { label: 'Team 协作', icon: 'Users', description: '多 Agent 并行 / 流水线 / 协调执行' },
  'agent-plugin': { label: '插件 Agent', icon: 'Bot', description: 'novel-plugin 等注册的 Agent' },
}

export function describeRuntime(type: AgentRuntimeType): { label: string; icon: string; description: string } {
  return RUNTIME_LABELS[type]
}
