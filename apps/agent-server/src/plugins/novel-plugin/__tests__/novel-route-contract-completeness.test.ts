import { describe, expect, it } from 'vitest'
import { createNovelRoutes } from '../novel-routes.js'

describe('novel route contract completeness', () => {
  it('attaches params/query/body/response metadata to every registered route', () => {
    const routes = createNovelRoutes({} as any)
    expect(routes.length).toBeGreaterThan(200)
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
})
