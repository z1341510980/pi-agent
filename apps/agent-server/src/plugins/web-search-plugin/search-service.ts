import { searchSearXng, SearXngError } from './searxng-client.js'
import { fetchUrl } from './content-fetcher.js'
import { extractContent } from './content-extractor.js'
import type {
  SearchResponse,
  SearchResultItem,
  SearchServiceOptions,
} from './types.js'

/**
 * 联网搜索编排：搜索→抓取→清洗→汇总
 *
 * 流程：
 * 1. 调用 SearXNG 元搜索获取候选结果
 * 2. 按配置并发数分批抓取页面 HTML
 * 3. 用 readability 提取正文并转 Markdown
 * 4. 抓取/提取失败时回退到 SearXNG 返回的 snippet
 * 5. 正文超过 maxContentChars 时截断并补省略号
 *
 * @param query 搜索查询
 * @param options 服务配置
 * @param signal 中止信号
 */
export async function search(
  query: string,
  options: SearchServiceOptions,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  // 1. 调 SearXNG 搜索
  let searxResults
  try {
    searxResults = await searchSearXng(
      options.searxngUrl,
      { query, maxResults: options.maxResults },
      signal,
    )
  } catch (err) {
    return {
      ok: false,
      results: [],
      total: 0,
      error: err instanceof SearXngError
        ? err.message
        : `搜索失败: ${(err as Error).message}`,
    }
  }

  // 2. 并发抓取+提取（按 concurrency 分批，批内并行）
  const items: SearchResultItem[] = []
  for (let i = 0; i < searxResults.length; i += options.concurrency) {
    const batch = searxResults.slice(i, i + options.concurrency)
    const batchResults = await Promise.all(
      batch.map(async (r) => {
        // 默认回退到 snippet
        let content = r.snippet
        let status: SearchResultItem['contentStatus'] = 'fallback'

        const fetched = await fetchUrl(r.url, {
          timeoutMs: options.fetchTimeoutMs,
          signal,
        })

        if (fetched.ok && fetched.html) {
          const extracted = await extractContent(fetched.html, r.url)
          if (extracted.ok && extracted.content) {
            content = extracted.content
            status = 'fetched'
          }
          // 抓取成功但提取失败：保持 fallback
        }
        // 抓取失败：保持 fallback

        // 截断过长正文
        if (content.length > options.maxContentChars) {
          content = content.slice(0, options.maxContentChars) + '...'
        }

        return {
          title: r.title,
          url: r.url,
          engine: r.engine,
          snippet: r.snippet,
          content,
          contentStatus: status,
        } satisfies SearchResultItem
      }),
    )
    items.push(...batchResults)
  }

  return {
    ok: true,
    results: items,
    total: searxResults.length,
  }
}
