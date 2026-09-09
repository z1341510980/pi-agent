import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'
import {
  buildZipBlob,
  collectBatchDownloadItems,
  collectBatchDownloadItemsWithEmptyNodes,
  mediaFileExtension,
  sanitizeBatchFilename,
  uniqueBatchFilename
} from '../batch-download'

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
})

describe('batch download filenames and archive', () => {
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
