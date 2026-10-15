import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { Type } from 'typebox'
import { registerPluginRoute } from '../../plugin-loader.plugin.js'
import { createReferenceTemplateRoutes } from '../routes/reference-template-routes.js'

describe('reference-template binding route contracts', () => {
  it('declares Fastify schemas for params, query, body, and response', () => {
    const routes = createReferenceTemplateRoutes({
      referenceAnalysis: {},
      referenceProfiles: {},
      referenceTemplates: {},
      referenceTemplateBindings: {},
      referenceValidationRuns: {},
      referenceValidationWorker: {},
    } as any)
    const bindingRoutes = routes.filter(route => route.path.includes('/reference-template-bindings'))
    expect(bindingRoutes).toHaveLength(4)
    for (const route of bindingRoutes) {
      expect(route.schema).toMatchObject({
        params: expect.any(Object),
        querystring: expect.any(Object),
        response: expect.any(Object),
      })
      expect(route.schema?.querystring).toMatchObject({ additionalProperties: true })
      if (route.method === 'PUT' || route.method === 'POST') {
        expect(route.schema).toHaveProperty('body')
      }
    }
  })

  it('plugin loader forwards route schemas to Fastify registration', async () => {
    const app = Fastify({ logger: false })
    const handler = vi.fn(async () => ({ ok: true, secret: 'not-public' }))

    registerPluginRoute(app, 'contract-test', {
      method: 'POST',
      path: '/schema-check/:id',
      schema: {
        params: Type.Object({ id: Type.String({ minLength: 2 }) }),
        querystring: Type.Object({}, { additionalProperties: true }),
        body: Type.Object({ name: Type.String({ minLength: 3 }) }),
        response: { 200: Type.Object({ ok: Type.Boolean() }) },
      },
      handler,
    })
    await app.ready()

    const invalidParams = await app.inject({
      method: 'POST',
      url: '/api/plugins/contract-test/schema-check/x',
      payload: { name: 'valid' },
    })
    expect(invalidParams.statusCode).toBe(400)
    expect(handler).not.toHaveBeenCalled()

    const valid = await app.inject({
      method: 'POST',
      url: '/api/plugins/contract-test/schema-check/ok?trace=1',
      payload: { name: 'valid' },
    })
    expect(valid.statusCode).toBe(200)
    expect(valid.json()).toEqual({ ok: true })
    expect(handler).toHaveBeenCalledOnce()

    const invalidBody = await app.inject({
      method: 'POST',
      url: '/api/plugins/contract-test/schema-check/ok',
      payload: { name: 'x' },
    })
    expect(invalidBody.statusCode).toBe(400)

    await app.close()
  })
})
