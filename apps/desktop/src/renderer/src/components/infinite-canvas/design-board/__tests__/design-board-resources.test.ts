import { describe, expect, it } from 'vitest'
import type { CanvasGeneratedImage, CanvasNodeData } from '@/api/infinite-canvas-client'
import { collectCanvasImageResources } from '../design-board-resources'

const imageNode = (
  id: string,
  content: string,
  images: Array<CanvasGeneratedImage | string> = []
): CanvasNodeData => ({
  id,
  type: 'image',
  title: `节点${id}`,
  position: { x: 0, y: 0 },
  width: 10,
  height: 10,
  metadata: { content, images }
})

describe('collectCanvasImageResources', () => {
  it('collects content and images entries from image nodes only', () => {
    const nodes = [
      imageNode('a', 'data:1', ['data:2', { id: 'x', content: 'data:3', status: 'success' }]),
      { ...imageNode('b', 'data:4'), type: 'text' as const }
    ]
    const resources = collectCanvasImageResources(nodes)
    expect(resources.map((r) => `${r.nodeId}:${r.index}`)).toEqual(['a:0', 'a:1', 'a:2'])
  })

  it('skips empty entries and dedupes by url', () => {
    const nodes = [imageNode('a', 'data:1', ['', 'data:1'])]
    expect(collectCanvasImageResources(nodes)).toHaveLength(1)
  })

  it('exposes title and resolved url for each resource', () => {
    const resources = collectCanvasImageResources([imageNode('a', 'https://ext/img.png')])
    expect(resources[0]).toMatchObject({
      nodeId: 'a',
      index: 0,
      title: '节点a',
      url: 'https://ext/img.png'
    })
  })
})
