export type AgentRuntimeType = 'chat-api' | 'team' | 'agent-plugin'

export interface RuntimeModel {
  id: string
  label?: string
  description?: string
}

export interface RuntimeModelGroup {
  key: string
  title: string
  models: RuntimeModel[]
}

export interface AgentRuntime {
  type: AgentRuntimeType
  label: string
  icon: string
  description: string
  listModels(): Promise<RuntimeModel[] | RuntimeModelGroup[]>
}

export interface RuntimeSelection {
  runtime: AgentRuntimeType
  modelId?: string
  teamId?: string
}
