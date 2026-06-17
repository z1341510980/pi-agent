import { randomUUID } from 'node:crypto'
import type { EventBus } from '@repo/shared/events'

export interface ConfirmationRequestPayload {
  threadId: string
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  reason: string
}

export interface ConfirmationRequest extends ConfirmationRequestPayload {
  id: string
  createdAt: number
}

export interface ConfirmationManagerOptions {
  timeoutMs?: number
}

interface PendingConfirmation {
  request: ConfirmationRequest
  resolve: (approved: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

const defaultTimeoutMs = 120_000

export class ConfirmationManager {
  private readonly pending = new Map<string, PendingConfirmation>()
  private readonly timeoutMs: number

  constructor(
    private readonly eventBus: EventBus,
    options: ConfirmationManagerOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  }

  requestConfirmation(payload: ConfirmationRequestPayload): Promise<boolean> {
    const request: ConfirmationRequest = {
      ...payload,
      id: randomUUID(),
      createdAt: Date.now(),
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.resolveRequest(request.id, false)
      }, this.timeoutMs)

      this.pending.set(request.id, {
        request,
        resolve,
        timer,
      })

      this.eventBus.emit('confirmation:request', request)
    })
  }

  respond(id: string, approved: boolean): boolean {
    return this.resolveRequest(id, approved)
  }

  listPending(): ConfirmationRequest[] {
    return Array.from(this.pending.values(), (entry) => entry.request)
  }

  dispose(): void {
    for (const id of Array.from(this.pending.keys())) {
      this.resolveRequest(id, false)
    }
  }

  private resolveRequest(id: string, approved: boolean): boolean {
    const pending = this.pending.get(id)
    if (!pending) return false

    clearTimeout(pending.timer)
    this.pending.delete(id)
    pending.resolve(approved)
    this.eventBus.emit('confirmation:resolved', {
      id,
      approved,
    })
    return true
  }
}
