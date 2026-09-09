import type {
  CanvasGraphPayload,
  CanvasNodeData,
  CanvasProjectSettings,
  ViewportTransform
} from '@/api/infinite-canvas-client'

type LocalConnection = { id: string; fromNodeId: string; toNodeId: string }

/** 与服务端 `PUT /projects/:projectId/graph` 的 bodyLimit 保持一致。 */
export const GRAPH_PAYLOAD_LIMIT_BYTES = 32 * 1024 * 1024

/** 超过该体积的图片入画布前先重编码，否则单张照片就能顶穿整图保存上限。 */
export const IMAGE_INLINE_LIMIT_BYTES = 4 * 1024 * 1024

/** 重编码时保留的最长边，兼顾画布预览与后续生图参考图质量。 */
export const IMAGE_MAX_EDGE = 4096

/**
 * 整图保存载荷。
 *
 * data URL 只放在 content 一列：读取时 `projectNodeFromRow` 会用 row.content
 * 回填 metadata.content，两处都带会让单个图片节点体积翻倍（12MB 照片对应
 * 约 16M 字符的 base64，重复携带直接超过 32MB 上限并让保存整体失败）。
 */
export function graphPayload(
  nodes: CanvasNodeData[],
  connections: LocalConnection[],
  viewport: ViewportTransform,
  settings: CanvasProjectSettings
): CanvasGraphPayload {
  return {
    nodes: nodes.map((node) => {
      const content = typeof node.metadata?.content === 'string' ? node.metadata.content : ''
      const metadata = node.metadata ? { ...node.metadata } : undefined
      if (metadata && typeof metadata.content === 'string') delete metadata.content
      return {
        id: node.id,
        type: node.type,
        title: node.title,
        content,
        x: node.position.x,
        y: node.position.y,
        width: node.width,
        height: node.height,
        metadata
      }
    }),
    connections,
    viewport: { x: viewport.x, y: viewport.y, zoom: viewport.k },
    settings
  }
}

/** 请求前的体积估算（data URL 是 ASCII，字符数即字节数）。 */
export function graphPayloadSizeHint(payload: CanvasGraphPayload): number {
  return JSON.stringify(payload).length
}

/**
 * 空图覆盖防护：整图保存会先删光服务端节点再写入，
 * 因此"本地为空 + 服务端有节点"必须先确认是用户显式清空，否则拒绝落库。
 */
export function shouldPersistGraph(input: {
  localNodeCount: number
  savedNodeCount: number
  allowEmpty: boolean
}): boolean {
  if (input.localNodeCount > 0 || input.allowEmpty) return true
  return input.savedNodeCount === 0
}

/** 等比缩放到最长边不超过 maxEdge；小图和非法尺寸原样返回。 */
export function fitImageDimensions(
  width: number,
  height: number,
  maxEdge: number
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width, height }
  const ratio = Math.min(1, maxEdge / Math.max(width, height))
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  return `${Math.max(1, Math.round(bytes / 1024))}KB`
}

/**
 * 大图重编码：超过 IMAGE_INLINE_LIMIT_BYTES 的图片按最长边缩放并转 JPEG。
 * 浏览器 API 不可用或编码失败时返回原 data URL，绝不丢内容。
 */
export async function compressImageDataUrl(
  dataUrl: string,
  options?: { limitBytes?: number; maxEdge?: number; quality?: number }
): Promise<string> {
  const limitBytes = options?.limitBytes ?? IMAGE_INLINE_LIMIT_BYTES
  if (!dataUrl.startsWith('data:image/') || dataUrl.length <= limitBytes) return dataUrl
  if (typeof document === 'undefined' || typeof Image === 'undefined') return dataUrl
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('图片解码失败'))
      element.src = dataUrl
    })
    const size = fitImageDimensions(
      image.naturalWidth || image.width,
      image.naturalHeight || image.height,
      options?.maxEdge ?? IMAGE_MAX_EDGE
    )
    if (!(size.width > 0) || !(size.height > 0)) return dataUrl
    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const context = canvas.getContext('2d')
    if (!context) return dataUrl
    context.drawImage(image, 0, 0, size.width, size.height)
    const encoded = canvas.toDataURL('image/jpeg', options?.quality ?? 0.92)
    return encoded.startsWith('data:image/jpeg') && encoded.length < dataUrl.length
      ? encoded
      : dataUrl
  } catch {
    return dataUrl
  }
}
