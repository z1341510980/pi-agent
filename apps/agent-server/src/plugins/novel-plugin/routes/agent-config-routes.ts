import { z } from 'zod'
import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import {
  getAllNovelAgentTemperatures,
  updateNovelAgentTemperatures,
  getAllNovelAgentModels,
  updateNovelAgentModel,
  type NovelAgentType,
} from '../core/domain/novel-agents.js'

const updateAgentConfigSchema = z.object({
  items: z.array(z.object({
    agentType: z.enum(['director', 'writer', 'reviser', 'reviewer', 'memory']),
    temperature: z.number().min(0).max(2),
    model: z.object({
      provider: z.string().min(1),
      modelId: z.string().min(1),
      thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']).nullable().optional(),
    }).nullable().optional(),
  })),
})

function formatAgentConfig(services: NovelServices) {
  const temperatures = getAllNovelAgentTemperatures(services.agentManager)
  const models = getAllNovelAgentModels(services.agentManager)
  return (Object.entries(temperatures) as Array<[NovelAgentType, number]>).map(([agentType, temperature]) => ({
    agentType,
    temperature,
    model: models[agentType],
  }))
}

export function createAgentConfigRoutes(services: NovelServices): RouteDefinition[] {
  return [
    {
      method: 'GET',
      path: '/agent-config',
      handler: async (request: any) => success(formatAgentConfig(services), request.traceId),
    },
    {
      method: 'PUT',
      path: '/agent-config',
      handler: async (request: any, reply: any) => {
        const input = validateBody(updateAgentConfigSchema, request, reply)
        if (!input) return reply

        updateNovelAgentTemperatures(input.items, services.agentManager)
        for (const item of input.items) {
          if (item.model !== undefined) {
            updateNovelAgentModel(item.agentType, item.model, services.agentManager)
          }
        }
        return success(formatAgentConfig(services), request.traceId)
      },
    },
  ]
}
