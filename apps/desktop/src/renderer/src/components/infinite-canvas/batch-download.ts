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

const WINDOWS_INVALID = /[<>:"/\\|?*\u0000-\u001f]/g

export function sanitizeBatchFilename(value: string): string {
  const sanitized = value
    .trim()
    .replace(WINDOWS_INVALID, '-')
    .replace(/[-. ]+$/g, '')
  return sanitized || '未命名节点'
}

export function uniqueBatchFilename(filename: string, used: Set<string>): string {
  if (!used.has(filename)) {
    used.add(filename)
    return filename
  }

  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const extension = dot > 0 ? filename.slice(dot) : ''
  let index = 2
  let candidate = `${stem}-${index}${extension}`
  while (used.has(candidate)) candidate = `${stem}-${++index}${extension}`
  used.add(candidate)
  return candidate
}

export function mediaFileExtension(
  mime: string | undefined,
  mediaType: 'image' | 'video' | 'audio'
): string {
  const subtype = (mime ?? '').toLowerCase().split(';')[0].split('/')[1]?.trim()
  const known: Record<typeof mediaType, Record<string, string>> = {
    image: {
      jpeg: '.jpg',
      png: '.png',
      webp: '.webp',
      gif: '.gif',
      avif: '.avif',
      'svg+xml': '.svg',
      'x-icon': '.ico'
    },
    video: {
      mp4: '.mp4',
      mpeg: '.mpeg',
      webm: '.webm',
      quicktime: '.mov'
    },
    audio: {
      mpeg: '.mp3',
      ogg: '.ogg',
      wav: '.wav',
      'x-m4a': '.m4a',
      webm: '.webm'
    }
  }

  if (subtype && known[mediaType][subtype]) return known[mediaType][subtype]
  return mediaType === 'image' ? '.png' : mediaType === 'video' ? '.mp4' : '.mp3'
}

export function collectBatchDownloadItems(nodes: CanvasNodeData[]): BatchDownloadItem[] {
  const items: BatchDownloadItem[] = []

  for (const node of nodes) {
    if (node.type === 'group') continue

    const baseName = sanitizeBatchFilename(node.title || `canvas-${node.type}`)
    const metadata = node.metadata ?? {}

    if (node.type === 'image') {
      const images = Array.isArray(metadata.images)
        ? metadata.images
            .map(canvasGeneratedImageContent)
            .filter((content): content is string => Boolean(content))
        : []
      const sources = images.length ? images : [metadata.content]

      sources.forEach((content, index) => {
        if (typeof content !== 'string' || !content) return
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
      if (typeof metadata.content === 'string' && metadata.content) {
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

    const content = typeof metadata.content === 'string' ? metadata.content : ''
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
