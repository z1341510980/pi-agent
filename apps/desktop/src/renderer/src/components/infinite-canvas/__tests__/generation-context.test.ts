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
