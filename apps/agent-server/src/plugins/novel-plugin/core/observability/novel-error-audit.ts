import type { NovelStore } from '../novel-store.js'

export interface NovelFailureAuditParams {
  store: NovelStore
  projectId: string
  chapterNumber: number
  operation: string
  source: {
    file: string
    symbol: string
  }
  input: unknown
  errorCode: string
  error: unknown
  durationMs: number
  result?: unknown
  requestTraceId?: string
  agentType?: string
  agentName?: string
  displayAgentType?: string
  displayAgentName?: string
  phase?: string
  onAuditFailure?: (error: unknown) => void
}

function serializeAuditValue(value: unknown): string {
  if (value == null) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch (error) {
    return JSON.stringify({
      serializationError: error instanceof Error ? error.message : String(error),
      valueType: typeof value,
    })
  }
}

function serializeError(error: unknown): { name: string; message: string; stack: string | null } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
    }
  }
  return {
    name: typeof error,
    message: String(error),
    stack: null,
  }
}

/**
 * Persists a route or orchestration boundary failure using the same durable
 * Agent-log payload store as individual LLM calls. This makes failures that
 * occur before or after a provider call traceable without masking the source
 * error when audit storage itself is unavailable.
 */
export function persistNovelFailureAudit(params: NovelFailureAuditParams): void {
  const source = {
    file: params.source.file,
    symbol: params.source.symbol,
    operation: params.operation,
  }
  const auditInput = {
    schemaVersion: 1,
    source,
    request: {
      traceId: params.requestTraceId ?? null,
      params: { projectId: params.projectId, chapterNumber: params.chapterNumber },
      body: params.input,
    },
  }
  const auditError = {
    schemaVersion: 1,
    source,
    errorCode: params.errorCode,
    ...serializeError(params.error),
  }
  const serializedResult = serializeAuditValue(params.result)

  try {
    params.store.insertAgentLog({
      projectId: params.projectId,
      chapterNumber: params.chapterNumber,
      agentType: params.agentType ?? 'audit',
      agentName: params.agentName ?? '流程错误审计',
      displayAgentType: params.displayAgentType ?? 'audit',
      displayAgentName: params.displayAgentName ?? '流程错误审计',
      phase: params.phase ?? 'error_audit',
      systemPrompt: '',
      chapterContext: '',
      userMessage: `${params.operation} 失败审计`,
      taskInput: serializeAuditValue(auditInput),
      userInstructions: [],
      tools: [],
      toolNames: [],
      askStoryPolicy: 'legacy',
      askStoryEnabled: false,
      result: serializedResult,
      resultLength: serializedResult.length,
      durationMs: params.durationMs,
      status: 'error',
      error: serializeAuditValue(auditError),
      sessionId: params.requestTraceId ?? '',
      operation: params.operation,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      llmProvider: '',
      llmModel: '',
      payloadMessagesChars: 0,
      payloadToolsChars: 0,
      payloadToolCount: 0,
      payloadTotalChars: 0,
      llmRoundTrips: 0,
      dataQuality: 'no_data',
      errorCode: params.errorCode,
    })
  } catch (auditError) {
    params.onAuditFailure?.(auditError)
  }
}
