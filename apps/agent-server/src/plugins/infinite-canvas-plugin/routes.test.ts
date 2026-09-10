import { describe, expect, it } from 'vitest'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInfiniteCanvasRoutes } from './routes.js'
import type { RouteDefinition } from '../../core/plugin/plugin-types.js'
import type { CanvasAssetStore } from './canvas-assets.js'

type ReplyMock = {
  code: (statusCode: number) => ReplyMock
  send: (payload: unknown) => unknown
  header: (name: string, value: string) => ReplyMock
  redirect: (url: string, code: number) => unknown
  statusCode: number
  payload: unknown
  headers: Record<string, string>
}

function replyMock(): ReplyMock {
  const reply: ReplyMock = {
    code: (statusCode: number) => {
      reply.statusCode = statusCode
      return reply
    },
    send: (payload: unknown) => {
      reply.payload = payload
      return payload
    },
    header: (name: string, value: string) => {
      reply.headers[name] = value
      return reply
    },
    redirect: (url: string, code: number) => {
      reply.statusCode = code
      reply.headers.Location = url
      return undefined
    },
    statusCode: 200,
    payload: undefined,
    headers: {}
  }
  return reply
}

function routeFor(method: string, path: string): RouteDefinition {
  return createInfiniteCanvasRoutes(
    {
      getProject: () => ({ id: 'project-1' }),
      replaceGraph: () => {
        throw new Error('graph write failed')
      }
    } as never,
    undefined,
    async () => {
      throw new Error('provider rejected the image')
    },
    async () => {
      throw new Error('provider rejected the media')
    },
    async () => {
      throw new Error('provider rejected the edit')
    },
    async () => {
      throw new Error('provider rejected the reverse prompt')
    }
  ).find((route) => route.method === method && route.path === path)!
}

describe('infinite canvas route table', () => {
  /** 桌面端 infinite-canvas-client.ts 实际调用的方法+路径，方法写错会直接 404。 */
  it('matches the method and path pairs the desktop client calls', () => {
    const table = createInfiniteCanvasRoutes({} as never).map(
      (route) => `${route.method} ${route.path}`
    )

    expect(table).toEqual(
      expect.arrayContaining([
        'GET /proxy-image',
        'GET /media-config',
        'PUT /media-config',
        'GET /prompt-sources',
        'GET /prompt-items',
        'GET /prompt-tags',
        'POST /prompt-sources/refresh',
        'PATCH /prompt-sources/:sourceId/toggle',
        'GET /projects',
        'POST /projects',
        'GET /projects/:projectId',
        'PATCH /projects/:projectId',
        'DELETE /projects/:projectId',
        'PUT /projects/:projectId/graph',
        'POST /projects/:projectId/generate',
        'POST /projects/:projectId/generate-image',
        'POST /projects/:projectId/generate-media',
        'POST /projects/:projectId/edit-image',
        'POST /projects/:projectId/reverse-prompt',
        'GET /assets/:assetId',
        'POST /assets',
        'GET /media-logs'
      ])
    )
  })
})

describe('infinite canvas asset route', () => {
  const assetsDir = mkdtempSync(join(tmpdir(), 'canvas-assets-route-'))
  const file = join(assetsDir, 'ready.png')
  writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'))

  function assetStore(status: 'ready' | 'downloading'): CanvasAssetStore {
    return {
      getAssetByPath: (path: string) => ({
        id: path.split('/').pop() ?? '',
        projectId: 'p1',
        filePath: file,
        mime: 'image/png',
        bytes: 8,
        sourceUrl: 'https://cdn.example.com/source.png',
        status,
        createdAt: 0
      })
    } as unknown as CanvasAssetStore
  }

  function assetRouteFor(status: 'ready' | 'downloading'): RouteDefinition {
    return createInfiniteCanvasRoutes({} as never, undefined, undefined, undefined, undefined, undefined, undefined, undefined, assetStore(status)).find(
      (route) => route.method === 'GET' && route.path === '/assets/:assetId'
    )!
  }

  it('serves ready assets with a permissive CORS header so renderer canvases stay exportable', async () => {
    const reply = replyMock()
    await assetRouteFor('ready').handler({ params: { assetId: 'a-1' } }, reply)

    expect(reply.statusCode).toBe(200)
    expect(reply.headers['Content-Type']).toBe('image/png')
    expect(reply.headers['Access-Control-Allow-Origin']).toBe('*')
  })

  it('keeps the CORS header on the 302 fallback so canvas workflows can follow redirects', async () => {
    const reply = replyMock()
    await assetRouteFor('downloading').handler({ params: { assetId: 'a-1' } }, reply)

    expect(reply.statusCode).toBe(302)
    expect(reply.headers.Location).toBe('https://cdn.example.com/source.png')
    expect(reply.headers['Access-Control-Allow-Origin']).toBe('*')
  })
})

