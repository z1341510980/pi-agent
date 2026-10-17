import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import { Type } from 'typebox'
import type { NovelServices } from '../novel-services.js'
import { success } from '../../../lib/api-response.js'
import { buildCacheLayerReport, diagnoseChapterCache } from '../core/analysis/cache-layer-diagnostics.js'
import { standardResponseSchema } from './route-contracts.js'

const projectParamsSchema = Type.Object({ projectId: Type.String({ minLength: 1 }) })
const cacheDiagnosticsQuerySchema = Type.Object({
  chapterNumber: Type.Optional(Type.String()),
}, { additionalProperties: true })
const cacheReportQuerySchema = Type.Object({
  chapterNumber: Type.Optional(Type.String()),
  limit: Type.Optional(Type.String()),
}, { additionalProperties: true })

export function createCacheRoutes(services: NovelServices): RouteDefinition[] {
  const { store, promptBuilder } = services
  const agentTypes = ['director', 'writer', 'reviewer', 'memory']
  return [
    { method: 'GET', path: '/projects/:projectId/cache-diagnostics', schema: { params: projectParamsSchema, querystring: cacheDiagnosticsQuerySchema, response: standardResponseSchema }, handler: async (request: any) => {
      const projectId = request.params.projectId; const chapterNumber = request.query?.chapterNumber != null ? parseInt(request.query.chapterNumber, 10) : undefined
      const systemPromptHashes: Record<string, string> = {}; for (const agentType of agentTypes) { try { systemPromptHashes[agentType] = promptBuilder.getSystemPromptHash(projectId, agentType) } catch { systemPromptHashes[agentType] = 'error' } }
      let chapterContextHash: string | undefined; const chapterContextHashes: Record<string, string> = {}
      if (chapterNumber != null && !Number.isNaN(chapterNumber)) {
        const task = { description: '诊断请求', type: 'advance_mainline' as const, targetEntity: null, priority: 'medium' as const }
        const constraints = { facts: store.listConstraints(projectId).filter((c: any) => c.type === 'fact'), cognitive: store.listConstraints(projectId).filter((c: any) => c.type === 'cognitive'), stage: store.listConstraints(projectId).filter((c: any) => c.type === 'stage'), narrativeDebts: store.listForeshadowing(projectId), characterArcs: store.listCharacters(projectId).map((character: any) => ({ character, allowedNextStage: null })), conflictTargets: [], suspenseHooks: [] }
        for (const agentType of agentTypes) { try { chapterContextHashes[agentType] = promptBuilder.getChapterContextHash(projectId, chapterNumber, task, constraints, undefined, agentType) } catch { chapterContextHashes[agentType] = 'error' } }
        chapterContextHash = chapterContextHashes.director
      }
      return success({ systemPromptHashes, chapterContextHash, chapterContextHashes, agentTypes, timestamp: Date.now() }, request.traceId)
    } },
    { method: 'GET', path: '/projects/:projectId/cache-layer-report', schema: { params: projectParamsSchema, querystring: cacheReportQuerySchema, response: standardResponseSchema }, handler: async (request: any) => {
      const projectId = request.params.projectId; const chapterNumber = request.query?.chapterNumber != null ? parseInt(request.query.chapterNumber, 10) : undefined
      const limit = request.query?.limit != null ? Math.min(Math.max(parseInt(request.query.limit, 10) || 200, 1), 500) : 200
      const logs = store.listAgentLogsByProject(projectId, limit); const scoped = chapterNumber != null && !Number.isNaN(chapterNumber) ? logs.filter((log: any) => log.chapterNumber === chapterNumber) : logs
      const byChapter = new Map<number, any[]>(); for (const log of scoped) { const list = byChapter.get(log.chapterNumber) ?? []; list.push(log); byChapter.set(log.chapterNumber, list) }
      const diagnoses = Array.from(byChapter.entries()).sort(([a], [b]) => a - b).map(([chapter, chapterLogs]) => diagnoseChapterCache(chapter, chapterLogs))
      return success({ ...buildCacheLayerReport(diagnoses), sampledLogs: scoped.length, timestamp: Date.now() }, request.traceId)
    } },
  ]
}

