import { canvasGeneratedImageContent, type CanvasNodeData } from '@/api/infinite-canvas-client'
import { zipSync } from 'fflate'

export type BatchDownloadItem =
  | {
      baseName: string
      kind: 'media'
      mediaType: 'image' | 'video' | 'audio'
      content: string
    }
  | { baseName: string; kind: 'text'; extension: '.txt' | '.json'; content: string }

export type BatchZipFile = { filename: string; data: Uint8Array }

const WINDOWS_INVALID = /[<>:"/\\|?*]/g
const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)
])

function hasContent(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isWindowsReservedName(value: string): boolean {
  const stem = value.split('.')[0]?.toUpperCase()
  return stem ? WINDOWS_RESERVED_NAMES.has(stem) : false
}

function withReservedNameSuffix(value: string): string {
  if (!isWindowsReservedName(value)) return value
  const dot = value.indexOf('.')
  return dot > 0 ? `${value.slice(0, dot)}-file${value.slice(dot)}` : `${value}-file`
}

export function sanitizeBatchFilename(value: string): string {
  const sanitized = value
    .trim()
    .split('')
    .map((character) => (character.charCodeAt(0) < 32 ? '-' : character))
    .join('')
    .replace(WINDOWS_INVALID, '-')
    .replace(/[-. ]+$/g, '')
  return withReservedNameSuffix(sanitized || '未命名节点')
}

export function uniqueBatchFilename(filename: string, used: Set<string>): string {
  const isUsed = (candidate: string): boolean => {
    const normalized = candidate.toLowerCase()
    return Array.from(used).some((existing) => existing.toLowerCase() === normalized)
  }

  if (!isUsed(filename)) {
    used.add(filename)
    return filename
  }

  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const extension = dot > 0 ? filename.slice(dot) : ''
  let index = 2
  let candidate = `${stem}-${index}${extension}`
  while (isUsed(candidate)) candidate = `${stem}-${++index}${extension}`
  used.add(candidate)
  return candidate
}

export function mediaFileExtension(
  mime: string | undefined,
  mediaType: 'image' | 'video' | 'audio'
): string {
  const [mainType, subtype] = (mime ?? '').toLowerCase().split(';')[0].split('/')
  const known: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/avif': '.avif',
    'image/svg+xml': '.svg',
    'image/x-icon': '.ico',
    'video/mp4': '.mp4',
    'video/mpeg': '.mpeg',
    'video/webm': '.webm',
    'video/quicktime': '.mov',
    'video/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.mp4',
    'audio/ogg': '.ogg',
    'audio/wav': '.wav',
    'audio/x-m4a': '.m4a',
    'audio/webm': '.webm'
  }

  const mimeKey = mainType && subtype ? `${mainType}/${subtype.trim()}` : ''
  if (mimeKey && known[mimeKey]) return known[mimeKey]
  return mediaType === 'image' ? '.png' : mediaType === 'video' ? '.mp4' : '.mp3'
}

function textNodeContent(metadata: NonNullable<CanvasNodeData['metadata']>): string | null {
  for (const value of [metadata.content, metadata.prompt, metadata.composerContent]) {
    if (hasContent(value)) return value
  }
  return null
}

export function collectBatchDownloadItems(nodes: CanvasNodeData[]): BatchDownloadItem[] {
  const items: BatchDownloadItem[] = []

  for (const node of nodes) {
    if (node.type === 'group') continue

    const baseName = sanitizeBatchFilename(node.title || `canvas-${node.type}`)
    const metadata = node.metadata ?? {}

    if (node.type === 'image') {
      const images = Array.isArray(metadata.images)
        ? metadata.images.map(canvasGeneratedImageContent).filter(hasContent)
        : []
      const sources = images.length ? images : [metadata.content]

      sources.forEach((content, index) => {
        if (!hasContent(content)) return
        items.push({
          baseName: images.length > 1 ? `${baseName}-${index + 1}` : baseName,
          kind: 'media',
          mediaType: 'image',
          content
        })
      })
      continue
    }

    if (node.type === 'video' || node.type === 'audio') {
      if (hasContent(metadata.content)) {
        items.push({
          baseName,
          kind: 'media',
          mediaType: node.type === 'video' ? 'video' : 'audio',
          content: metadata.content
        })
      }
      continue
    }

    if (node.type === 'config') {
      items.push({
        baseName,
        kind: 'text',
        extension: '.json',
        content: JSON.stringify(metadata, null, 2)
      })
      continue
    }

    const content = textNodeContent(metadata)
    if (content) items.push({ baseName, kind: 'text', extension: '.txt', content })
  }

  return items
}

export function buildZipBlob(files: BatchZipFile[]): Blob {
  const entries: Record<string, Uint8Array> = {}
  const used = new Set<string>()
  for (const file of files) {
    entries[uniqueBatchFilename(file.filename, used)] = file.data
  }
  return new Blob([zipSync(entries)], { type: 'application/zip' })
}
