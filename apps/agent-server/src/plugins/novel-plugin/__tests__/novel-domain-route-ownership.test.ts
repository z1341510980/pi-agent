import { describe, expect, it } from 'vitest'
import { createWorldSettingRoutes } from '../routes/world-setting-routes.js'
import { createWritingStyleRoutes } from '../routes/writing-style-routes.js'
import { createWorldEntityRoutes } from '../routes/world-entity-routes.js'

describe('novel route domain ownership', () => {
  it('keeps setting, writing-style, and world-entity APIs in dedicated modules', () => {
    const services = {} as any
    expect(createWorldSettingRoutes(services).map((route) => route.path)).toEqual(expect.arrayContaining([
      '/projects/:projectId/world-rules',
      '/projects/:projectId/style-guides',
      '/projects/:projectId/constraints',
      '/projects/:projectId/info-layers',
    ]))
    expect(createWritingStyleRoutes(services).map((route) => route.path)).toEqual(expect.arrayContaining([
      '/projects/:projectId/writing-style-profile',
      '/projects/:projectId/writing-style-profile/preview',
      '/projects/:projectId/writing-style-experts',
    ]))
    expect(createWorldEntityRoutes(services).map((route) => route.path)).toEqual(expect.arrayContaining([
      '/projects/:projectId/factions',
      '/projects/:projectId/locations',
      '/projects/:projectId/items',
      '/projects/:projectId/world-elements',
    ]))
  })
})
