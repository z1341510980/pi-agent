import { describe, expect, it } from 'vitest'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'
import {
  createArrowObject,
  createDesignBoardDoc,
  createEllipseObject,
  createImageObject,
  createLineObject,
  createPolygonObject,
  createRectObject,
  createStarObject,
  createTextObject,
  parseDesignBoardDoc,
  reorderDesignBoardObject,
  reorderDesignBoardObjectToIndex,
  resolveDesignImageSource,
  DESIGN_IMAGE_PLACEHOLDER
} from '../design-board-types'
import type { DesignBoardObject, DesignImageSource } from '../design-board-types'
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
      height: 78,
      visible: true
    })
    const rect = createRectObject(0, 0, 200, 120)
    expect(rect).toMatchObject({
      kind: 'rect',
      fill: '#262626',
      stroke: 'transparent',
      strokeWidth: 0,
      radius: 0,
      visible: true
    })
    const image = createImageObject({ kind: 'node-ref', nodeId: 'n1', index: 0 }, 0, 0, 300, 200)
    expect(image).toMatchObject({ kind: 'image', radius: 0, visible: true })
    expect(text.id).not.toBe(rect.id)
  })

  it('creates the five shape kinds with spec defaults', () => {
    const ellipse = createEllipseObject(0, 0, 100, 80)
    expect(ellipse).toMatchObject({
      kind: 'ellipse',
      fill: '#262626',
      stroke: 'transparent',
      strokeWidth: 0,
      visible: true
    })
    const polygon = createPolygonObject(0, 0, 100, 80)
    expect(polygon).toMatchObject({
      kind: 'polygon',
      fill: '#262626',
      stroke: 'transparent',
      strokeWidth: 0,
      sides: 6,
      visible: true
    })
    const star = createStarObject(0, 0, 100, 80)
    expect(star).toMatchObject({ kind: 'star', points: 5, visible: true })
    const line = createLineObject(0, 0, 200, 4)
    expect(line).toMatchObject({
      kind: 'line',
      stroke: '#262626',
      strokeWidth: 4,
      visible: true
    })
    const arrow = createArrowObject(0, 0, 200, 4)
    expect(arrow).toMatchObject({ kind: 'arrow', strokeWidth: 4, headSize: 1, visible: true })
    expect(ellipse.id).not.toBe(line.id)
  })

  it('parses shape objects with per-field fallbacks and clamps (sides/points/headSize)', () => {
    const doc = createDesignBoardDoc(100, 100)
    doc.objects.push({ ...createPolygonObject(0, 0, 10, 10), sides: 99 })
    doc.objects.push({ ...createPolygonObject(0, 0, 10, 10), sides: 1 })
    doc.objects.push({ ...createStarObject(0, 0, 10, 10), points: Number.NaN })
    doc.objects.push({ ...createArrowObject(0, 0, 10, 4), headSize: 0.01 })
    doc.objects.push({ ...createLineObject(0, 0, 10, 4), strokeWidth: 0 })
    doc.objects.push({ ...createLineObject(0, 0, 10, 4), stroke: '' })
    const raw = JSON.parse(JSON.stringify(doc)) as { objects: Array<Record<string, unknown>> }
    raw.objects.push({ kind: 'ellipse', fill: '#123456' })
    const parsed = parseDesignBoardDoc(raw)
    expect(parsed?.objects[0]).toMatchObject({ kind: 'polygon', sides: 32 })
    expect(parsed?.objects[1]).toMatchObject({ kind: 'polygon', sides: 3 })
    expect(parsed?.objects[2]).toMatchObject({ kind: 'star', points: 5 })
    expect(parsed?.objects[3]).toMatchObject({ kind: 'arrow', headSize: 0.2 })
    expect(parsed?.objects[4]).toMatchObject({ kind: 'line', strokeWidth: 1 })
    expect(parsed?.objects[5]).toMatchObject({ kind: 'line', stroke: '#262626' })
    // 非法 base 字段回退默认：对象仍有效
    expect(parsed?.objects[6]).toMatchObject({ kind: 'ellipse', fill: '#123456' })
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

  it('clamps text styling bounds and drops images with invalid sources', () => {
    const doc = createDesignBoardDoc(1080, 1440)
    doc.objects.push({ ...createTextObject(0, 0, 200), fontSize: 700, fontWeight: 1000 })
    doc.objects.push({
      ...createImageObject({ kind: 'node-ref', nodeId: 'n1', index: 0 }, 0, 0, 10, 10),
      source: { kind: 'bogus' } as unknown as DesignImageSource
    })
    const parsed = parseDesignBoardDoc(JSON.parse(JSON.stringify(doc)))
    expect(parsed?.objects).toHaveLength(1)
    expect(parsed?.objects[0]).toMatchObject({ fontSize: 512, fontWeight: 900 })
  })

  it('rejects future doc versions', () => {
    const doc = createDesignBoardDoc(1080, 1440)
    const raw = { ...JSON.parse(JSON.stringify(doc)), version: 2 }
    expect(parseDesignBoardDoc(raw)).toBeNull()
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
      },
      {
        id: 'n2',
        type: 'image',
        title: '无主图',
        position: { x: 0, y: 0 },
        width: 10,
        height: 10,
        metadata: { images: ['data:image/png;base64,DDD'] }
      }
    ]
    expect(resolveDesignImageSource({ kind: 'node-ref', nodeId: 'n1', index: 0 }, nodes)).toBe(
      'data:image/png;base64,AAA'
    )
    expect(resolveDesignImageSource({ kind: 'node-ref', nodeId: 'n1', index: 1 }, nodes)).toBe(
      'data:image/png;base64,BBB'
    )
    expect(resolveDesignImageSource({ kind: 'node-ref', nodeId: 'n1', index: 2 }, nodes)).toBe(
      'data:image/png;base64,CCC'
    )
    expect(resolveDesignImageSource({ kind: 'node-ref', nodeId: 'n1', index: 3 }, nodes)).toBe(
      DESIGN_IMAGE_PLACEHOLDER
    )
    expect(resolveDesignImageSource({ kind: 'node-ref', nodeId: 'n2', index: 0 }, nodes)).toBe(
      DESIGN_IMAGE_PLACEHOLDER
    )
    expect(resolveDesignImageSource({ kind: 'node-ref', nodeId: 'gone', index: 0 }, nodes)).toBe(
      DESIGN_IMAGE_PLACEHOLDER
    )
    expect(resolveDesignImageSource({ kind: 'url', url: 'https://x/y.png' }, nodes)).toBe(
      'https://x/y.png'
    )
    expect(
      resolveDesignImageSource({ kind: 'data', dataUrl: 'data:image/png;base64,EEE' }, nodes)
    ).toBe('data:image/png;base64,EEE')
  })
})

