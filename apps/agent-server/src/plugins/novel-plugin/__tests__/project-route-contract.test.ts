import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { createProjectRoutes } from '../routes/project-routes.js'
import type { NovelServices } from '../novel-services.js'
import { registerPluginRoute } from '../../plugin-loader.plugin.js'

describe('project route contracts', () => {
  it('declares Fastify schemas for every project lifecycle endpoint', () => {
    const routes = createProjectRoutes({ store: {}, orchestrator: {} } as unknown as NovelServices)
    expect(routes).toHaveLength(9)
    for (const route of routes) {
      expect(route.schema).toMatchObject({
        querystring: expect.any(Object),
        response: expect.any(Object),
      })
      if (route.path.includes(':id')) expect(route.schema).toHaveProperty('params')
      if (route.method === 'POST' && route.path === '/projects') expect(route.schema).toHaveProperty('body')
      if (route.method === 'PATCH') expect(route.schema).toHaveProperty('body')
    }
  })

  it('declares project creation defaults in the Fastify request schema', () => {
    const createRoute = createProjectRoutes({ store: {}, orchestrator: {} } as unknown as NovelServices)
      .find(route => route.method === 'POST' && route.path === '/projects')!

    const properties = (createRoute.schema?.body as { properties: Record<string, Record<string, unknown>> }).properties
    expect(properties).toMatchObject({
      synopsis: { default: '' },
      targetWords: { default: 0 },
    })
  })

  it('rejects invalid project create input before the handler runs', async () => {
    const app = Fastify({ logger: false })
    let called = false
    const routes = createProjectRoutes({
      store: {
        createProject: () => { called = true; return {} },
      },
      orchestrator: {},
    } as unknown as NovelServices)
    registerPluginRoute(app, 'novel', routes.find(route => route.path === '/projects' && route.method === 'POST')!)
    await app.ready()

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/plugins/novel/projects',
      payload: { title: '', genre: 'test', targetWords: -1 },
    })
    expect(invalid.statusCode).toBe(400)
    expect(called).toBe(false)

    await app.close()
  })

  it('passes schema defaults to project creation when optional fields are omitted', async () => {
    const app = Fastify({ logger: false })
    let createdInput: Record<string, unknown> | undefined
    const routes = createProjectRoutes({
      store: {
        createProject: (input: Record<string, unknown>) => { createdInput = input; return input },
      },
      orchestrator: {},
    } as unknown as NovelServices)
    registerPluginRoute(app, 'novel', routes.find(route => route.method === 'POST' && route.path === '/projects')!)
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/api/plugins/novel/projects',
      payload: { title: '测试项目', genre: '奇幻', unknownField: 'ignored' },
    })

    expect(response.statusCode).toBe(200)
    expect(createdInput).toMatchObject({ synopsis: '', targetWords: 0 })
    expect(createdInput).not.toHaveProperty('unknownField')
    await app.close()
  })

  it('rejects malformed project model references before updating the project', async () => {
    const app = Fastify({ logger: false })
    let called = false
    const routes = createProjectRoutes({
      store: { updateProject: () => { called = true; return {} } },
      orchestrator: {},
    } as unknown as NovelServices)
    registerPluginRoute(app, 'novel', routes.find(route => route.method === 'PATCH')!)
    await app.ready()

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/plugins/novel/projects/project-1',
      payload: { novelModelId: 'missing-separator' },
    })

    expect(response.statusCode).toBe(400)
    expect(called).toBe(false)
    await app.close()
  })
})
