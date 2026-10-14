import { randomUUID } from 'node:crypto'
import type { DiscussionCheckpoint } from '../core/discussion/engine/discussion-types.js'
import { registerCheckpointFeedback } from './checkpoint-feedback-registry.js'

type ConfirmationManagerLike = {
  requestDecision: (request: any, timeoutMs: number) => Promise<string>
  listPending: () => Array<{ id: string; toolCallId?: string }>
}

/** 统一后台 checkpoint 的挂起、绑定反馈和事件推送流程。 */
export async function waitForCheckpointDecision(params: {
  manager: ConfirmationManagerLike
  threadId: string
  toolName: string
  checkpoint: Record<string, unknown>
  reason: string
  feedback?: string[]
  emit: (checkpoint: Record<string, unknown>) => void
}): Promise<string> {
  const toolCallId = randomUUID()
  const decision = params.manager.requestDecision({
    threadId: params.threadId,
    toolCallId,
    toolName: params.toolName,
    args: { checkpoint: params.checkpoint },
    reason: params.reason,
  }, 0)
  const pending = params.manager.listPending().find(item => item.toolCallId === toolCallId)
  if (pending?.id && params.feedback) registerCheckpointFeedback(pending.id, params.feedback)
  params.emit({ ...params.checkpoint, checkpointId: pending?.id })
  return decision
}

export function withDiscussionCheckpointOptions(checkpoint: DiscussionCheckpoint): Record<string, unknown> {
  return { ...checkpoint, options: checkpoint.options ?? ['approve', 'revise', 'reject'] }
}
