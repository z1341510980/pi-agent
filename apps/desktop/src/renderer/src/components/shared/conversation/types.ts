/** Agent 类型（用于颜色映射） */
export type ConversationAgentType =
  | 'director' | 'writer' | 'reviewer' | 'reviser'
  | 'memory' | 'arranger' | 'context' | 'extractor' | 'moderator' | 'character'

/** 统一消息类型，chat 和 novel 共用 */
export interface ConversationMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'checkpoint'
  /** assistant: Agent 名称 */
  agentName?: string
  /** assistant: Agent 类型（用于颜色映射） */
  agentType?: ConversationAgentType
  /** 消息内容 */
  content: string
  /** 流式缓冲（streaming 时显示） */
  streamingBuffer?: string
  /** 消息状态 */
  status: 'complete' | 'streaming' | 'error'
  /** 时间戳 */
  timestamp: number
  /** 错误信息 */
  error?: string

  // ── checkpoint 专用 ──
  // 与共享包 CheckpointType 第一值 'narrative_task' 对齐（不再用旧值 'narrative'）
  checkpointType?: 'narrative_task' | 'review' | 'post_write_guard' | 'writer_pushback' | 'guard_degraded' | 'chapter_budget'
  checkpointOptions?: Array<{ label: string; action: string; variant: 'default' | 'outline' | 'destructive' | 'ghost'; description?: string }>
  checkpointResolved?: string

  // ── user 专用：插话（对话化交互形态 §3.1）──
  // flow 运行中用户中途反馈的状态徽标：queued=已排队 / injected=已注入 / dropped=已丢弃
  interjectStatus?: 'queued' | 'injected' | 'dropped'
  /** status='injected' 时实际消费该插话的 Agent 类型（徽标展示「已注入·导演」） */
  interjectAgentType?: string

  // ── system 专用 ──
  systemActions?: Array<{ label: string; action: string; variant: 'default' | 'outline' | 'destructive' }>
}

/** Agent 颜色配置 */
export interface AgentColorConfig {
  /** 头像背景色 class */
  avatarClass: string
  /** Badge class */
  badgeClass: string
  /** 气泡边框色 */
  borderColor: string
}

/** Agent 颜色映射表 */
export const AGENT_COLORS: Record<ConversationAgentType, AgentColorConfig> = {
  director:  { avatarClass: 'bg-blue-500',    badgeClass: 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/40',    borderColor: 'rgba(59,130,246,0.3)' },
  writer:    { avatarClass: 'bg-emerald-500', badgeClass: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40', borderColor: 'rgba(34,197,94,0.3)' },
  reviewer:  { avatarClass: 'bg-orange-500',  badgeClass: 'bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/40',  borderColor: 'rgba(249,115,22,0.3)' },
  reviser:   { avatarClass: 'bg-purple-500',  badgeClass: 'bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/40',  borderColor: 'rgba(168,85,247,0.3)' },
  memory:    { avatarClass: 'bg-gray-500',    badgeClass: 'bg-gray-500/15 text-gray-700 dark:text-gray-300 border-gray-500/40',        borderColor: 'rgba(107,114,128,0.3)' },
  arranger:  { avatarClass: 'bg-cyan-500',    badgeClass: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-500/40',        borderColor: 'rgba(6,182,212,0.3)' },
  context:   { avatarClass: 'bg-indigo-500',  badgeClass: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-indigo-500/40', borderColor: 'rgba(99,102,241,0.3)' },
  extractor: { avatarClass: 'bg-amber-500',   badgeClass: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40',    borderColor: 'rgba(245,158,11,0.3)' },
  moderator: { avatarClass: 'bg-pink-500',    badgeClass: 'bg-pink-500/15 text-pink-700 dark:text-pink-300 border-pink-500/40',        borderColor: 'rgba(236,72,153,0.3)' },
  character: { avatarClass: 'bg-rose-500',    badgeClass: 'bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/40',        borderColor: 'rgba(244,63,94,0.3)' },
}

/** Agent 类型对应的中文标签 */
export const AGENT_LABELS: Record<ConversationAgentType, string> = {
  director: '导演',
  writer: '写作',
  reviewer: '审稿',
  reviser: '修订',
  memory: '记忆',
  arranger: '编排',
  context: '上下文',
  extractor: '反推',
  moderator: '主持人',
  character: '角色',
}

/** 格式化时间戳为 HH:mm */
export function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
