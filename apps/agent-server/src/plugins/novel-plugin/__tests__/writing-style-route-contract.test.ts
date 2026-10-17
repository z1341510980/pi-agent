import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerPluginRoute } from '../../plugin-loader.plugin.js'
import { createWritingStyleRoutes } from '../routes/writing-style-routes.js'

describe('writing-style route contracts', () => {
  it('declares Fastify schemas for every writing-style endpoint', () => {
    const routes = createWritingStyleRoutes({ store: {}, promptBuilder: {} } as any)
    expect(routes).toHaveLength(12)
    for (const route of routes) {
      expect(route.schema, `${route.method} ${route.path}`).toMatchObject({
        params: expect.any(Object),
        querystring: expect.any(Object),
        response: expect.any(Object),
      })
      if (['POST', 'PUT', 'PATCH'].includes(route.method)) {
        expect(route.schema).toHaveProperty('body')
      }
    }
  })

  it('rejects a non-numeric expert version before rollback runs', async () => {
    const app = Fastify({ logger: false })
    let called = false
    const routes = createWritingStyleRoutes({
      store: { rollbackStyleExpert: () => { called = true; return null } },
      promptBuilder: {},
    } as any)
    const route = routes.find(item => item.method === 'POST' && item.path.endsWith('/rollback'))!
    registerPluginRoute(app, 'novel', route)
    await app.ready()
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugins/novel/projects/project-1/writing-style-experts/expert-1/rollback',
      payload: { version: 'latest' },
    })
    expect(response.statusCode).toBe(400)
    expect(called).toBe(false)
    await app.close()
  })
})
