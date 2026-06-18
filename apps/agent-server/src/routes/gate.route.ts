import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { success } from '../lib/api-response.js'
import { validateBody } from '../lib/validate.js'

const gateModeSchema = z.object({
  mode: z.enum(['auto', 'plan', 'readonly']),
})

export const gateRoute: FastifyPluginAsync = async (app) => {
  // 获取当前权限模式
  app.get('/api/gate', async (request) => {
    return success(
      {
        mode: app.gate.getMode(),
      },
      request.traceId,
    )
  })

  // 更新权限模式
  app.put('/api/gate/mode', async (request, reply) => {
    const input = validateBody(gateModeSchema, request, reply)
    if (!input) {
      return reply
    }

    app.gate.setMode(input.mode)

    return success(
      {
        mode: app.gate.getMode(),
      },
      request.traceId,
    )
  })
}
