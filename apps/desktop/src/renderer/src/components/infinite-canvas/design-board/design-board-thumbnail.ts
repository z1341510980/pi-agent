import { renderDesignBoardToCanvas } from './design-board-renderer'
import { parseDesignBoardDoc, resolveDesignImageSource } from './design-board-types'
import type { DesignImageSource } from './design-board-types'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'

const THUMBNAIL_MAX_EDGE = 480
const CACHE_LIMIT = 48
const cache = new Map<string, string>()

export async function getDesignBoardThumbnail(
  node: CanvasNodeData,
  nodes: CanvasNodeData[]
): Promise<string | null> {
  const doc = parseDesignBoardDoc(node.metadata?.design)
  if (!doc) return null
  const designUpdatedAt = node.metadata?.designUpdatedAt
  const updatedAt = typeof designUpdatedAt === 'number' ? designUpdatedAt : 0
  const key = `${node.id}:${doc.objects.length}:${doc.width}x${doc.height}:${updatedAt}`
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const longest = Math.max(doc.width, doc.height)
  const multiplier = Math.max(0.05, Math.min(1, THUMBNAIL_MAX_EDGE / longest))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(doc.width * multiplier))
  canvas.height = Math.max(1, Math.round(doc.height * multiplier))
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(multiplier, 0, 0, multiplier, 0, 0)
  await renderDesignBoardToCanvas(ctx, doc, async (ref) => {
    const [nodeId, indexRaw] = ref.split(':')
    const source: DesignImageSource = { kind: 'node-ref', nodeId, index: Number(indexRaw) || 0 }
    return resolveDesignImageSource(source, nodes)
  })
  const dataUrl = canvas.toDataURL('image/png')
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, dataUrl)
  return dataUrl
}

export function invalidateDesignBoardThumbnail(nodeId: string): void {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${nodeId}:`)) cache.delete(key)
  }
}
