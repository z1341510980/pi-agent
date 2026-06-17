import type { FastifyPluginAsync } from 'fastify'
import { success } from '../lib/api-response.js'

export const healthRoute: FastifyPluginAsync = async (app) => {
  app.get('/api/health', async (request) => {
    return success(
      {
        service: 'agent-server',
        status: 'online',
      },
      request.traceId,
    )
  })
}
