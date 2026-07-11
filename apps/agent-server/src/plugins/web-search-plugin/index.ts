/**
 * 联网搜索插件
 *
 * 基于 SearXNG 元搜索 + readability 正文提取
 * 通过 registerSessionTools 注入 web_search 工具到 pi-session
 *
 * 依赖：
 * - SearXNG 容器（docker compose up 启动，默认 http://localhost:8888）
 * - 环境变量 SEARXNG_URL 覆盖默认地址
 * - 可选环境变量：WEB_SEARCH_FETCH_TIMEOUT / WEB_SEARCH_MAX_CONTENT_CHARS / WEB_SEARCH_CONCURRENCY
 */

import { Type } from 'typebox'
import { defineTool } from '@earendil-works/pi-coding-agent'
import type { Plugin } from '../../core/plugin/plugin-types.js'
import { search } from './search-service.js'

/** 安全读取环境变量整数，非法值回退到 fallback */
function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

/** web_search 工具参数 Schema（TypeBox） */
const WebSearchParams = Type.Object({
  query: Type.String({ description: '搜索查询词' }),
  max_results: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 5,
      description: '返回并抓取正文的结果数（1-5），默认 3',
    }),
  ),
  time_range: Type.Optional(
    Type.Union(
      [
        Type.Literal('day'),
        Type.Literal('week'),
        Type.Literal('month'),
        Type.Literal('year'),
      ],
      { description: '时间范围过滤，不传则不限时间' },
    ),
  ),
})

/**
 * web_search 工具定义
 *
 * 注意：PiToolDefinition 的 execute 为 5 参数签名
 * (toolCallId, params, signal, onUpdate, ctx)，由 createAgentSession 调用。
 * 这里只用前 3 个参数（query/params/signal）。
 */
const webSearchTool = defineTool({
  name: 'web_search',
  label: '联网搜索',
  description:
    '联网搜索最新信息。用于查证历史背景、地理、专业知识、时事等小说创作所需的真实世界信息。' +
    '返回每条结果的标题、链接、摘要和正文（Markdown）。',
  parameters: WebSearchParams,
  async execute(_toolCallId, params, signal) {
    const maxResults = Math.min(Math.max(params.max_results ?? 3, 1), 5)

    const result = await search(
      params.query,
      {
        searxngUrl: process.env.SEARXNG_URL ?? 'http://localhost:8888',
        maxResults,
        fetchTimeoutMs: envInt('WEB_SEARCH_FETCH_TIMEOUT', 8000),
        maxContentChars: envInt('WEB_SEARCH_MAX_CONTENT_CHARS', 2000),
        concurrency: envInt('WEB_SEARCH_CONCURRENCY', 3),
      },
      signal ?? undefined,
    )

    // 失败时 result.error 透传到 tool result 文本里
    // 成功时把整个 SearchResponse 序列化给 LLM（含每条的 title/url/snippet/content）
    const text = result.ok
      ? JSON.stringify(
          {
            ok: true,
            total: result.total,
            results: result.results.map((r) => ({
              title: r.title,
              url: r.url,
              engine: r.engine,
              snippet: r.snippet,
              content: r.content,
              contentStatus: r.contentStatus,
            })),
          },
          null,
          2,
        )
      : JSON.stringify({ ok: false, error: result.error }, null, 2)

    return {
      content: [{ type: 'text' as const, text }],
      details: result,
    }
  },
})

/** 创建联网搜索插件实例 */
export function createWebSearchPlugin(): Plugin {
  return {
    manifest: {
      name: 'web-search',
      version: '0.1.0',
      description: '联网搜索工具，基于 SearXNG 元搜索 + 正文提取',
      builtin: true,
    },

    setup(context) {
      context.registerSessionTools([webSearchTool])
    },
  }
}

export default createWebSearchPlugin
