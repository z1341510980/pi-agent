import { describe, expect, it } from 'vitest'
import { createAgentConfigRoutes } from '../routes/agent-config-routes.js'
import { createAgentLogRoutes } from '../routes/agent-log-routes.js'
import { createCacheRoutes } from '../routes/cache-routes.js'
import { createContextPreviewRoutes } from '../routes/context-preview-routes.js'
import { createEntityDeleteRoutes } from '../routes/entity-delete-routes.js'
import { createInterjectRoutes } from '../routes/interject-routes.js'
import { createMarkerRoutes } from '../routes/marker-routes.js'
import { createNarrativeRoutes } from '../routes/narrative-routes.js'
import { createPromptRoutes } from '../routes/prompt-routes.js'

describe('small novel route contracts', () => {
  it('declares request and response schemas on every endpoint', () => {
    const routes = [
      ...createAgentConfigRoutes({} as any),
      ...createAgentLogRoutes({ store: {} } as any),
      ...createCacheRoutes({ store: {}, promptBuilder: {} } as any),
      ...createContextPreviewRoutes({} as any, {} as any, {} as any),
      ...createEntityDeleteRoutes({ store: {}, orchestrator: {} } as any),
      ...createInterjectRoutes({ orchestrator: {}, chapterChatStore: {} } as any),
      ...createMarkerRoutes({ store: {} } as any),
      ...createNarrativeRoutes({ store: {} } as any),
      ...createPromptRoutes({ store: {}, promptManager: {} } as any),
    ]
    expect(routes).toHaveLength(36)
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
