import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError, postApi } from './http-client'

describe('API error responses', () => {
  afterEach(() => vi.restoreAllMocks())

  it('preserves a legacy string error returned by plugin routes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: 'provider rejected the image' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    )

    const request = postApi('/api/plugins/infinite-canvas/test', {})
    await expect(request).rejects.toBeInstanceOf(ApiClientError)
    await expect(request).rejects.toMatchObject({ message: 'provider rejected the image' })
  })
})
