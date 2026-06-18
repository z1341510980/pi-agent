import type {
  BeforeToolCallContext,
  BeforeToolCallResult,
} from '@earendil-works/pi-agent-core'
import type { Gate } from './gate.js'
import type { ConfirmationManager } from './confirmation-manager.js'

export interface ToolCallHookDeps {
  threadId: string
  gate: Gate
  confirmationManager: ConfirmationManager
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

/**
 * 创建 beforeToolCall 钩子：Gate 权限检查 + 用户确认
 *
 * 使用 Pi SDK 原生 beforeToolCall 钩子，统一拦截所有工具调用
 * （内置工具 + 扩展工具 + customTools），避免 wrap execute 方案的覆盖盲区。
 *
 * 返回 { block: true, reason } 阻止执行，SDK 自动发出 error tool result。
 */
export function createBeforeToolCall(deps: ToolCallHookDeps) {
  return async (
    context: BeforeToolCallContext,
    _signal?: AbortSignal,
  ): Promise<BeforeToolCallResult | undefined> => {
    const { toolCall, args } = context
    const argsRecord = toRecord(args)
    const gateResult = await deps.gate.check(toolCall.name, argsRecord)

    if (!gateResult.allowed && !gateResult.needsConfirmation) {
      return {
        block: true,
        reason: gateResult.reason ?? `工具 '${toolCall.name}' 被安全策略禁止`,
      }
    }

    if (gateResult.needsConfirmation) {
      const approved = await deps.confirmationManager.requestConfirmation({
        threadId: deps.threadId,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        args: argsRecord,
        reason: gateResult.reason ?? `工具 '${toolCall.name}' 需要用户确认`,
      })

      if (!approved) {
        return {
          block: true,
          reason: `用户拒绝执行工具 '${toolCall.name}'`,
        }
      }
    }

    return undefined
  }
}
