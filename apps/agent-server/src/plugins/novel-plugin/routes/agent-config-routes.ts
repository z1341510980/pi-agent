import { z } from 'zod'
import { Type } from 'typebox'
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
import { emptyParamsSchema, emptyQuerySchema, standardResponseSchema } from './route-contracts.js'

const agentConfigBodySchema = Type.Object({
  items: Type.Array(Type.Object({
    agentType: Type.Union([
      Type.Literal('director'), Type.Literal('writer'), Type.Literal('reviser'),
      Type.Literal('reviewer'), Type.Literal('memory'),
    ]),
    temperature: Type.Number({ minimum: 0, maximum: 2 }),
    model: Type.Optional(Type.Union([Type.Object({
      provider: Type.String({ minLength: 1 }),
      modelId: Type.String({ minLength: 1 }),
      thinkingLevel: Type.Optional(Type.Union([
        Type.Literal('off'), Type.Literal('minimal'), Type.Literal('low'), Type.Literal('medium'),
        Type.Literal('high'), Type.Literal('xhigh'), Type.Null(),
      ])),
    }, { additionalProperties: false }), Type.Null()])),
  }, { additionalProperties: false })),
}, { additionalProperties: false })

const routeSchema = (body?: object) => ({
  params: emptyParamsSchema,
  querystring: emptyQuerySchema,
  ...(body ? { body } : {}),
  response: standardResponseSchema,
})

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
      schema: routeSchema(),
      handler: async (request: any) => success(formatAgentConfig(services), request.traceId),
    },
    {
      method: 'PUT',
      path: '/agent-config',
      schema: routeSchema(agentConfigBodySchema),
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
