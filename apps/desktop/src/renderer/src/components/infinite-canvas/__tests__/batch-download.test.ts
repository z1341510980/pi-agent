import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'
import {
  buildZipBlob,
  buildBatchDownloadArchive,
  collectBatchDownloadItems,
  collectBatchDownloadItemsWithEmptyNodes,
  formatBatchDownloadNotice,
  mediaFileExtension,
  sanitizeBatchFilename,
  uniqueBatchFilename,
  withBatchDownloading
} from '../batch-download'
import { getNodeSpec } from '../geometry'

const node = (overrides: Partial<CanvasNodeData>): CanvasNodeData => ({
  id: 'node-1',
  type: 'text',
  title: '未命名节点',
  position: { x: 0, y: 0 },
  width: 100,
  height: 100,
  ...overrides
})

describe('batch download item collection', () => {
  it('expands every image result and skips groups', () => {
    const items = collectBatchDownloadItems([
      node({
        id: 'images',
        type: 'image',
        title: '角色图',
        metadata: {
          images: [
            { id: 'a', content: 'data:image/png;base64,AA==', status: 'success' },
            'data:image/jpeg;base64,/w=='
          ]
        }
      }),
      node({ id: 'group', type: 'group', title: '分组' })
    ])

    expect(items).toEqual([
      {
        baseName: '角色图-1',
        kind: 'media',
        mediaType: 'image',
        content: 'data:image/png;base64,AA=='
      },
      {
        baseName: '角色图-2',
        kind: 'media',
        mediaType: 'image',
        content: 'data:image/jpeg;base64,/w=='
      }
    ])
  })

  it('maps text and config nodes to readable files', () => {
    const items = collectBatchDownloadItems([
      node({ type: 'text', title: '提示词', metadata: { content: '一段文字' } }),
      node({ type: 'config', title: '配置', metadata: { model: 'demo', count: 2 } })
    ])

    expect(items).toEqual([
      { baseName: '提示词', kind: 'text', extension: '.txt', content: '一段文字' },
      {
        baseName: '配置',
        kind: 'text',
        extension: '.json',
        content: '{\n  "model": "demo",\n  "count": 2\n}'
      }
    ])
  })

  it('uses the primary content when an image has no result list', () => {
    expect(
      collectBatchDownloadItems([
        node({ type: 'image', title: '主图', metadata: { content: 'blob:image' } })
      ])
    ).toEqual([{ baseName: '主图', kind: 'media', mediaType: 'image', content: 'blob:image' }])
  })

  it('maps video, audio, and extended text nodes while skipping empty content', () => {
    expect(
      collectBatchDownloadItems([
        node({ type: 'video', title: '演示', metadata: { content: 'video-url' } }),
        node({ type: 'audio', title: '旁白', metadata: { content: 'audio-url' } }),
        node({ type: 'prompt', title: '扩展文本', metadata: { content: '文本结果' } }),
        node({ type: 'text', title: '空文本', metadata: { content: '' } }),
        node({ type: 'video', title: '空视频', metadata: { content: '  ' } })
      ])
    ).toEqual([
      { baseName: '演示', kind: 'media', mediaType: 'video', content: 'video-url' },
      { baseName: '旁白', kind: 'media', mediaType: 'audio', content: 'audio-url' },
      { baseName: '扩展文本', kind: 'text', extension: '.txt', content: '文本结果' }
    ])
  })

  it('falls back from content to prompt and composer content for text nodes', () => {
    expect(
      collectBatchDownloadItems([
        node({ type: 'prompt', title: 'Prompt', metadata: { prompt: '提示词' } }),
        node({ type: 'agent-result', title: 'Agent', metadata: { composerContent: '编排结果' } }),
        node({
          type: 'text-extension',
          title: '优先级',
          metadata: { content: '正文', prompt: '提示词', composerContent: '编排结果' }
        }),
        node({
          type: 'text-extension-empty',
          title: '空白回退',
          metadata: { content: '  ', prompt: '\n', composerContent: '  ' }
        })
      ])
    ).toEqual([
      { baseName: 'Prompt', kind: 'text', extension: '.txt', content: '提示词' },
      { baseName: 'Agent', kind: 'text', extension: '.txt', content: '编排结果' },
      { baseName: '优先级', kind: 'text', extension: '.txt', content: '正文' }
    ])
  })

  it('skips image results and primary content when both are empty', () => {
    expect(
      collectBatchDownloadItems([
        node({ type: 'image', title: '空图片', metadata: { images: [''] } }),
        node({ type: 'image', title: '无内容' })
      ])
    ).toEqual([])
  })

  it('reports empty node titles without reporting groups', () => {
    expect(
      collectBatchDownloadItemsWithEmptyNodes([
        node({ id: 'empty-text', title: '空文本', metadata: { content: '  ' } }),
        node({ id: 'empty-image', type: 'image', title: '空图片' }),
        node({ id: 'group', type: 'group', title: '分组' })
      ])
    ).toEqual({
      items: [],
      emptyNodeTitles: ['空文本', '空图片']
    })
  })

  it('exports design-board nodes as formatted json', () => {
    const design = { version: 1, width: 1080, height: 1440, background: '#ffffff', objects: [] }
    const items = collectBatchDownloadItems([
      node({ id: 'board', type: 'design-board', title: '画板', metadata: { design } })
    ])
    expect(items).toEqual([
      {
        baseName: '画板',
        kind: 'text',
        extension: '.json',
        content: JSON.stringify(design, null, 2)
      }
    ])
  })

  it('skips design-board nodes without design metadata and does not report them as empty', () => {
    const items = collectBatchDownloadItemsWithEmptyNodes([
      node({ id: 'board', type: 'design-board', title: '画板', metadata: {} })
    ])
    expect(items.items).toEqual([])
    expect(items.emptyNodeTitles).toEqual([])
  })
})

