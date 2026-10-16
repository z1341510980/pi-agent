import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { success } from '../../../lib/api-response.js'
import { AppError, ErrorCode } from '@repo/shared/errors'

/** Agent invocation history endpoints. */
export function createAgentLogRoutes(services: Pick<NovelServices, 'store'>): RouteDefinition[] {
  const { store } = services
  return [
    {
      method: 'GET',
      path: '/projects/:projectId/agent-logs',
      handler: async (request: any) => {
        const { projectId } = request.params as { projectId: string }
        const query = request.query as {
          chapterNumber?: string
          agentType?: string
          limit?: string
        }
        const limit = query.limit ? parseInt(query.limit, 10) : 100
        const filter: { chapterNumber?: number; agentType?: string } = {}
        if (query.chapterNumber != null) {
          const chapterNumber = parseInt(query.chapterNumber, 10)
          if (!Number.isNaN(chapterNumber)) filter.chapterNumber = chapterNumber
        }
        if (query.agentType) filter.agentType = query.agentType

        const logs = store.listAgentLogs(
          projectId,
          Object.keys(filter).length > 0 ? filter : undefined,
          limit,
        )
        return success(logs, request.traceId)
      },
    },
    {
      method: 'GET',
      path: '/agent-logs/:id',
      handler: async (request: any) => {
        const log = store.getAgentLog(request.params.id)
        if (!log) throw new AppError(ErrorCode.NOT_FOUND, `日志不存在: ${request.params.id}`, 404)
        return success(log, request.traceId)
      },
    },
    {
      method: 'DELETE',
      path: '/projects/:projectId/agent-logs',
      handler: async (request: any) => {
        const deleted = store.deleteAgentLogsByProject(request.params.projectId)
        return success({ projectId: request.params.projectId, deleted }, request.traceId)
      },
    },
  ]
}
