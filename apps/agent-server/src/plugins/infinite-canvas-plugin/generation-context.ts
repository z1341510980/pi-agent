export type CanvasGenerationResourceKind = 'text' | 'image' | 'video' | 'audio'

export interface CanvasGenerationReference {
  nodeId: string
  title: string
  kind: CanvasGenerationResourceKind
  label?: string
  text?: string
  dataUrl?: string
  url?: string
  storageKey?: string
  mimeType?: string
  bytes?: number
  width?: number
  height?: number
  durationMs?: number
}

export interface CanvasGenerationContext {
  text: CanvasGenerationReference[]
  images: CanvasGenerationReference[]
  videos: CanvasGenerationReference[]
  audios: CanvasGenerationReference[]
}

const RESOURCE_KINDS: CanvasGenerationResourceKind[] = ['text', 'image', 'video', 'audio']
const MAX_REFERENCES_PER_KIND = 32
const MAX_TEXT_LENGTH = 12_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringValue(value: unknown, maxLength = 512): string | undefined {
  if (typeof value !== 'string') return undefined
  const result = value.trim()
  return result ? result.slice(0, maxLength) : undefined
}

function normalizeReference(
  value: unknown,
  kind: CanvasGenerationResourceKind,
  index: number
): CanvasGenerationReference | undefined {
  if (!isRecord(value)) return undefined
  const nodeId = stringValue(value.nodeId, 256)
  if (!nodeId) return undefined
  const title = stringValue(value.title, 256) || `资源 ${index + 1}`
  const text = stringValue(value.text, MAX_TEXT_LENGTH)
  const dataUrl = stringValue(value.dataUrl, 16 * 1024 * 1024)
  const url = stringValue(value.url, 8 * 1024 * 1024)
  const storageKey = stringValue(value.storageKey, 512)
  const mimeType = stringValue(value.mimeType, 128)
  const label = stringValue(value.label, 256)
  return {
    nodeId,
    title,
    kind,
    ...(label ? { label } : {}),
    ...(text ? { text } : {}),
    ...(dataUrl ? { dataUrl } : {}),
    ...(url ? { url } : {}),
    ...(storageKey ? { storageKey } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(finite(value.bytes) !== undefined ? { bytes: finite(value.bytes) } : {}),
    ...(finite(value.width) !== undefined ? { width: finite(value.width) } : {}),
    ...(finite(value.height) !== undefined ? { height: finite(value.height) } : {}),
    ...(finite(value.durationMs) !== undefined ? { durationMs: finite(value.durationMs) } : {})
  }
}

/**
 * Normalizes the renderer payload at the HTTP boundary. The provider layer must
 * not receive arbitrary objects or duplicate buckets from an untrusted request.
 */
export function normalizeCanvasGenerationContext(
  value: unknown
): CanvasGenerationContext | undefined {
  if (!isRecord(value)) return undefined
  const normalizeBucket = (kind: CanvasGenerationResourceKind): CanvasGenerationReference[] => {
    const bucket = kind === 'text' ? 'text' : `${kind}s`
    const raw = value[bucket]
    return (Array.isArray(raw) ? raw : [])
      .slice(0, MAX_REFERENCES_PER_KIND)
      .map((item, index) => normalizeReference(item, kind, index))
      .filter((item): item is CanvasGenerationReference => Boolean(item))
  }
  return {
    text: normalizeBucket('text'),
    images: normalizeBucket('image'),
    videos: normalizeBucket('video'),
    audios: normalizeBucket('audio')
  }
}

export function canvasGenerationReferences(
  context: CanvasGenerationContext | undefined
): CanvasGenerationReference[] {
  if (!context) return []
  return [...context.text, ...context.images, ...context.videos, ...context.audios]
}

export function canvasImageDataUrls(context: CanvasGenerationContext | undefined): string[] {
  const urls = new Set<string>()
  for (const reference of context?.images ?? []) {
    const value = reference.dataUrl || reference.url
    if (value?.startsWith('data:image/')) urls.add(value)
  }
  return [...urls]
}

function dimensions(reference: CanvasGenerationReference): string {
  if (reference.width && reference.height) return `（${reference.width}×${reference.height}）`
  return ''
}

/** A compact, non-binary representation for text/Agent prompts and logs. */
export function formatCanvasGenerationContext(
  context: CanvasGenerationContext | undefined
): string {
  if (!context) return ''
  const lines: string[] = []
  for (const reference of context.text) {
    lines.push(`${reference.label || reference.title}：\n${reference.text || ''}`)
  }
  for (const reference of context.images) {
    lines.push(`${reference.label || reference.title}： [图片参考]${dimensions(reference)}`)
  }
  for (const reference of context.videos) {
    lines.push(`${reference.label || reference.title}： [视频参考]${dimensions(reference)}`)
  }
  for (const reference of context.audios) {
    const duration = reference.durationMs ? `（${Math.round(reference.durationMs / 1000)}s）` : ''
    lines.push(`${reference.label || reference.title}： [音频参考]${duration}`)
  }
  return lines.join('\n')
}
