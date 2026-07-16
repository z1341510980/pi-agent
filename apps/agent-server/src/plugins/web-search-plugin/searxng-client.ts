import { request } from 'undici'
import type { SearXngResult, SearXngSearchOptions } from './types.js'

/** SearXNG 调用错误 */
export class SearXngError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message)
    this.name = 'SearXngError'
  }
}

/**
 * 调用 SearXNG /search API
 *
 * @param baseUrl SearXNG 实例地址，如 http://localhost:8888
 * @param options 搜索选项
 * @param signal 中止信号
 */
export async function searchSearXng(
  baseUrl: string,
  options: SearXngSearchOptions,
  signal?: AbortSignal,
): Promise<SearXngResult[]> {
  const url = new URL('/search', baseUrl)
  url.searchParams.set('q', options.query)
  url.searchParams.set('format', 'json')
  if (options.timeRange) {
    url.searchParams.set('time_range', options.timeRange)
  }
  if (options.categories && options.categories.length > 0) {
    url.searchParams.set('categories', options.categories.join(','))
  }

  let response
  try {
    response = await request(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      headersTimeout: 5_000,
      bodyTimeout: 10_000,
      signal,
    })
  } catch (err) {
    throw new SearXngError(
      `SearXNG 不可达，请确认 ${baseUrl} 已启动（docker compose up）`,
      err,
    )
  }

  if (response.statusCode !== 200) {
    const text = await response.body.text()
    throw new SearXngError(
      `SearXNG 返回 ${response.statusCode}: ${text}`,
    )
  }

  const body = (await response.body.json()) as {
    results: Array<{
      title: string
      url: string
      content?: string
      engine?: string
      publishedDate?: string
    }>
    number_of_results?: number
  }

  if (!Array.isArray(body?.results)) {
    throw new SearXngError('SearXNG 返回格式异常：results 不是数组')
  }

  const max = options.maxResults ?? 5
  return body.results.slice(0, max).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content ?? '',
    engine: r.engine ?? 'unknown',
    publishedDate: r.publishedDate,
  }))
}
