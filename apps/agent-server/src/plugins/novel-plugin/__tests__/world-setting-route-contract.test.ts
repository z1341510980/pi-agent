import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerPluginRoute } from '../../plugin-loader.plugin.js'
import { createWorldSettingRoutes } from '../routes/world-setting-routes.js'

describe('world-setting route contracts', () => {
  it('declares Fastify schemas for every world-setting endpoint', () => {
    const routes = createWorldSettingRoutes({ store: {} } as any)
    expect(routes).toHaveLength(11)
    for (const route of routes) {
      expect(route.schema, `${route.method} ${route.path}`).toMatchObject({
        params: expect.any(Object),
        querystring: expect.any(Object),
        response: expect.any(Object),
      })
      if (route.method === 'POST' || route.method === 'PATCH') {
        expect(route.schema).toHaveProperty('body')
      }
    }
  })

  it('rejects malformed link-delete queries before the handler runs', async () => {
    const app = Fastify({ logger: false })
    let called = false
    const routes = createWorldSettingRoutes({
      store: { listEdgesByEntity: () => { called = true; return [] } },
    } as any)
    const route = routes.find(item => item.method === 'DELETE' && item.path.endsWith('/foreshadow-info-layer-links'))!
    registerPluginRoute(app, 'novel', route)
    await app.ready()
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/plugins/novel/projects/project-1/foreshadow-info-layer-links?foreshadowId=',
    })
    expect(response.statusCode).toBe(400)
    expect(called).toBe(false)
    await app.close()
  })
})
