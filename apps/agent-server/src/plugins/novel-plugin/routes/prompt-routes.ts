import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { z } from 'zod'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'

export function createPromptRoutes(services: NovelServices): RouteDefinition[] {
  const { promptManager } = services
  const savePromptSchema = z.object({ content: z.string().min(1), projectId: z.string().nullable(), description: z.string().optional() })
  return [
    { method: 'GET', path: '/prompts', handler: async (request: any) => success(promptManager.listTemplateNames(), request.traceId) },
    { method: 'GET', path: '/prompts/:name', handler: async (request: any) => success({ name: request.params.name, content: promptManager.getTemplate(request.params.name, request.query.projectId) }, request.traceId) },
    { method: 'PUT', path: '/prompts/:name', handler: async (request: any, reply: any) => {
      const input = validateBody(savePromptSchema, request, reply); if (!input) return reply
      promptManager.saveTemplate(request.params.name, input.content, input.projectId, input.description)
      promptManager.clearCache()
      return success({ name: request.params.name, saved: true }, request.traceId)
    } },
  ]
}
