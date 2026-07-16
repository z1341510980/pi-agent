import type { FastifyPluginAsync } from 'fastify'
import { success, failure } from '../lib/api-response.js'
import { ErrorCode } from '@repo/shared/errors'
import { search } from '../plugins/web-search-plugin/search-service.js'
import { envInt } from '../plugins/web-search-plugin/env.js'

export const searchRoute: FastifyPluginAsync = async (app) => {
  if (process.env.NODE_ENV === 'production') return

  // GET /api/search?q={query}&max={n}
  app.get('/api/search', async (request, reply) => {
    const query = (request.query as { q?: string }).q
    if (!query) {
      reply.status(400)
      return failure(
        ErrorCode.VALIDATION_ERROR,
        '缺少查询参数 q',
        request.traceId,
      )
    }

    const rawMax = Number((request.query as { max?: string }).max ?? 3)
    const maxResults = Math.min(
      Math.max(Number.isFinite(rawMax) ? rawMax : 3, 1),
      5,
    )

    const ac = new AbortController()
    if (request.raw.aborted) ac.abort()
    request.raw.on('close', () => ac.abort())

    const result = await search(
      query,
      {
        searxngUrl: process.env.SEARXNG_URL ?? 'http://localhost:8888',
        maxResults,
        fetchTimeoutMs: envInt('WEB_SEARCH_FETCH_TIMEOUT', 8000),
        maxContentChars: envInt('WEB_SEARCH_MAX_CONTENT_CHARS', 2000),
        concurrency: envInt('WEB_SEARCH_CONCURRENCY', 3),
      },
      ac.signal,
    )

    return success(result, request.traceId)
  })
}
