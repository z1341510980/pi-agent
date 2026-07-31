import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { getAgents } from '@/api/http-client'
import { useSessionStore } from '@/stores/session-store'
import {
  BUILTIN_PRESETS,
  toPresetAssistant,
  type PresetAssistant,
} from '@/config/preset-assistants'

/**
 * useActiveAgent：当前活跃 Agent 的身份信息
 *
 * 数据源：
 *   1. 后端 /api/agents 列表（获取真实 Agent 配置）
 *   2. session-store 的 activeAgentId（当前选中）
 *   3. BUILTIN_PRESETS 内置预设（icon/description 等显示字段）
 *
 * 合并策略：后端 AgentInfo + 内置预设显示字段 → PresetAssistant
 */
export function useActiveAgent() {
  const activeAgentId = useSessionStore((s) => s.activeAgentId)

  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: getAgents,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  const assistant = useMemo<PresetAssistant>(() => {
    const agentInfo = agentsQuery.data?.find((a) => a.id === activeAgentId)
    const builtin = BUILTIN_PRESETS[activeAgentId] ?? {}

    const name =
      agentInfo?.name ?? builtin.name ?? activeAgentId ?? 'Pi Agent'
    const description = agentInfo?.description ?? builtin.description
    const icon = builtin.icon

    return {
      id: activeAgentId,
      name,
      description,
      icon,
      agentId: activeAgentId,
      defaultModel: agentInfo?.model,
      source: agentInfo ? 'custom' : 'builtin',
      tools: agentInfo?.tools,
    }
  }, [agentsQuery.data, activeAgentId])

  /** 所有可用助手列表（内置 + 后端注册，去重） */
  const allAssistants = useMemo<PresetAssistant[]>(() => {
    const builtinIds = new Set(Object.keys(BUILTIN_PRESETS))
    const customAssistants = (agentsQuery.data ?? [])
      .filter((a) => !builtinIds.has(a.id))
      .map(toPresetAssistant)
    // 内置预设中，已注册到后端的会合并描述，未注册的仍以内置信息显示
    const builtinAssistants = Object.entries(BUILTIN_PRESETS).map(([id, p]) => {
      const agentInfo = agentsQuery.data?.find((a) => a.id === id)
      return {
        id,
        name: agentInfo?.name ?? p.name ?? id,
        description: agentInfo?.description ?? p.description,
        icon: p.icon,
        agentId: id,
        defaultModel: agentInfo?.model,
        source: 'builtin' as const,
        tools: agentInfo?.tools,
      }
    })
    return [...builtinAssistants, ...customAssistants]
  }, [agentsQuery.data])

  return {
    assistant,
    isLoading: agentsQuery.isLoading,
    /** 所有 Agent 列表（用于切换器） */
    agents: agentsQuery.data ?? [],
    /** 所有可用助手列表（内置 + 自定义，去重） */
    allAssistants,
  }
}

// 重新导出常用类型与工具函数
export type { PresetAssistant } from '@/config/preset-assistants'
export { getBuiltinPresets, toPresetAssistant } from '@/config/preset-assistants'
