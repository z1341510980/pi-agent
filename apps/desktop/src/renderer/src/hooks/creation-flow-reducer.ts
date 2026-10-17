import type {
  AgentOutput,
  CreationPhase,
  CreationResult,
  NovelInterjectTargetAgent,
  NovelUserMessageEvent,
} from '@repo/shared/novel'

export interface PersistedCreationEvent {
  seq: number
  type: string
  payload: Record<string, unknown>
}

export interface CreationFlowLifecycleState {
  cursorSeq: number
  isRunning: boolean
  phase: CreationPhase
  progressMessage: string | null
  chapterContent: string
  result: CreationResult | null
  error: string | null
}

export function createInitialCreationFlowState(): CreationFlowLifecycleState {
  return {
    cursorSeq: 0,
    isRunning: true,
    phase: 'idle',
    progressMessage: null,
    chapterContent: '',
    result: null,
    error: null,
  }
}

/**
 * Fold one durable run event into the minimal lifecycle state needed for replay.
 * Sequence numbers are the reconnect cursor: an event already seen is a no-op.
 */
export function applyPersistedCreationEvent(
  state: CreationFlowLifecycleState,
  event: PersistedCreationEvent,
): CreationFlowLifecycleState {
  if (!Number.isInteger(event.seq) || event.seq <= state.cursorSeq) return state
  const next: CreationFlowLifecycleState = { ...state, cursorSeq: event.seq }
  const embeddedType = typeof event.payload.type === 'string' ? event.payload.type : undefined
  if (event.type === 'run_finished' || embeddedType === 'run_finished') {
    const nested = event.payload.payload
    const payload = nested && typeof nested === 'object'
      ? nested as Record<string, unknown>
      : event.payload
    const status = payload.status as CreationResult['status'] | undefined
    const result = payload as unknown as CreationResult
    next.result = result
    next.chapterContent = typeof payload.content === 'string' ? payload.content : state.chapterContent
    next.isRunning = false
    next.phase = status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'error'
    next.error = status === 'completed' ? null : (typeof payload.error === 'string' ? payload.error : null)
    return next
  }
  if (event.type !== 'agui') return next

  const agui = event.payload
  if (agui.type !== 'CUSTOM') return next
  if (agui.name === 'novel:progress') {
    const value = agui.value as { phase?: CreationPhase; data?: { message?: string } } | undefined
    if (value?.phase) next.phase = value.phase
    if (value?.data?.message) next.progressMessage = value.data.message
    return next
  }
  if (agui.name === 'novel:result') {
    const result = agui.value as CreationResult | undefined
    if (!result) return next
    next.result = result
    next.chapterContent = result.content ?? state.chapterContent
    next.isRunning = false
    next.phase = result.status === 'completed' ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'error'
    next.error = result.status === 'completed' ? null : (result.error ?? null)
  }
  return next
}

export interface InterjectMessage {
  messageId: string
  content: string
  status: 'queued' | 'injected' | 'dropped'
  targetAgent?: NovelInterjectTargetAgent
  agentType?: string
  timestamp: number
}

const INTERJECT_STATUS_ORDER: Record<InterjectMessage['status'], number> = {
  queued: 0,
  injected: 1,
  dropped: 1,
}

/** Pure event reducer for the persisted novel:user-message stream. */
export function applyUserMessageEvent(
  prev: InterjectMessage[],
  event: NovelUserMessageEvent,
): InterjectMessage[] {
  const next: InterjectMessage = {
    messageId: event.messageId,
    content: event.content,
    status: event.status,
    targetAgent: event.targetAgent,
    agentType: event.agentType,
    timestamp: event.timestamp,
  }
  const index = prev.findIndex((message) => message.messageId === event.messageId)
  if (index === -1) return [...prev, next]
  if (INTERJECT_STATUS_ORDER[prev[index].status] >= INTERJECT_STATUS_ORDER[event.status]) return prev
  const updated = [...prev]
  updated[index] = { ...updated[index], ...next }
  return updated
}

export function streamsChapterContent(agentType: AgentOutput['agentType']): boolean {
  return agentType === 'writer'
}
