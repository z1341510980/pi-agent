import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerPluginRoute } from '../../plugin-loader.plugin.js'
import { createEntityPlotRoutes } from '../routes/entity-plot-routes.js'

describe('entity-plot route contracts', () => {
  it('declares Fastify schemas for every entity-plot endpoint', () => {
    const routes = createEntityPlotRoutes({ store: {} } as any)
    expect(routes).toHaveLength(16)
    for (const route of routes) {
      expect(route.schema, `${route.method} ${route.path}`).toMatchObject({
        params: expect.any(Object),
        querystring: expect.any(Object),
        response: expect.any(Object),
      })
      if (['POST', 'PATCH', 'PUT'].includes(route.method)) {
        expect(route.schema).toHaveProperty('body')
      }
    }
  })

  it('rejects an out-of-range conflict intensity before the handler runs', async () => {
    const app = Fastify({ logger: false })
    let called = false
    const routes = createEntityPlotRoutes({
      store: { createConflict: () => { called = true; return {} } },
    } as any)
    const route = routes.find(item => item.method === 'POST' && item.path.endsWith('/conflicts'))!
    registerPluginRoute(app, 'novel', route)
    await app.ready()
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugins/novel/projects/project-1/conflicts',
      payload: { description: '冲突', type: 'inner', intensity: 11 },
    })
    expect(response.statusCode).toBe(400)
    expect(called).toBe(false)
    await app.close()
  })
})