describe('design board presets', () => {
  it('offers categorized presets and finds by id', () => {
    expect(DESIGN_BOARD_PRESETS.length).toBeGreaterThanOrEqual(8)
    expect(findDesignBoardPreset('xhs-portrait')).toMatchObject({ width: 1080, height: 1440 })
    expect(findDesignBoardPreset('nope')).toBeUndefined()
  })
})

describe('reorderDesignBoardObject', () => {
  // objects 数组顺序即 z 序：后者在上
  function makeObjects(): DesignBoardObject[] {
    return [
      createRectObject(0, 0, 10, 10),
      createTextObject(10, 10, 100),
      createImageObject({ kind: 'url', url: 'x.png' }, 20, 20, 30, 30)
    ]
  }
  const ids = (objects: DesignBoardObject[]): string[] => objects.map((object) => object.id)

  it('front moves the object to the end (top), back moves it to the start (bottom)', () => {
    const [a, b, c] = makeObjects()
    expect(ids(reorderDesignBoardObject([a, b, c], a.id, 'front'))).toEqual([b.id, c.id, a.id])
    const [x, y, z] = makeObjects()
    expect(ids(reorderDesignBoardObject([x, y, z], z.id, 'back'))).toEqual([z.id, x.id, y.id])
  })

  it('forward swaps with the next object, backward swaps with the previous one', () => {
    const [a, b, c] = makeObjects()
    expect(ids(reorderDesignBoardObject([a, b, c], a.id, 'forward'))).toEqual([b.id, a.id, c.id])
    const [x, y, z] = makeObjects()
    expect(ids(reorderDesignBoardObject([x, y, z], z.id, 'backward'))).toEqual([x.id, z.id, y.id])
  })

  it('returns the same array reference at z-order boundaries', () => {
    const objects = makeObjects()
    expect(reorderDesignBoardObject(objects, objects[2].id, 'forward')).toBe(objects)
    expect(reorderDesignBoardObject(objects, objects[0].id, 'backward')).toBe(objects)
    expect(reorderDesignBoardObject(objects, objects[2].id, 'front')).toBe(objects)
    expect(reorderDesignBoardObject(objects, objects[0].id, 'back')).toBe(objects)
  })

  it('returns the original array when the id does not exist', () => {
    const objects = makeObjects()
    expect(reorderDesignBoardObject(objects, 'missing-id', 'front')).toBe(objects)
    expect(reorderDesignBoardObject(objects, 'missing-id', 'forward')).toBe(objects)
  })

  it('does not mutate the input array or reorder object payloads', () => {
    const objects = makeObjects()
    const snapshot = JSON.stringify(objects)
    const moved = reorderDesignBoardObject(objects, objects[0].id, 'front')
    expect(JSON.stringify(objects)).toBe(snapshot)
    expect(moved[2]).toBe(objects[0])
    expect(moved.filter((object) => object === objects[0])).toHaveLength(1)
  })
})

