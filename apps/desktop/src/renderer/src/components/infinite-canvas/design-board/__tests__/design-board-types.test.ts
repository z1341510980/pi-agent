import { describe, expect, it } from 'vitest'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'
import {
  createDesignBoardDoc,
  createImageObject,
  createRectObject,
  createTextObject,
  parseDesignBoardDoc,
  resolveDesignImageSource,
  DESIGN_IMAGE_PLACEHOLDER
} from '../design-board-types'
import { findDesignBoardPreset, DESIGN_BOARD_PRESETS } from '../design-board-presets'

describe('design board document', () => {
  it('creates empty doc with clamped size and white background', () => {
    const doc = createDesignBoardDoc(1080, 1440)
    expect(doc).toEqual({
      version: 1,
      width: 1080,
      height: 1440,
      background: '#ffffff',
      objects: []
    })
    expect(createDesignBoardDoc(50, 99999999).width).toBe(100)
    expect(createDesignBoardDoc(50, 99999999).height).toBe(16000)
  })

  it('creates objects with spec defaults', () => {
    const text = createTextObject(100, 100, 400)
    expect(text).toMatchObject({
      kind: 'text',
      text: '',
      fontSize: 64,
      fontWeight: 400,
      align: 'left',
      color: '#171717',
      width: 400,
      height: 78
    })
    const rect = createRectObject(0, 0, 200, 120)
    expect(rect).toMatchObject({
      kind: 'rect',
      fill: '#262626',
      stroke: 'transparent',
      strokeWidth: 0,
      radius: 0
    })
    const image = createImageObject({ kind: 'node-ref', nodeId: 'n1', index: 0 }, 0, 0, 300, 200)
    expect(image).toMatchObject({ kind: 'image', radius: 0 })
    expect(text.id).not.toBe(rect.id)
  })

  it('parses valid docs, drops invalid objects, clamps fields, blocks NaN', () => {
    const doc = createDesignBoardDoc(1080, 1440)
    doc.objects.push(createRectObject(10, 10, 100, 60))
    doc.objects.push({ ...createTextObject(0, 0, 200), fontSize: Number.NaN })
    const raw = JSON.parse(JSON.stringify(doc)) as { objects: unknown[] }
    raw.objects.push({ kind: 'bogus' })
    raw.objects.push(null)
    const parsed = parseDesignBoardDoc(raw)
    expect(parsed?.objects).toHaveLength(2)
    expect(parsed?.objects[1]).toMatchObject({ fontSize: 64 })
  })

  it('rejects non-doc payloads', () => {
    expect(parseDesignBoardDoc(null)).toBeNull()
    expect(parseDesignBoardDoc({})).toBeNull()
    expect(parseDesignBoardDoc({ version: 1, width: 'a', height: 100, objects: [] })).toBeNull()
  })

  it('resolves node-ref sources against canvas nodes with placeholder fallback', () => {
    const nodes: CanvasNodeData[] = [
      {
        id: 'n1',
        type: 'image',
        title: '图',
        position: { x: 0, y: 0 },
        width: 10,
        height: 10,
        metadata: {
          content: 'data:image/png;base64,AAA',
          images: [
            'data:image/png;base64,BBB',
            { id: 'x', content: 'data:image/png;base64,CCC', status: 'success' }
          ]
        }
      }
    ]
    expect(resolveDesignImageSource({ kind: 'node-ref', nodeId: 'n1', index: 0 }, nodes)).toBe(
      'data:image/png;base64,AAA'
    )
    expect(resolveDesignImageSource({ kind: 'node-ref', nodeId: 'n1', index: 2 }, nodes)).toBe(
      DESIGN_IMAGE_PLACEHOLDER
    )
    expect(resolveDesignImageSource({ kind: 'node-ref', nodeId: 'gone', index: 0 }, nodes)).toBe(
      DESIGN_IMAGE_PLACEHOLDER
    )
    expect(resolveDesignImageSource({ kind: 'url', url: 'https://x/y.png' }, nodes)).toBe(
      'https://x/y.png'
    )
  })
})

describe('design board presets', () => {
  it('offers categorized presets and finds by id', () => {
    expect(DESIGN_BOARD_PRESETS.length).toBeGreaterThanOrEqual(8)
    expect(findDesignBoardPreset('xhs-portrait')).toMatchObject({ width: 1080, height: 1440 })
    expect(findDesignBoardPreset('nope')).toBeUndefined()
  })
})