describe('node registration', () => {
  it('registers the design-board node spec', () => {
    expect(getNodeSpec('design-board')).toEqual({
      width: 340,
      height: 240,
      title: '设计画板',
      metadata: { status: 'idle' }
    })
  })
})

describe('batch download filenames and archive', () => {
  it('continues after a media failure and builds an archive from successful files', async () => {
    const collection = collectBatchDownloadItemsWithEmptyNodes([
      node({ type: 'image', title: '失败图片', metadata: { content: 'bad-image' } }),
      node({ type: 'text', title: '空文本', metadata: { content: ' ' } }),
      node({ type: 'text', title: '成功文本', metadata: { content: 'hello' } })
    ])

    const result = await buildBatchDownloadArchive(collection, async (content) => {
      if (content === 'bad-image') throw new Error('网络失败')
      return new Blob(['unexpected'], { type: 'application/octet-stream' })
    })

    expect(result.failures).toEqual(['失败图片: 网络失败'])
    expect(result.emptyNodeTitles).toEqual(['空文本'])
    expect(result.files.map((file) => file.filename)).toEqual(['成功文本.txt'])
    expect(result.archive).not.toBeNull()
    const archive = unzipSync(new Uint8Array(await result.archive!.arrayBuffer()))
    expect(strFromU8(archive['成功文本.txt'])).toBe('hello')
  })

  it('does not build an archive when every media file fails', async () => {
    const result = await buildBatchDownloadArchive(
      collectBatchDownloadItemsWithEmptyNodes([
        node({ type: 'video', title: '失败视频', metadata: { content: 'bad-video' } })
      ]),
      async () => {
        throw new Error('HTTP 502')
      }
    )

    expect(result.archive).toBeNull()
    expect(result.files).toEqual([])
    expect(result.failures).toEqual(['失败视频: HTTP 502'])
  })

  it('does not invoke media resolution or build an archive for empty nodes and groups', async () => {
    const resolveMedia = vi.fn()
    const result = await buildBatchDownloadArchive(
      collectBatchDownloadItemsWithEmptyNodes([
        node({ type: 'text', title: '空文本', metadata: { content: '' } }),
        node({ type: 'group', title: '分组' })
      ]),
      resolveMedia
    )

    expect(resolveMedia).not.toHaveBeenCalled()
    expect(result.archive).toBeNull()
    expect(result.files).toEqual([])
    expect(result.failures).toEqual([])
    expect(result.emptyNodeTitles).toEqual(['空文本'])
  })

  it('formats success, partial failure, and empty-result notices', async () => {
    const success = await buildBatchDownloadArchive(
      collectBatchDownloadItemsWithEmptyNodes([
        node({ type: 'text', title: '成功', metadata: { content: 'ok' } })
      ]),
      vi.fn()
    )
    const partial = await buildBatchDownloadArchive(
      collectBatchDownloadItemsWithEmptyNodes([
        node({ type: 'image', title: '失败', metadata: { content: 'bad' } }),
        node({ type: 'text', title: '成功', metadata: { content: 'ok' } })
      ]),
      async (content) => {
        if (content === 'bad') {
          throw new Error('读取失败')
        }
        return new Blob(['unused'])
      }
    )
    const empty = await buildBatchDownloadArchive(
      collectBatchDownloadItemsWithEmptyNodes([
        node({ type: 'text', title: '空节点', metadata: { content: '' } })
      ]),
      vi.fn()
    )

    expect(formatBatchDownloadNotice(success)).toEqual({
      variant: 'success',
      message: '已打包 1 个文件'
    })
    expect(formatBatchDownloadNotice(partial)).toEqual({
      variant: 'error',
      message: '已打包 1 个文件，1 个文件失败：失败: 读取失败'
    })
    expect(formatBatchDownloadNotice(empty)).toEqual({
      variant: 'error',
      message: '没有可下载的文件：无有效内容节点：空节点'
    })
  })

  it('reports all failed media as an error notice', async () => {
    const result = await buildBatchDownloadArchive(
      collectBatchDownloadItemsWithEmptyNodes([
        node({ type: 'image', title: '失败', metadata: { content: 'bad' } })
      ]),
      async () => {
        throw new Error('读取失败')
      }
    )

    expect(formatBatchDownloadNotice(result)).toEqual({
      variant: 'error',
      message: '没有可下载的文件：失败: 读取失败'
    })
  })

  it('waits for media resolution before returning a successful archive', async () => {
    let resolveMedia!: (blob: Blob) => void
    const pending = new Promise<Blob>((resolve) => {
      resolveMedia = resolve
    })
    const resultPromise = buildBatchDownloadArchive(
      collectBatchDownloadItemsWithEmptyNodes([
        node({ type: 'audio', title: '音频', metadata: { content: 'audio-url' } })
      ]),
      () => pending
    )

    await Promise.resolve()
    resolveMedia(new Blob(['audio'], { type: 'audio/mpeg' }))
    const result = await resultPromise

    expect(result.archive).not.toBeNull()
    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.filename).toBe('音频.mp3')
    expect(Array.from(result.files[0]?.data ?? [])).toEqual(
      Array.from(new TextEncoder().encode('audio'))
    )
  })

  it('tracks downloading state until the async operation settles', async () => {
    const states: boolean[] = []
    let resolveOperation!: () => void
    const operation = withBatchDownloading(
      () => new Promise<void>((resolve) => (resolveOperation = resolve)),
      (value) => states.push(value)
    )

    await Promise.resolve()
    expect(states).toEqual([true])
    resolveOperation()
    await operation
    expect(states).toEqual([true, false])
  })

  it('removes path separators and Windows-invalid characters', () => {
    expect(sanitizeBatchFilename('  A/B:C*D?  ')).toBe('A-B-C-D')
    expect(sanitizeBatchFilename('A\u0001B')).toBe('A-B')
    expect(sanitizeBatchFilename('')).toBe('未命名节点')
  })

  it('avoids Windows reserved device names', () => {
    expect(sanitizeBatchFilename('CON')).toBe('CON-file')
    expect(sanitizeBatchFilename('prn.txt')).toBe('prn-file.txt')
    expect(sanitizeBatchFilename('LPT9.log')).toBe('LPT9-file.log')
  })

  it('deduplicates names inside one archive', () => {
    const used = new Set<string>()
    expect(uniqueBatchFilename('同名.txt', used)).toBe('同名.txt')
    expect(uniqueBatchFilename('同名.txt', used)).toBe('同名-2.txt')
    expect(uniqueBatchFilename('Report.txt', used)).toBe('Report.txt')
    expect(uniqueBatchFilename('report.txt', used)).toBe('report-2.txt')
  })

  it('maps common media MIME types to extensions', () => {
    expect(mediaFileExtension('image/jpeg', 'image')).toBe('.jpg')
    expect(mediaFileExtension('image/webp', 'image')).toBe('.webp')
    expect(mediaFileExtension('image/gif', 'image')).toBe('.gif')
    expect(mediaFileExtension('image/avif', 'image')).toBe('.avif')
    expect(mediaFileExtension('video/mp4', 'video')).toBe('.mp4')
    expect(mediaFileExtension('video/mpeg', 'video')).toBe('.mpeg')
    expect(mediaFileExtension('video/webm', 'video')).toBe('.webm')
    expect(mediaFileExtension('video/quicktime', 'video')).toBe('.mov')
    expect(mediaFileExtension('audio/mpeg', 'audio')).toBe('.mp3')
    expect(mediaFileExtension('audio/ogg', 'audio')).toBe('.ogg')
    expect(mediaFileExtension('audio/wav', 'audio')).toBe('.wav')
    expect(mediaFileExtension('audio/x-m4a', 'audio')).toBe('.m4a')
    expect(mediaFileExtension('audio/webm', 'audio')).toBe('.webm')
    expect(mediaFileExtension('audio/mp4', 'audio')).toBe('.mp4')
    expect(mediaFileExtension('video/ogg', 'video')).toBe('.ogg')
    expect(mediaFileExtension('video/mpeg', 'audio')).toBe('.mpeg')
    expect(mediaFileExtension('audio/mpeg', 'video')).toBe('.mp3')
    expect(mediaFileExtension('audio/ogg', 'video')).toBe('.ogg')
    expect(mediaFileExtension('', 'video')).toBe('.mp4')
  })

  it('creates a readable ZIP blob', async () => {
    const blob = buildZipBlob([
      { filename: 'note.txt', data: new TextEncoder().encode('hello') },
      { filename: 'data.json', data: new TextEncoder().encode('{"ok":true}') }
    ])
    const archive = unzipSync(new Uint8Array(await blob.arrayBuffer()))
    expect(strFromU8(archive['note.txt'])).toBe('hello')
    expect(strFromU8(archive['data.json'])).toBe('{"ok":true}')
  })

  it('keeps duplicate filenames as separate archive entries', async () => {
    const blob = buildZipBlob([
      { filename: 'same.txt', data: new TextEncoder().encode('first') },
      { filename: 'same.txt', data: new TextEncoder().encode('second') }
    ])
    const archive = unzipSync(new Uint8Array(await blob.arrayBuffer()))

    expect(strFromU8(archive['same.txt'])).toBe('first')
    expect(strFromU8(archive['same-2.txt'])).toBe('second')
  })
})
