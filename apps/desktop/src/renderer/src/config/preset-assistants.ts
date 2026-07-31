import type { ComponentType } from 'react'
import type { LucideProps } from 'lucide-react'
import {
  Bot,
  BookText,
  Clapperboard,
  PenLine,
  ScanSearch,
  BrainCircuit,
  Code,
  Search,
  Languages,
  Sparkles,
} from 'lucide-react'
import type { AgentInfo } from '@/api/http-client'

/** lucide 图标组件类型 */
export type AgentIcon = ComponentType<LucideProps>

/**
 * PresetAssistant：Agent 身份显示信息（借鉴 AionUi PresetAssistantInfo）
 *
 * 在 AgentInfo 基础上扩展显示字段（icon/颜色等），
 * 用于 ChatHeader、消息流、Agent 切换器等。
 *
 * 不再使用 emoji，改用 lucide 图标库统一图标方案（对齐 AionUi @icon-park/react 的做法）。
 */
export interface PresetAssistant {
  id: string
  /** 显示名（fallback 到 agentId） */
  name: string
  /** 描述（用于 tooltip 与详情卡片） */
  description?: string
  /** lucide 图标组件（用于 logo 渲染） */
  icon?: AgentIcon
  /** 绑定的 Agent id */
  agentId: string
  /** 默认模型 */
  defaultModel?: { provider: string; modelId: string }
  /** 来源：内置 / 自定义（后端注册）/ 插件 */
  source: 'builtin' | 'custom' | 'plugin'
  /** 工具列表（仅后端注册 Agent 有） */
  tools?: string[]
}

/** 内置预设助手（与后端 AgentManager 默认 Agent 对齐） */
export const BUILTIN_PRESETS: Record<string, Partial<PresetAssistant>> = {
  default: {
    name: 'Pi Agent',
    icon: Bot,
    description: '通用 Agent，可调用所有注册工具',
    source: 'builtin',
  },
  novel: {
    name: '小说导演',
    icon: BookText,
    description: '小说创作专用 Agent，统一编排章节与角色',
    source: 'builtin',
  },
  director: {
    name: '导演',
    icon: Clapperboard,
    description: '小说章节规划与编排',
    source: 'builtin',
  },
  writer: {
    name: '作者',
    icon: PenLine,
    description: '小说正文撰写',
    source: 'builtin',
  },
  reviewer: {
    name: '审稿',
    icon: ScanSearch,
    description: '小说一致性审查与修订建议',
    source: 'builtin',
  },
  'memory-generator': {
    name: '记忆',
    icon: BrainCircuit,
    description: '记忆生成与维护',
    source: 'builtin',
  },
  // 通用预设（不绑定后端 Agent，仅作 UI 占位）
  coder: {
    name: '代码助手',
    icon: Code,
    description: '编程问题解答、代码生成与重构建议',
    source: 'builtin',
  },
  researcher: {
    name: '研究员',
    icon: Search,
    description: '信息检索、资料整理与深度分析',
    source: 'builtin',
  },
  translator: {
    name: '翻译',
    icon: Languages,
    description: '多语言翻译与本地化润色',
    source: 'builtin',
  },
}

/** 兜底图标：未指定 icon 时使用 */
export const DEFAULT_AGENT_ICON: AgentIcon = Sparkles

/** 获取所有内置预设助手 */
export function getBuiltinPresets(): PresetAssistant[] {
  return Object.entries(BUILTIN_PRESETS).map(([id, preset]) => ({
    id,
    name: preset.name ?? id,
    description: preset.description,
    icon: preset.icon,
    agentId: id,
    source: 'builtin' as const,
  }))
}

/** 从 AgentInfo + 内置预设合成 PresetAssistant */
export function toPresetAssistant(agent: AgentInfo): PresetAssistant {
  const builtin = BUILTIN_PRESETS[agent.id] ?? {}
  return {
    id: agent.id,
    name: agent.name || builtin.name || agent.id,
    description: agent.description ?? builtin.description,
    icon: builtin.icon,
    agentId: agent.id,
    defaultModel: agent.model,
    source: 'custom',
    tools: agent.tools,
  }
}
