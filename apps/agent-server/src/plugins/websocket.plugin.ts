import fp from 'fastify-plugin'
import websocketPlugin from '@fastify/websocket'
import type { FastifyPluginAsync } from 'fastify'

export const websocketSupportPlugin: FastifyPluginAsync = fp(async (app) => {
  await app.register(websocketPlugin)
})
