import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dataUrlToBlob,
  downloadUrl,
  imageFileExtension,
  resolveDownloadBlob,
  toEditableImageUrl,
  withImageExtension
} from '../download'

function anchorSpy(): { clicks: number; last: HTMLAnchorElement | null } {
  const state = { clicks: 0, last: null as HTMLAnchorElement | null }
  const original = HTMLAnchorElement.prototype.click
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement): void {
    state.clicks += 1
    state.last = this
  }
  afterEach(() => {
    HTMLAnchorElement.prototype.click = original
  })
  return state
}

describe('dataUrlToBlob', () => {
  it('decodes base64 payloads with their mime type', async () => {
    const blob = dataUrlToBlob('data:image/png;base64,iVBORw0KGgo=')

    expect(blob.type).toBe('image/png')
    expect(new Uint8Array(await blob.arrayBuffer()).slice(0, 4)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    )
  })

  it('decodes percent-encoded text payloads', async () => {
    const blob = dataUrlToBlob('data:text/plain,hello%20world')

    expect(blob.type).toBe('text/plain')
    expect(await blob.text()).toBe('hello world')
  })

  it('rejects values that are not data URLs', () => {
    expect(() => dataUrlToBlob('https://example.com/a.png')).toThrow()
  })
})

describe('imageFileExtension', () => {
  it('maps mime types to the conventional file extension', () => {
    expect(imageFileExtension('image/png')).toBe('.png')
    expect(imageFileExtension('image/jpeg')).toBe('.jpg')
    expect(imageFileExtension('image/webp')).toBe('.webp')
    expect(imageFileExtension('image/svg+xml')).toBe('.svg')
  })

  it('falls back to .png for unknown or missing mime types', () => {
    expect(imageFileExtension('')).toBe('.png')
    expect(imageFileExtension('application/json')).toBe('.png')
  })
})

describe('withImageExtension', () => {
  it('replaces a wrong extension with the real one', () => {
    expect(withImageExtension('张飞.jpg', '.png')).toBe('张飞.png')
    expect(withImageExtension('三关六鸭脖.jpeg', '.webp')).toBe('三关六鸭脖.webp')
  })

  it('appends the extension when the title has none', () => {
    expect(withImageExtension('张飞 2 张', '.png')).toBe('张飞 2 张.png')
  })

  it('keeps the name unchanged when the extension already matches', () => {
    expect(withImageExtension('张飞.png', '.png')).toBe('张飞.png')
  })
})

describe('resolveDownloadBlob', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('decodes data URLs without any network round trip', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const blob = await resolveDownloadBlob('data:image/png;base64,iVBORw0KGgo=')

    expect(blob.type).toBe('image/png')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('pulls remote images through the local proxy so the save dialog never waits on the upstream', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response('abc', { status: 200, headers: { 'Content-Type': 'image/png' } })
    )
    vi.stubGlobal('fetch', fetchSpy)

    const blob = await resolveDownloadBlob('https://cdn.example.com/out.png')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0][0])).toContain(
      '/api/plugins/infinite-canvas/proxy-image?url='
    )
    expect(blob.type).toBe('image/png')
    expect(await blob.text()).toBe('abc')
  })

  it('propagates proxy failures as errors instead of saving a broken file', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('upstream down', { status: 502 }))
    )

    await expect(resolveDownloadBlob('https://cdn.example.com/out.png')).rejects.toThrow('502')
  })
})

describe('toEditableImageUrl', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('passes data URLs through untouched', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const url = await toEditableImageUrl('data:image/png;base64,iVBORw0KGgo=')

    expect(url).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('turns remote content into a local blob URL that never taints a canvas', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('abc', { status: 200 })))
    const created: string[] = []
    const revoked: string[] = []
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => {
        const url = `blob:mock/${created.length}`
        created.push(url)
        return url
      },
      revokeObjectURL: (value: string) => revoked.push(value)
    })

    const url = await toEditableImageUrl('https://cdn.example.com/4k.png')

    expect(url).toBe('blob:mock/0')
    expect(created).toHaveLength(1)
    expect(revoked).toHaveLength(0)
  })
})

describe('downloadUrl', () => {
  const created: string[] = []
  const revoked: string[] = []

  afterEach(() => {
    created.length = 0
    revoked.length = 0
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function stubObjectUrl(): void {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: (value: Blob) => {
        const url = `blob:mock/${created.length}-${value.size}`
        created.push(url)
        return url
      },
      revokeObjectURL: (url: string) => revoked.push(url)
    })
  }

  it('turns a data URL into a blob download and keeps the URL alive for the save dialog', () => {
    const anchor = anchorSpy()
    stubObjectUrl()
    vi.useFakeTimers()

    downloadUrl('张飞.png', 'data:image/png;base64,iVBORw0KGgo=')

    expect(anchor.clicks).toBe(1)
    expect(anchor.last?.download).toBe('张飞.png')
    expect(anchor.last?.href).toBe(created[0])
    // Electron 的另存为对话框是异步的：立即 revoke 会让确认后的保存拿不到数据。
    expect(revoked).toEqual([])

    vi.advanceTimersByTime(10 * 60_000)
    expect(revoked).toEqual([created[0]])
  })

  it('downloads blobs directly and leaves remote URLs untouched', () => {
    const anchor = anchorSpy()
    stubObjectUrl()

    downloadUrl('canvas.json', new Blob(['{}'], { type: 'application/json' }))
    expect(anchor.last?.href).toBe(created[0])

    downloadUrl('remote.png', 'https://example.com/remote.png')
    expect(anchor.last?.href).toBe('https://example.com/remote.png')
    expect(created).toHaveLength(1)
  })

  it('removes the temporary anchor from the document', () => {
    const anchor = anchorSpy()
    stubObjectUrl()

    downloadUrl('canvas.json', new Blob(['{}'], { type: 'application/json' }))

    expect(anchor.clicks).toBe(1)
    expect(document.querySelectorAll('a[download]')).toHaveLength(0)
  })
})
