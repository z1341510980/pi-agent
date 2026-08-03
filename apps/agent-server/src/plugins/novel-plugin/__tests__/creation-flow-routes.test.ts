import { describe, expect, it, vi } from 'vitest'
import { ConfirmationManager } from '../../../core/tool/confirmation-manager.js'
import { createCreationFlowRoutes } from '../routes/creation-flow-routes.js'

function createReply() {
  const reply = {
    statusCode: 200,
    payload: undefined as unknown,
    code: vi.fn((statusCode: number) => {
      reply.statusCode = statusCode
      return reply
    }),
    send: vi.fn((payload: unknown) => {
      reply.payload = payload
      return reply
    }),
  }
  return reply
}

describe('creation-flow checkpoint decisions', () => {
  it('rejects an arbitrary or stale action before messages or run state are changed', async () => {
    const confirmationManager = new ConfirmationManager({ emit: vi.fn() } as any, { timeoutMs: 0 })
    const decisionPromise = confirmationManager.requestDecision({
      threadId: 'novel-checkpoint-project-1',
      toolCallId: 'tool-1',
      toolName: 'checkpoint_review',
      args: {
        checkpoint: {
          type: 'review',
          options: ['approve', 'revise', 'reject'],
        },
      },
      reason: 'test',
    }, 0)
    const pending = confirmationManager.listPending()[0]!
    const setUserMessages = vi.fn()
    const add = vi.fn()
    const services = {
      store: {},
      confirmationManager,
      orchestrator: { setUserMessages },
      chapterChatStore: { add },
    } as any
    const route = createCreationFlowRoutes(services).find(item => (
      item.path === '/projects/:projectId/checkpoint/:checkpointId/decision'
    ))!
    const reply = createReply()

    await route.handler({
      params: { projectId: 'project', checkpointId: pending.id },
      body: { decision: 'rewrite', userMessages: ['stale client message'] },
    } as any, reply as any)

    expect(reply.statusCode).toBe(400)
    expect(reply.payload).toMatchObject({ ok: false })
    expect(setUserMessages).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
    expect(confirmationManager.listPending()).toHaveLength(1)

    confirmationManager.respondDecision(pending.id, 'reject')
    await expect(decisionPromise).resolves.toBe('reject')
  })
})
