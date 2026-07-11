import { request, Agent, interceptors } from 'undici'
import type { FetchResult } from './types.js'

const USER_AGENT =
  'Mozilla/5.0 (compatible; PiAgent/1.0; +https://pi-agent.local)'

/** 响应体大小上限：5MB */
const MAX_BODY_LENGTH = 5 * 1024 * 1024

/** 复用连接池，自动跟随最多 3 次重定向 */
const redirectAgent = new Agent().compose(
  interceptors.redirect({ maxRedirections: 3 }),
)

/**
 * 用 undici 抓取目标 URL 的 HTML
 *
 * @param url 目标 URL
 * @param options.timeoutMs 超时毫秒（默认 8000）
 * @param signal 外部中止信号
 */
export async function fetchUrl(
  url: string,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<FetchResult> {
  const timeoutMs = options?.timeoutMs ?? 8000
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  // 外部 signal 触发时也中止内部
  const onExternalAbort = () => controller.abort()
  options?.signal?.addEventListener('abort', onExternalAbort, { once: true })

  try {
    const response = await request(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      dispatcher: redirectAgent,
      signal: controller.signal,
    })

    if (response.statusCode !== 200) {
      await response.body.dump()
      return {
        ok: false,
        url,
        statusCode: response.statusCode,
        error: `HTTP ${response.statusCode}`,
      }
    }

    // 限制响应体大小，读前 5MB
    const chunks: Buffer[] = []
    let totalLength = 0
    for await (const chunk of response.body) {
      totalLength += chunk.length
      if (totalLength > MAX_BODY_LENGTH) {
        break
      }
      chunks.push(chunk as Buffer)
    }

    const html = Buffer.concat(chunks).toString('utf-8')

    return {
      ok: true,
      html,
      url,
      statusCode: response.statusCode,
    }
  } catch (err) {
    const isTimeout =
      err instanceof Error && err.name === 'AbortError'
    return {
      ok: false,
      url,
      error: isTimeout ? `抓取超时（${timeoutMs}ms）` : (err as Error).message,
    }
  } finally {
    clearTimeout(timeout)
    options?.signal?.removeEventListener('abort', onExternalAbort)
  }
}
