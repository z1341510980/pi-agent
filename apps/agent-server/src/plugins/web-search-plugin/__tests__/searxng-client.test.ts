import { describe, it, expect, vi, beforeEach } from 'vitest'
import { searchSearXng, SearXngError } from '../searxng-client.js'

// Mock undici
vi.mock('undici', () => ({
  request: vi.fn(),
}))

import { request } from 'undici'

describe('searchSearXng', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('正常返回结果列表', async () => {
    ;(request as any).mockResolvedValue({
      statusCode: 200,
      body: {
        json: async () => ({
          results: [
            {
              title: '宋代茶文化',
              url: 'https://example.com/tea',
              content: '宋代茶文化是...',
              engine: 'google',
              publishedDate: '2026-01-01',
            },
          ],
          number_of_results: 100,
        }),
      },
    })

    const results = await searchSearXng('http://localhost:8888', {
      query: '宋代茶文化',
      maxResults: 5,
    })

    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('宋代茶文化')
    expect(results[0].url).toBe('https://example.com/tea')
    expect(results[0].snippet).toBe('宋代茶文化是...')
    expect(results[0].engine).toBe('google')
  })

  it('拼接查询参数正确', async () => {
    ;(request as any).mockResolvedValue({
      statusCode: 200,
      body: { json: async () => ({ results: [], number_of_results: 0 }) },
    })

    await searchSearXng('http://localhost:8888', {
      query: 'hello world',
      maxResults: 3,
      timeRange: 'month',
      categories: ['news'],
    })

    const callArgs = (request as any).mock.calls[0][0]
    const url = new URL(callArgs)
    expect(url.searchParams.get('q')).toBe('hello world')
    expect(url.searchParams.get('format')).toBe('json')
    expect(url.searchParams.get('time_range')).toBe('month')
    expect(url.searchParams.get('categories')).toBe('news')
  })

  it('HTTP 非 200 抛 SearXngError', async () => {
    ;(request as any).mockResolvedValue({
      statusCode: 503,
      body: { text: async () => 'Service Unavailable' },
    })

    await expect(
      searchSearXng('http://localhost:8888', { query: 'test' }),
    ).rejects.toThrow(SearXngError)
  })

  it('连接失败抛 SearXngError', async () => {
    ;(request as any).mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(
      searchSearXng('http://localhost:8888', { query: 'test' }),
    ).rejects.toThrow(SearXngError)
  })

  it('空结果返回空数组', async () => {
    ;(request as any).mockResolvedValue({
      statusCode: 200,
      body: { json: async () => ({ results: [], number_of_results: 0 }) },
    })

    const results = await searchSearXng('http://localhost:8888', {
      query: '不存在的内容',
    })
    expect(results).toEqual([])
  })
})
