import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { validateBody } from '../lib/validate.js'

const confirmationResponseSchema = z.object({
  approved: z.boolean(),
})

export const confirmationRoute: FastifyPluginAsync = async (app) => {
  app.get('/api/confirmations', async () => {
    return {
      ok: true,
      data: {
        pending: app.confirmationManager.listPending(),
      },
    }
  })

  app.post('/api/confirmations/:id/respond', async (request, reply) => {
    const params = request.params as { id: string }
    const input = validateBody(confirmationResponseSchema, request, reply)

    if (!input) {
      return reply
    }

    const accepted = app.confirmationManager.respond(params.id, input.approved)
    if (!accepted) {
      throw new AppError(ErrorCode.NOT_FOUND, '确认请求不存在或已处理', 404)
    }

    return {
      ok: true,
      data: {
        accepted,
      },
    }
  })
}
