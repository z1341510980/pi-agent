import { describe, expect, it } from 'vitest'
import { buildCanvasGenerationContext } from '../generation-context'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'

const connections: never[] = []

function imageNode(id: string, content: string): CanvasNodeData {
  return {
    id,
    type: 'image',
    title: id,
    position: { x: 0, y: 0 },
    width: 340,
    height: 240,
    metadata: { content, status: 'success' }
  }
}

describe('buildCanvasGenerationContext self reference', () => {
  it('includes the image node itself as the first reference when generating on it', () => {
    const source = imageNode('img-1', 'data:image/png;base64,SELF')

    const { context } = buildCanvasGenerationContext('img-1', [source], connections, '把背景换成竹林')

    expect(context.images).toHaveLength(1)
    expect(context.images[0]).toMatchObject({ nodeId: 'img-1', dataUrl: 'data:image/png;base64,SELF' })
  })

  it('puts the source image before upstream references so it is the edit target', () => {
    const upstream = imageNode('img-up', 'data:image/png;base64,UP')
    const source = imageNode('img-1', 'data:image/png;base64,SELF')

    const { context } = buildCanvasGenerationContext(
      'img-1',
      [source, upstream],
      [{ id: 'c1', fromNodeId: 'img-up', toNodeId: 'img-1' }],
      '按参考图重画'
    )

    expect(context.images.map((reference) => reference.nodeId)).toEqual(['img-1', 'img-up'])
  })

  it('keeps self out for empty media nodes and text nodes', () => {
    const emptyImage = imageNode('img-empty', '')
    const textNode: CanvasNodeData = {
      id: 'text-1',
      type: 'text',
      title: '文本',
      position: { x: 0, y: 0 },
      width: 340,
      height: 240,
      metadata: { content: '草稿内容' }
    }

    const emptyResult = buildCanvasGenerationContext('img-empty', [emptyImage], connections, '画一只猫')
    expect(emptyResult.context.images).toHaveLength(0)

    const textResult = buildCanvasGenerationContext('text-1', [textNode], connections, '扩写')
    // 文本节点自己的内容是提示词草稿，不应变成参考文本重复注入
    expect(textResult.context.text).toHaveLength(0)
  })
})

describe('buildCanvasGenerationContext audio references', () => {
  function audioNode(id: string, content: string): CanvasNodeData {
    return {
      id,
      type: 'audio',
      title: id,
      position: { x: 0, y: 0 },
      width: 340,
      height: 240,
      metadata: { content, status: 'success' }
    }
  }

  it('collects upstream audio node contents in send order (url for asset path, dataUrl for data URL)', () => {
    const upstreamPath = audioNode('aud-path', '/api/plugins/infinite-canvas/assets/aud1')
    const upstreamData = audioNode('aud-data', 'data:audio/mpeg;base64,AA==')
    const source = audioNode('vid-1', '')

    const { context } = buildCanvasGenerationContext(
      'vid-1',
      [source, upstreamPath, upstreamData],
      [
        { id: 'c1', fromNodeId: 'aud-path', toNodeId: 'vid-1' },
        { id: 'c2', fromNodeId: 'aud-data', toNodeId: 'vid-1' }
      ],
      '用参考音频生成视频'
    )

    expect(context.audios).toHaveLength(2)
    expect(context.audios[0]).toMatchObject({
      nodeId: 'aud-path',
      url: '/api/plugins/infinite-canvas/assets/aud1'
    })
    expect(context.audios[0].dataUrl).toBeUndefined()
    expect(context.audios[1]).toMatchObject({
      nodeId: 'aud-data',
      dataUrl: 'data:audio/mpeg;base64,AA=='
    })
    expect(context.audios[1].url).toBeUndefined()
  })

  it('keeps context.audios empty when no audio node is upstream', () => {
    const source = imageNode('img-1', 'data:image/png;base64,SELF')

    const { context } = buildCanvasGenerationContext('img-1', [source], connections, '画一只猫')

    expect(context.audios).toEqual([])
  })
})

describe('buildCanvasGenerationContext asset-path references', () => {
  it('keeps an asset-path self reference in url untouched instead of hydrating base64', () => {
    const source = imageNode('img-1', '/api/plugins/infinite-canvas/assets/abc')

    const { context } = buildCanvasGenerationContext(
      'img-1',
      [source],
      connections,
      '把背景换成竹林'
    )

    expect(context.images).toHaveLength(1)
    expect(context.images[0].url).toBe('/api/plugins/infinite-canvas/assets/abc')
    expect(context.images[0].dataUrl).toBeUndefined()
  })

  it('passes mixed asset-path and data-url upstream references through as-is', () => {
    const upstreamPath = imageNode('img-path', '/api/plugins/infinite-canvas/assets/xyz')
    const upstreamData = imageNode('img-data', 'data:image/png;base64,UP')
    const source = imageNode('img-1', '/api/plugins/infinite-canvas/assets/abc')

    const { context } = buildCanvasGenerationContext(
      'img-1',
      [source, upstreamPath, upstreamData],
      [
        { id: 'c1', fromNodeId: 'img-path', toNodeId: 'img-1' },
        { id: 'c2', fromNodeId: 'img-data', toNodeId: 'img-1' }
      ],
      '按参考图重画'
    )

    expect(context.images).toHaveLength(3)
    expect(context.images.map((reference) => reference.url ?? reference.dataUrl)).toEqual([
      '/api/plugins/infinite-canvas/assets/abc',
      '/api/plugins/infinite-canvas/assets/xyz',
      'data:image/png;base64,UP'
    ])
    expect(
      context.images.every(
        (reference) => reference.dataUrl === undefined || reference.url === undefined
      )
    ).toBe(true)
  })
})
