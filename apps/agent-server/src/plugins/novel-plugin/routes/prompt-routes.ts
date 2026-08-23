import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { z } from 'zod'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'

export function createPromptRoutes(services: NovelServices): RouteDefinition[] {
  const { promptManager } = services
  const savePromptSchema = z.object({ content: z.string().min(1), projectId: z.string().nullable(), description: z.string().optional() })
  return [
    { method: 'GET', path: '/prompts', handler: async (request: any) => success(promptManager.listTemplateInfos(request.query?.projectId ? String(request.query.projectId) : undefined), request.traceId) },
    { method: 'GET', path: '/prompts/:name', handler: async (request: any) => {
      const projectId = request.query?.projectId ? String(request.query.projectId) : undefined
      const source = promptManager.getTemplateSource(request.params.name, projectId)
      if (!source.exists) {
        return success({ name: request.params.name, content: null, ...source }, request.traceId)
      }
      return success({
        name: request.params.name,
        content: promptManager.getTemplate(request.params.name, projectId),
        source: source.source,
        hasRuntimeOverride: source.hasRuntimeOverride,
        defaultContent: source.defaultContent,
      }, request.traceId)
    } },
    { method: 'PUT', path: '/prompts/:name', handler: async (request: any, reply: any) => {
      const input = validateBody(savePromptSchema, request, reply); if (!input) return reply
      promptManager.saveTemplate(request.params.name, input.content, input.projectId, input.description)
      promptManager.clearCache()
      return success({ name: request.params.name, saved: true }, request.traceId)
    } },
    { method: 'DELETE', path: '/prompts/:name', handler: async (request: any) => {
      // 恢复默认：删除运行时覆盖（projectId 精确范围；不传则删全局覆盖）
      const projectId = request.query?.projectId ? String(request.query.projectId) : undefined
      const deleted = promptManager.deleteTemplateOverride(request.params.name, projectId)
      return success({ name: request.params.name, reset: deleted }, request.traceId)
    } },
  ]
}