describe('reorderDesignBoardObjectToIndex', () => {
  function makeObjects(): DesignBoardObject[] {
    return [
      createRectObject(0, 0, 10, 10),
      createTextObject(10, 10, 100),
      createImageObject({ kind: 'url', url: 'x.png' }, 20, 20, 30, 30)
    ]
  }
  const ids = (objects: DesignBoardObject[]): string[] => objects.map((object) => object.id)

  it('moves the object to the target index', () => {
    const [a, b, c] = makeObjects()
    expect(ids(reorderDesignBoardObjectToIndex([a, b, c], a.id, 2))).toEqual([b.id, c.id, a.id])
    const [x, y, z] = makeObjects()
    expect(ids(reorderDesignBoardObjectToIndex([x, y, z], z.id, 0))).toEqual([z.id, x.id, y.id])
  })

  it('clamps out-of-range target indices', () => {
    const [a, b, c] = makeObjects()
    expect(ids(reorderDesignBoardObjectToIndex([a, b, c], a.id, 99))).toEqual([b.id, c.id, a.id])
    const [x, y, z] = makeObjects()
    expect(ids(reorderDesignBoardObjectToIndex([x, y, z], z.id, -5))).toEqual([z.id, x.id, y.id])
  })

  it('returns the original reference when the id is missing or the index is unchanged', () => {
    const objects = makeObjects()
    expect(reorderDesignBoardObjectToIndex(objects, 'missing-id', 0)).toBe(objects)
    expect(reorderDesignBoardObjectToIndex(objects, objects[1].id, 1)).toBe(objects)
  })

  it('does not mutate the input array', () => {
    const objects = makeObjects()
    const snapshot = JSON.stringify(objects)
    const moved = reorderDesignBoardObjectToIndex(objects, objects[0].id, 2)
    expect(JSON.stringify(objects)).toBe(snapshot)
    expect(moved).not.toBe(objects)
  })
})

describe('design board object visibility', () => {
  it('parses non-boolean or missing visible as true and keeps explicit false', () => {
    const doc = createDesignBoardDoc(100, 100)
    doc.objects.push(createRectObject(0, 0, 10, 10))
    doc.objects.push({ ...createTextObject(0, 0, 50), visible: false })
    doc.objects.push(createRectObject(20, 20, 10, 10))
    const raw = JSON.parse(JSON.stringify(doc)) as { objects: Array<Record<string, unknown>> }
    raw.objects[0].visible = 'yes'
    delete raw.objects[2].visible
    const parsed = parseDesignBoardDoc(raw)
    expect(parsed?.objects[0].visible).toBe(true)
    expect(parsed?.objects[1].visible).toBe(false)
    expect(parsed?.objects[2].visible).toBe(true)
  })
})
