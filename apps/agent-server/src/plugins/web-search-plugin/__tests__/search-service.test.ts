import { describe, it, expect, vi, beforeEach } from 'vitest'
import { search } from '../search-service.js'

// Mock searxng-client
vi.mock('../searxng-client.js', () => ({
  searchSearXng: vi.fn(),
  SearXngError: class SearXngError extends Error {},
}))

// Mock content-fetcher
vi.mock('../content-fetcher.js', () => ({
  fetchUrl: vi.fn(),
}))

// Mock content-extractor
vi.mock('../content-extractor.js', () => ({
  extractContent: vi.fn(),
}))

import { searchSearXng, SearXngError } from '../searxng-client.js'
import { fetchUrl } from '../content-fetcher.js'
import { extractContent } from '../content-extractor.js'

const OPTIONS = {
  searxngUrl: 'http://localhost:8888',
  maxResults: 2,
  fetchTimeoutMs: 5000,
  maxContentChars: 200,
  concurrency: 2,
}

describe('search', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('完整流程：搜索→抓取→提取→汇总', async () => {
    ;(searchSearXng as any).mockResolvedValue([
      { title: '文章A', url: 'https://a.com', snippet: '摘要A', engine: 'google' },
      { title: '文章B', url: 'https://b.com', snippet: '摘要B', engine: 'bing' },
    ])
    ;(fetchUrl as any).mockImplementation(async (url: string) => ({
      ok: true,
      html: `<html><body><article><p>${url} 正文</p></article></body></html>`,
      url,
      statusCode: 200,
    }))
    ;(extractContent as any).mockImplementation(async (html: string) => ({
      ok: true,
      title: '提取标题',
      content: '# 提取标题\n\n这是正文内容',
    }))

    const result = await search('茶文化', OPTIONS)

    expect(result.ok).toBe(true)
    expect(result.results).toHaveLength(2)
    expect(result.results[0].title).toBe('文章A')
    expect(result.results[0].contentStatus).toBe('fetched')
    expect(result.results[0].content).toContain('正文内容')
  })

  it('抓取失败时回退到 snippet', async () => {
    ;(searchSearXng as any).mockResolvedValue([
      { title: '文章A', url: 'https://a.com', snippet: '摘要A', engine: 'google' },
    ])
    ;(fetchUrl as any).mockResolvedValue({
      ok: false,
      url: 'https://a.com',
      error: '超时',
    })

    const result = await search('茶文化', OPTIONS)

    expect(result.ok).toBe(true)
    expect(result.results[0].contentStatus).toBe('fallback')
    expect(result.results[0].content).toBe('摘要A')
  })

  it('提取失败时回退到 snippet', async () => {
    ;(searchSearXng as any).mockResolvedValue([
      { title: '文章A', url: 'https://a.com', snippet: '摘要A', engine: 'google' },
    ])
    ;(fetchUrl as any).mockResolvedValue({
      ok: true,
      html: '<html></html>',
      url: 'https://a.com',
    })
    ;(extractContent as any).mockResolvedValue({
      ok: false,
      error: '无法提取',
    })

    const result = await search('茶文化', OPTIONS)

    expect(result.results[0].contentStatus).toBe('fallback')
    expect(result.results[0].content).toBe('摘要A')
  })

  it('SearXNG 错误返回 ok:false', async () => {
    ;(searchSearXng as any).mockRejectedValue(
      new SearXngError('SearXNG 不可达'),
    )

    const result = await search('茶文化', OPTIONS)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('SearXNG 不可达')
    expect(result.results).toEqual([])
  })

  it('正文超过 maxContentChars 时截断', async () => {
    const longContent = 'A'.repeat(500)
    ;(searchSearXng as any).mockResolvedValue([
      { title: '文章A', url: 'https://a.com', snippet: '摘要', engine: 'google' },
    ])
    ;(fetchUrl as any).mockResolvedValue({
      ok: true,
      html: '<html></html>',
      url: 'https://a.com',
    })
    ;(extractContent as any).mockResolvedValue({
      ok: true,
      title: '标题',
      content: longContent,
    })

    const result = await search('茶文化', { ...OPTIONS, maxContentChars: 100 })

    expect(result.results[0].content.length).toBeLessThanOrEqual(103)
    expect(result.results[0].content.endsWith('...')).toBe(true)
  })
})
