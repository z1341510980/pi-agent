import { canvasGeneratedImageContent } from '@/api/infinite-canvas-client'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'

export interface DesignBoardResource {
  id: string
  nodeId: string
  index: number
  title: string
  url: string
}

export function collectCanvasImageResources(nodes: CanvasNodeData[]): DesignBoardResource[] {
  const seen = new Set<string>()
  const resources: DesignBoardResource[] = []
  for (const node of nodes) {
    if (node.type !== 'image') continue
    const entries: Array<{ index: number; url: string }> = []
    const content = node.metadata?.content
    if (typeof content === 'string' && content) entries.push({ index: 0, url: content })
    const images = Array.isArray(node.metadata?.images) ? node.metadata.images : []
    images.forEach((entry, offset) => {
      const url = typeof entry === 'string' ? entry : canvasGeneratedImageContent(entry)
      if (typeof url === 'string' && url) entries.push({ index: offset + 1, url })
    })
    for (const entry of entries) {
      if (seen.has(entry.url)) continue
      seen.add(entry.url)
      resources.push({
        id: `${node.id}:${entry.index}`,
        nodeId: node.id,
        index: entry.index,
        title: node.title,
        url: entry.url
      })
    }
  }
  return resources
}
