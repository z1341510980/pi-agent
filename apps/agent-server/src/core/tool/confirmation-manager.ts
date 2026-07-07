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
  resolve: (decision: string) => void
  timer: ReturnType<typeof setTimeout> | null
}

/** 默认 boolean 兼容决策：批准 */
export const DECISION_APPROVE = 'approve'
/** 默认 boolean 兼容决策：拒绝 */
export const DECISION_REJECT = 'reject'

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

  /**
   * 发起任意字符串决策请求（如 'approve'/'reject'/'revise'/'rewrite'）
   *
   * 与 requestConfirmation 的区别：
   * - 返回 Promise<string>，决策值由调用方约定
   * - 超时后 resolve 为 DECISION_REJECT（'reject'），与旧 API 超时行为一致
   *
   * @param timeoutMs 单次超时覆盖，0 表示无超时（永久等待用户决策）
   */
  requestDecision(payload: ConfirmationRequestPayload, timeoutMs?: number): Promise<string> {
    const request: ConfirmationRequest = {
      ...payload,
      id: randomUUID(),
      createdAt: Date.now(),
    }

    return new Promise((resolve) => {
      const effectiveTimeout = timeoutMs !== undefined ? timeoutMs : this.timeoutMs
      const timer = effectiveTimeout > 0
        ? setTimeout(() => {
          this.resolveRequest(request.id, DECISION_REJECT)
        }, effectiveTimeout)
        : null

      this.pending.set(request.id, {
        request,
        resolve,
        timer,
      })

      this.eventBus.emit('confirmation:request', request)
    })
  }

  /**
   * 响应决策请求，传入任意 string 决策
   *
   * @returns 是否成功（false 表示请求不存在或已处理）
   */
  respondDecision(id: string, decision: string): boolean {
    return this.resolveRequest(id, decision)
  }

  /**
   * 发起 boolean 决策请求（向后兼容旧 API）
   *
   * 内部委托给 requestDecision：approved=true → 'approve'，approved=false → 'reject'。
   * 返回的 Promise<boolean> 由 decision === 'approve' 转换而来。
   */
  requestConfirmation(payload: ConfirmationRequestPayload): Promise<boolean> {
    return this.requestDecision(payload).then((decision) => decision === DECISION_APPROVE)
  }

  /**
   * 响应 boolean 决策请求（向后兼容旧 API）
   *
   * 内部委托给 respondDecision：approved=true → 'approve'，approved=false → 'reject'。
   */
  respond(id: string, approved: boolean): boolean {
    return this.respondDecision(id, approved ? DECISION_APPROVE : DECISION_REJECT)
  }

  listPending(): ConfirmationRequest[] {
    return Array.from(this.pending.values(), (entry) => entry.request)
  }

  dispose(): void {
    for (const id of Array.from(this.pending.keys())) {
      this.resolveRequest(id, DECISION_REJECT)
    }
  }

  private resolveRequest(id: string, decision: string): boolean {
    const pending = this.pending.get(id)
    if (!pending) return false

    if (pending.timer) clearTimeout(pending.timer)
    this.pending.delete(id)
    pending.resolve(decision)
    // 兼容字段：approved 保留供旧监听者使用，新监听者可读 decision
    this.eventBus.emit('confirmation:resolved', {
      id,
      decision,
      approved: decision === DECISION_APPROVE,
    })
    return true
  }
}
