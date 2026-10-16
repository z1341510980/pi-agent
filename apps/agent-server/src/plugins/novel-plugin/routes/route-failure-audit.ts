import type { NovelStore } from '../core/novel-store.js'
import { persistNovelFailureAudit } from '../core/observability/novel-error-audit.js'

export interface RouteFailureAuditParams {
  request: {
    traceId?: string
    log?: { error?: (meta: unknown, message: string) => void }
  }
  store: NovelStore
  sourceFile: string
  sourceSymbol: string
  projectId: string
  chapterNumber: number
  operation: string
  input: unknown
  errorCode: string
  error: unknown
  durationMs: number
  result?: unknown
  agentType?: string
  agentName?: string
  displayAgentType?: string
  displayAgentName?: string
  phase?: string
  auditFailureMessage?: string
}

/** Adapt route request context to the shared durable failure-audit contract. */
export function persistRouteFailureAudit(params: RouteFailureAuditParams): void {
  persistNovelFailureAudit({
    store: params.store,
    projectId: params.projectId,
    chapterNumber: params.chapterNumber,
    operation: params.operation,
    source: { file: params.sourceFile, symbol: params.sourceSymbol },
    input: params.input,
    errorCode: params.errorCode,
    error: params.error,
    durationMs: params.durationMs,
    result: params.result,
    requestTraceId: params.request.traceId,
    agentType: params.agentType,
    agentName: params.agentName,
    displayAgentType: params.displayAgentType,
    displayAgentName: params.displayAgentName,
    phase: params.phase,
    onAuditFailure: (auditError) => params.request.log?.error?.(
      {
        err: auditError,
        projectId: params.projectId,
        chapterNumber: params.chapterNumber,
        operation: params.operation,
      },
      params.auditFailureMessage ?? '路由错误审计写入失败',
    ),
  })
}
