import { describe, expect, it } from 'vitest'
import {
  GRAPH_PAYLOAD_LIMIT_BYTES,
  fitImageDimensions,
  graphPayload,
  graphPayloadSizeHint,
  shouldPersistGraph
} from '../graph-persistence'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'

const viewport = { x: 10, y: 20, k: 1.5 }
const settings = { backgroundMode: 'lines' as const, showImageInfo: false }

function imageNode(content: string): CanvasNodeData {
  return {
    id: 'image-1',
    type: 'image',
    title: '照片.jpg',
    position: { x: 5, y: 6 },
    width: 340,
    height: 240,
    metadata: { content, status: 'success', naturalWidth: 4000, naturalHeight: 3000 }
  }
}

describe('graphPayload', () => {
  it('carries the data URL once and keeps the remaining metadata', () => {
    const dataUrl = 'data:image/jpeg;base64,AAAA'
    const payload = graphPayload([imageNode(dataUrl)], [], viewport, settings)

    expect(payload.nodes[0].content).toBe(dataUrl)
    expect(payload.nodes[0].metadata).toEqual({
      status: 'success',
      naturalWidth: 4000,
      naturalHeight: 3000
    })
    expect(payload.viewport).toEqual({ x: 10, y: 20, zoom: 1.5 })
  })

  it('maps position and keeps nodes without content usable', () => {
    const node: CanvasNodeData = {
      id: 'text-1',
      type: 'text',
      title: '文本',
      position: { x: -3, y: 7 },
      width: 340,
      height: 240
    }
    const payload = graphPayload([node], [{ id: 'c1', fromNodeId: 'a', toNodeId: 'b' }], viewport, settings)

    expect(payload.nodes[0]).toMatchObject({ id: 'text-1', content: '', x: -3, y: 7 })
    expect(payload.connections).toEqual([{ id: 'c1', fromNodeId: 'a', toNodeId: 'b' }])
  })

  it('reports a size hint that grows with the embedded media', () => {
    const small = graphPayloadSizeHint(graphPayload([imageNode('data:image/png;base64,AA')], [], viewport, settings))
    const large = graphPayloadSizeHint(
      graphPayload([imageNode(`data:image/jpeg;base64,${'A'.repeat(100_000)}`)], [], viewport, settings)
    )

    expect(large).toBeGreaterThan(small + 99_000)
    expect(GRAPH_PAYLOAD_LIMIT_BYTES).toBe(32 * 1024 * 1024)
  })
})

describe('shouldPersistGraph', () => {
  it('refuses to overwrite a stored graph with an empty one', () => {
    expect(shouldPersistGraph({ localNodeCount: 0, savedNodeCount: 3, allowEmpty: false })).toBe(false)
  })

  it('allows an explicit clear and ordinary saves', () => {
    expect(shouldPersistGraph({ localNodeCount: 0, savedNodeCount: 3, allowEmpty: true })).toBe(true)
    expect(shouldPersistGraph({ localNodeCount: 0, savedNodeCount: 0, allowEmpty: false })).toBe(true)
    expect(shouldPersistGraph({ localNodeCount: 2, savedNodeCount: 3, allowEmpty: false })).toBe(true)
  })
})

describe('fitImageDimensions', () => {
  it('shrinks oversized photos while keeping the aspect ratio', () => {
    expect(fitImageDimensions(4000, 3000, 2048)).toEqual({ width: 2048, height: 1536 })
    expect(fitImageDimensions(3000, 4000, 2048)).toEqual({ width: 1536, height: 2048 })
  })

  it('leaves small images and invalid sizes untouched', () => {
    expect(fitImageDimensions(800, 600, 2048)).toEqual({ width: 800, height: 600 })
    expect(fitImageDimensions(0, 0, 2048)).toEqual({ width: 0, height: 0 })
  })
})
