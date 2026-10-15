import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { createVolumeRoutes } from '../routes/volume-routes.js'
import type { NovelServices } from '../novel-services.js'
import { registerPluginRoute } from '../../plugin-loader.plugin.js'

describe('volume route contracts', () => {
  it('declares request and response schemas for every volume endpoint', () => {
    const routes = createVolumeRoutes({ store: {} } as unknown as NovelServices)
    expect(routes).toHaveLength(4)
    for (const route of routes) {
      expect(route.schema).toMatchObject({
        params: expect.any(Object),
        querystring: expect.any(Object),
        response: expect.any(Object),
      })
      if (route.method === 'POST' || route.method === 'PATCH') {
        expect(route.schema).toHaveProperty('body')
      }
    }
  })

  it('enforces volume params and body through the plugin route registrar', async () => {
    const app = Fastify({ logger: false })
    const routes = createVolumeRoutes({
      store: {
        listVolumes: () => [],
        createVolume: (input: unknown) => input,
        updateVolume: () => null,
        deleteVolume: () => true,
      },
    } as unknown as NovelServices)
    const createRoute = routes.find(route => route.method === 'POST')!
    registerPluginRoute(app, 'novel', createRoute)
    await app.ready()

    const invalidParams = await app.inject({
      method: 'POST',
      url: '/api/plugins/novel/projects/x/volumes',
      payload: { volumeNumber: 1 },
    })
    expect(invalidParams.statusCode).toBe(400)

    const invalidBody = await app.inject({
      method: 'POST',
      url: '/api/plugins/novel/projects/00000000-0000-0000-0000-000000000001/volumes',
      payload: { volumeNumber: 0 },
    })
    expect(invalidBody.statusCode).toBe(400)

    await app.close()
  })
})
