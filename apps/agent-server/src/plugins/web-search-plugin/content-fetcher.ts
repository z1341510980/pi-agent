import { request } from 'undici'
import type { FetchResult } from './types.js'
import { assertPublicUrl } from './ssrf-guard.js'

const USER_AGENT =
  'Mozilla/5.0 (compatible; PiAgent/1.0; +https://pi-agent.local)'

/** 响应体大小上限：1MB */
const MAX_BODY_LENGTH = 1 * 1024 * 1024

/** 最大重定向跟随次数 */
const MAX_REDIRECTS = 3

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
  // 外部 signal 已 aborted 时早返回
  if (options?.signal?.aborted) {
    return { ok: false, url, error: '请求已被取消' }
  }

  const timeoutMs = options?.timeoutMs ?? 8000
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  // 外部 signal 触发时也中止内部
  const onExternalAbort = () => controller.abort()
  options?.signal?.addEventListener('abort', onExternalAbort, { once: true })

  // 提升到 try 外，便于 catch 中清理
  let response: Awaited<ReturnType<typeof request>> | null = null
  let currentUrl = url

  try {
    // 手动跟随重定向，每次都校验目标 URL 安全性
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      await assertPublicUrl(currentUrl)
      response = await request(currentUrl, {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        signal: controller.signal,
      })

      // 3xx 重定向：校验 Location 后重新发起
      if (
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        await response.body.dump().catch(() => {})
        const location = Array.isArray(response.headers.location)
          ? response.headers.location[0]
          : response.headers.location
        currentUrl = new URL(location, currentUrl).toString()
        response = null
        continue
      }
      break
    }

    if (!response) {
      return { ok: false, url, error: '重定向次数过多' }
    }

    if (response.statusCode !== 200) {
      await response.body.dump()
      return {
        ok: false,
        url: currentUrl,
        statusCode: response.statusCode,
        error: `HTTP ${response.statusCode}`,
      }
    }

    // 限制响应体大小，读前 1MB
    const chunks: Buffer[] = []
    let totalLength = 0
    let oversized = false
    for await (const chunk of response.body) {
      totalLength += chunk.length
      if (totalLength > MAX_BODY_LENGTH) {
        oversized = true
        break
      }
      chunks.push(chunk as Buffer)
    }
    if (oversized) {
      await response.body.dump().catch(() => {})
    }

    const html = Buffer.concat(chunks).toString('utf-8')

    return {
      ok: true,
      html,
      url: currentUrl,
      statusCode: response.statusCode,
    }
  } catch (err) {
    // 清理已返回 response 的 body
    await response?.body?.dump().catch(() => {})
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
