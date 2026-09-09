import { compressImageDataUrl } from '../graph-persistence'
import { renderDesignBoardToCanvas } from './design-board-renderer'
import { resolveDesignImageSource } from './design-board-types'
import type { DesignBoardDoc } from './design-board-types'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'

export interface DesignBoardExportOptions {
  format: 'png' | 'jpg'
  multiplier?: number
}

export interface DesignBoardExportResult {
  dataUrl: string
  width: number
  height: number
}

export async function exportDesignBoardImage(
  doc: DesignBoardDoc,
  nodes: CanvasNodeData[],
  options: DesignBoardExportOptions
): Promise<DesignBoardExportResult> {
  const multiplier = Math.min(3, Math.max(1, Math.round(options.multiplier ?? 1)))
  const width = Math.max(1, Math.round(doc.width * multiplier))
  const height = Math.max(1, Math.round(doc.height * multiplier))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建导出画布')
  ctx.setTransform(multiplier, 0, 0, multiplier, 0, 0)
  await renderDesignBoardToCanvas(ctx, doc, async (ref) => {
    const [nodeId, indexRaw] = ref.split(':')
    return resolveDesignImageSource(
      { kind: 'node-ref', nodeId, index: Number(indexRaw) || 0 },
      nodes
    )
  })
  const mime = options.format === 'jpg' ? 'image/jpeg' : 'image/png'
  let dataUrl = canvas.toDataURL(mime)
  dataUrl = await compressImageDataUrl(dataUrl)
  return { dataUrl, width, height }
}
