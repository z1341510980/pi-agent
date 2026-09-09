import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'
import {
  buildZipBlob,
  collectBatchDownloadItems,
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
})

describe('batch download filenames and archive', () => {
  it('removes path separators and Windows-invalid characters', () => {
    expect(sanitizeBatchFilename('  A/B:C*D?  ')).toBe('A-B-C-D')
    expect(sanitizeBatchFilename('')).toBe('未命名节点')
  })

  it('deduplicates names inside one archive', () => {
    const used = new Set<string>()
    expect(uniqueBatchFilename('同名.txt', used)).toBe('同名.txt')
    expect(uniqueBatchFilename('同名.txt', used)).toBe('同名-2.txt')
  })

  it('maps common media MIME types to extensions', () => {
    expect(mediaFileExtension('image/jpeg', 'image')).toBe('.jpg')
    expect(mediaFileExtension('video/webm', 'video')).toBe('.webm')
    expect(mediaFileExtension('audio/mpeg', 'audio')).toBe('.mp3')
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
})
