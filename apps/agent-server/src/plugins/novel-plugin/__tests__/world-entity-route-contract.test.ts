import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerPluginRoute } from '../../plugin-loader.plugin.js'
import { createWorldEntityRoutes } from '../routes/world-entity-routes.js'

describe('world-entity route contracts', () => {
  it('declares Fastify schemas for every world-entity endpoint', () => {
    const routes = createWorldEntityRoutes({ store: {} } as any)
    expect(routes).toHaveLength(13)
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

  it('rejects an empty faction name before the handler runs', async () => {
    const app = Fastify({ logger: false })
    let called = false
    const routes = createWorldEntityRoutes({
      store: { createFaction: () => { called = true; return {} } },
    } as any)
    const route = routes.find(item => item.method === 'POST' && item.path.endsWith('/factions'))!
    registerPluginRoute(app, 'novel', route)
    await app.ready()
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugins/novel/projects/project-1/factions',
      payload: { name: '' },
    })
    expect(response.statusCode).toBe(400)
    expect(called).toBe(false)
    await app.close()
  })

  it('does not inject create defaults into a partial faction update', async () => {
    const app = Fastify({ logger: false })
    let patch: Record<string, unknown> | undefined
    const routes = createWorldEntityRoutes({
      store: { updateFaction: (_id: string, input: Record<string, unknown>) => { patch = input; return input } },
    } as any)
    const route = routes.find(item => item.method === 'PATCH' && item.path === '/factions/:id')!
    registerPluginRoute(app, 'novel', route)
    await app.ready()
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/plugins/novel/factions/faction-1',
      payload: { description: 'updated' },
    })
    expect(response.statusCode).toBe(200)
    expect(patch).toEqual({ description: 'updated' })
    await app.close()
  })
})
