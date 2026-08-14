import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { success } from '../../../lib/api-response.js'
import { AppError, ErrorCode } from '@repo/shared/errors'

export function createObservabilityRoutes(services: NovelServices): RouteDefinition[] {
  const { store } = services
  return [
    { method: 'GET', path: '/projects/:projectId/cost-report', handler: async (request: any) => {
      const { projectId } = request.params as { projectId: string }; if (!store.getProject(projectId)) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在', 404)
      const chapterNumber = request.query?.chapterNumber != null ? parseInt(String(request.query.chapterNumber), 10) : undefined
      return success({ projectId, reports: services.costReportService.chapterReport(projectId, chapterNumber) }, request.traceId)
    } },
    { method: 'GET', path: '/projects/:projectId/agent-cost-share', handler: async (request: any) => {
      const { projectId } = request.params as { projectId: string }; if (!store.getProject(projectId)) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在', 404)
      return success({ projectId, shares: services.costReportService.agentCostShare(projectId) }, request.traceId)
    } },
    { method: 'GET', path: '/projects/:projectId/shared-overlap', handler: async (request: any) => {
      const { projectId } = request.params as { projectId: string }; if (!store.getProject(projectId)) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在', 404)
      return success(services.sharedOverlapAnalyzer.analyze(projectId), request.traceId)
    } },
    { method: 'POST', path: '/admin/agent-log-payloads/cleanup', handler: async (request: any) => success(store.cleanupExpiredPayloads(), request.traceId) },
  ]
}
