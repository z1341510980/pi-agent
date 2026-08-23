import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { success } from '../../../lib/api-response.js'
import { AppError, ErrorCode } from '@repo/shared/errors'

/** 解析观测四 API 的公共 query 过滤参数（NaN/空串等非法数值视为未传，避免绑定报错） */
const parseObsFilter = (q: any) => {
  const num = (v: unknown): number | undefined => {
    if (v === '' || v == null) return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return {
    from: num(q?.from),
    to: num(q?.to),
    chapterNumber: num(q?.chapterNumber),
    agentType: q?.agentType ? String(q?.agentType) : undefined,
    limit: Math.min(Math.max(num(q?.limit) ?? 100, 1), 500),
  }
}

export function createObservabilityRoutes(services: NovelServices): RouteDefinition[] {
  const { store } = services
  return [
    { method: 'GET', path: '/projects/:projectId/observability/overview', handler: async (request: any) => {
      const { projectId } = request.params as { projectId: string }; if (!store.getProject(projectId)) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在', 404)
      return success(services.observabilityService.overview(projectId, parseObsFilter(request.query)), request.traceId)
    } },
    { method: 'GET', path: '/projects/:projectId/observability/cache', handler: async (request: any) => {
      const { projectId } = request.params as { projectId: string }; if (!store.getProject(projectId)) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在', 404)
      return success(services.observabilityService.cache(projectId, parseObsFilter(request.query)), request.traceId)
    } },
    { method: 'GET', path: '/projects/:projectId/observability/agents', handler: async (request: any) => {
      const { projectId } = request.params as { projectId: string }; if (!store.getProject(projectId)) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在', 404)
      return success(services.observabilityService.agents(projectId, parseObsFilter(request.query)), request.traceId)
    } },
    { method: 'GET', path: '/projects/:projectId/observability/timeline', handler: async (request: any) => {
      const { projectId } = request.params as { projectId: string }; if (!store.getProject(projectId)) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在', 404)
      return success(services.observabilityService.timeline(projectId, parseObsFilter(request.query)), request.traceId)
    } },
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
    { method: 'GET', path: '/projects/:projectId/scene-plan-coverage', handler: async (request: any) => {
      const { projectId } = request.params as { projectId: string }; if (!store.getProject(projectId)) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在', 404)
      // P1-3 v2 激活前置审计：场景计划覆盖率只读探针
      const coverage = store.getScenePlanCoverage(projectId)
      return success({
        projectId,
        ...coverage,
        /** 场景级重写的建议：覆盖率与平均场景数同时达标才有意义 */
        sceneRewriteReady: coverage.chaptersWithScenes > 0 && (coverage.avgSceneCountPerChapter ?? 0) >= 2,
      }, request.traceId)
    } },
    { method: 'POST', path: '/admin/agent-log-payloads/cleanup', handler: async (request: any) => success(store.cleanupExpiredPayloads(), request.traceId) },
  ]
}
