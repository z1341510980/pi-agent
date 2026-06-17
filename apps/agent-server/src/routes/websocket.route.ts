import type { FastifyPluginAsync } from 'fastify'
import type { ConfirmationRequest } from '../core/tool/confirmation-manager.js'

export const websocketRoute: FastifyPluginAsync = async (app) => {
  app.get('/ws', { websocket: true }, (socket) => {
    const sendConfirmation = (payload: ConfirmationRequest): void => {
      if (socket.readyState !== socket.OPEN) return
      socket.send(
        JSON.stringify({
          type: 'confirmation_request',
          payload,
        }),
      )
    }

    app.eventBus.on('confirmation:request', sendConfirmation)

    socket.on('close', () => {
      app.eventBus.off('confirmation:request', sendConfirmation)
    })
  })
}