describe('infinite canvas asset upload route', () => {
  it('stores an uploaded data URL and returns a local asset path', async () => {
    const assetsDir = mkdtempSync(join(tmpdir(), 'canvas-upload-'))
    const { default: Database } = await import('better-sqlite3')
    const { infiniteCanvasMigrations } = await import('./migrations.js')
    const db = new Database(':memory:')
    for (const migration of infiniteCanvasMigrations) db.exec(migration.sql)
    const assets = new (await import('./canvas-assets.js')).CanvasAssetStore(db, assetsDir)
    const route = createInfiniteCanvasRoutes({} as never, undefined, undefined, undefined, undefined, undefined, undefined, undefined, assets).find(
      (entry) => entry.method === 'POST' && entry.path === '/assets'
    )!
    const reply = replyMock()

    const result = (await route.handler(
      { body: { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==' } },
      reply
    )) as { ok: boolean; data: { path: string } }

    expect(reply.statusCode).toBe(200)
    expect(result.ok).toBe(true)
    expect(result.data.path).toMatch(/^\/api\/plugins\/infinite-canvas\/assets\//)

    const missing = (await route.handler({ body: {} }, reply)) as { ok: boolean }
    expect(missing.ok).toBe(false)
  })
})

describe('infinite canvas media-logs route', () => {
  it('returns the latest log entries from the store', async () => {
    const mediaLogs = {
      list: (limit: number) =>
        limit === 50
          ? [
              {
                id: 'log-1',
                kind: 'edit',
                projectId: 'p1',
                endpoint: '/images/edits',
                model: 'gpt-image-2',
                size: '864x1536',
                prompt: '把背景换成竹林',
                references: [{ preview: '/api/plugins/infinite-canvas/assets/a-1', bytes: 123 }],
                maskPath: '/api/plugins/infinite-canvas/assets/m-1',
                responseImages: ['/api/plugins/infinite-canvas/assets/r-1'],
                error: null,
                status: 'ok',
                durationMs: 36000,
                traceId: 't-1',
                createdAt: 1
              }
            ]
          : []
    }
    const route = createInfiniteCanvasRoutes(
      {} as never, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      mediaLogs as never
    ).find((entry) => entry.method === 'GET' && entry.path === '/media-logs')!
    const reply = replyMock()

    const result = (await route.handler({ query: {} }, reply)) as {
      ok: boolean
      data: Array<{ id: string; prompt: string; status: string }>
    }

    expect(reply.statusCode).toBe(200)
    expect(result).toMatchObject({
      ok: true,
      data: [{ id: 'log-1', prompt: '把背景换成竹林', status: 'ok' }]
    })
  })
})

describe('infinite canvas route errors', () => {
  it('returns a structured error when graph persistence fails', async () => {
    const reply = replyMock()
    await routeFor('PUT', '/projects/:projectId/graph').handler(
      {
        params: { projectId: 'project-1' },
        body: { nodes: [], connections: [] },
        traceId: 'trace-graph'
      },
      reply
    )

    expect(reply.statusCode).toBe(400)
    expect(reply.payload).toMatchObject({
      ok: false,
      error: { code: 'GRAPH_SAVE_FAILED', message: 'graph write failed' },
      meta: { traceId: 'trace-graph' }
    })
  })

  it('returns a structured error when image generation fails', async () => {
    const reply = replyMock()
    await routeFor('POST', '/projects/:projectId/generate-image').handler(
      {
        params: { projectId: 'project-1' },
        body: { prompt: 'a safe prompt' },
        traceId: 'trace-image'
      },
      reply
    )

    expect(reply.statusCode).toBe(502)
    expect(reply.payload).toMatchObject({
      ok: false,
      error: { code: 'IMAGE_GENERATION_FAILED', message: 'provider rejected the image' },
      meta: { traceId: 'trace-image' }
    })
  })

  it('returns structured errors with codes for media, edit and reverse-prompt failures', async () => {
    const cases: Array<{
      path: string
      body: Record<string, unknown>
      code: string
      message: string
    }> = [
      {
        path: '/projects/:projectId/generate-media',
        body: { mode: 'audio', prompt: 'a sound' },
        code: 'MEDIA_GENERATION_FAILED',
        message: 'provider rejected the media'
      },
      {
        path: '/projects/:projectId/edit-image',
        body: { prompt: 'a prompt', image: 'data:image/png;base64,AA==' },
        code: 'IMAGE_EDIT_FAILED',
        message: 'provider rejected the edit'
      },
      {
        path: '/projects/:projectId/reverse-prompt',
        body: { image: 'data:image/png;base64,AA==' },
        code: 'REVERSE_PROMPT_FAILED',
        message: 'provider rejected the reverse prompt'
      }
    ]

    for (const { path, body, code, message } of cases) {
      const reply = replyMock()
      await routeFor('POST', path).handler(
        { params: { projectId: 'project-1' }, body, traceId: 'trace-media' },
        reply
      )

      expect(reply.statusCode).toBe(502)
      expect(reply.payload).toMatchObject({
        ok: false,
        error: { code, message },
        meta: { traceId: 'trace-media' }
      })
    }
  })
})

describe('infinite canvas graph route node types', () => {
  it('saves design-board nodes on whole-graph sync and reads the type back', async () => {
    const { default: Database } = await import('better-sqlite3')
    const { infiniteCanvasMigrations } = await import('./migrations.js')
    const { InfiniteCanvasStore } = await import('./store.js')
    const db = new Database(':memory:')
    for (const migration of infiniteCanvasMigrations) db.exec(migration.sql)
    const store = new InfiniteCanvasStore(db)
    const project = store.createProject({ title: '设计画板项目' })
    const routes = createInfiniteCanvasRoutes(store)
    const putGraph = routes.find(
      (route) => route.method === 'PUT' && route.path === '/projects/:projectId/graph'
    )!
    const getProject = routes.find(
      (route) => route.method === 'GET' && route.path === '/projects/:projectId'
    )!
    const designDoc = { version: 1, width: 100, height: 100, background: '#ffffff', objects: [] }

    const putReply = replyMock()
    const saved = (await putGraph.handler(
      {
        params: { projectId: project.id },
        body: {
          nodes: [
            {
              id: 'board-1',
              type: 'design-board',
              title: '画板 1',
              content: '',
              x: 0,
              y: 0,
              width: 640,
              height: 480,
              metadata: designDoc
            }
          ],
          connections: []
        },
        traceId: 'trace-design-board'
      },
      putReply
    )) as { ok: boolean }

    expect(putReply.statusCode).toBe(200)
    expect(saved.ok).toBe(true)

    const getReply = replyMock()
    const fetched = await getProject.handler({ params: { projectId: project.id } }, getReply)

    expect(getReply.statusCode).toBe(200)
    expect(fetched).toMatchObject({
      ok: true,
      data: {
        nodes: [
          expect.objectContaining({ id: 'board-1', type: 'design-board', metadata: designDoc })
        ]
      }
    })
    db.close()
  })
})
