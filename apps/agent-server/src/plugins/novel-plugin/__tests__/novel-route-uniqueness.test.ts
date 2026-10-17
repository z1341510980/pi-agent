import { describe, expect, it } from 'vitest'
import { createNovelRoutes } from '../novel-routes.js'

describe('novel route uniqueness', () => {
  it('registers each METHOD + path exactly once', () => {
    const routes = createNovelRoutes({} as any)
    const keys = routes.map((route) => `${route.method} ${route.path}`)
    const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index)
    expect(duplicates).toEqual([])
  })
})
