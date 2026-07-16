/**
 * 联网搜索服务类型定义
 */

/** SearXNG 单条搜索结果 */
export interface SearXngResult {
  title: string
  url: string
  /** SearXNG 返回的 content 字段（摘要） */
  snippet: string
  /** 来源引擎（google/bing/baidu/...） */
  engine: string
  publishedDate?: string
}

/** SearXNG 搜索选项 */
export interface SearXngSearchOptions {
  query: string
  maxResults?: number
  timeRange?: 'day' | 'week' | 'month' | 'year'
  categories?: string[]
}

/** URL 抓取结果 */
export interface FetchResult {
  ok: boolean
  html?: string
  /** 最终 URL（可能经过重定向） */
  url: string
  error?: string
  statusCode?: number
}

/** 正文提取结果 */
export interface ExtractionResult {
  ok: boolean
  title?: string
  content?: string
  error?: string
}

/** 搜索结果项（最终返回给 AI） */
export interface SearchResultItem {
  title: string
  url: string
  engine: string
  snippet: string
  /** Markdown 正文（截断到 maxContentChars） */
  content: string
  contentStatus: 'fetched' | 'fallback' | 'failed'
}

/** 搜索响应 */
export interface SearchResponse {
  ok: boolean
  results: SearchResultItem[]
  /** 返回的结果条数 */
  total: number
  error?: string
}

/** 搜索服务配置 */
export interface SearchServiceOptions {
  searxngUrl: string
  maxResults: number
  fetchTimeoutMs: number
  maxContentChars: number
  concurrency: number
  timeRange?: 'day' | 'week' | 'month' | 'year'
}

/** web_search 工具入参 */
export interface WebSearchArgs {
  query: string
  max_results?: number
  time_range?: 'day' | 'week' | 'month' | 'year'
}
