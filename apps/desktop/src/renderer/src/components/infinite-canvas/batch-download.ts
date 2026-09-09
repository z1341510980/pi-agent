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
export type BatchDownloadCollection = {
  items: BatchDownloadItem[]
  emptyNodeTitles: string[]
}
export type BatchDownloadArchiveResult = {
  archive: Blob | null
  files: BatchZipFile[]
  failures: string[]
  emptyNodeTitles: string[]
}
export type BatchDownloadNotice = { variant: 'success' | 'error'; message: string }

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
  return collectBatchDownloadItemsWithEmptyNodes(nodes).items
}

export function collectBatchDownloadItemsWithEmptyNodes(
  nodes: CanvasNodeData[]
): BatchDownloadCollection {
  const items: BatchDownloadItem[] = []
  const emptyNodeTitles: string[] = []

  for (const node of nodes) {
    if (node.type === 'group') continue

    const baseName = sanitizeBatchFilename(node.title || `canvas-${node.type}`)
    const itemCount = items.length
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
      if (items.length === itemCount) emptyNodeTitles.push(node.title || `canvas-${node.type}`)
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
      if (items.length === itemCount) emptyNodeTitles.push(node.title || `canvas-${node.type}`)
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

    if (node.type === 'design-board') {
      const design = metadata.design
      if (design && typeof design === 'object') {
        items.push({
          baseName,
          kind: 'text',
          extension: '.json',
          content: JSON.stringify(design, null, 2)
        })
      }
      continue
    }

    const content = textNodeContent(metadata)
    if (content) items.push({ baseName, kind: 'text', extension: '.txt', content })
    else emptyNodeTitles.push(node.title || `canvas-${node.type}`)
  }

  return { items, emptyNodeTitles }
}

export function buildZipBlob(files: BatchZipFile[]): Blob {
  const entries: Record<string, Uint8Array> = {}
  const used = new Set<string>()
  for (const file of files) {
    entries[uniqueBatchFilename(file.filename, used)] = file.data
  }
  return new Blob([zipSync(entries)], { type: 'application/zip' })
}

export async function buildBatchDownloadArchive(
  collection: BatchDownloadCollection,
  resolveMedia: (content: string) => Promise<Blob>
): Promise<BatchDownloadArchiveResult> {
  const files: BatchZipFile[] = []
  const failures: string[] = []
  const usedNames = new Set<string>()

  for (const item of collection.items) {
    try {
      const blob =
        item.kind === 'media'
          ? await resolveMedia(item.content)
          : new Blob([item.content], {
              type: item.extension === '.json' ? 'application/json' : 'text/plain;charset=utf-8'
            })
      const extension =
        item.kind === 'media' ? mediaFileExtension(blob.type, item.mediaType) : item.extension
      const filename = uniqueBatchFilename(`${item.baseName}${extension}`, usedNames)
      files.push({ filename, data: new Uint8Array(await blob.arrayBuffer()) })
    } catch (reason) {
      failures.push(`${item.baseName}: ${reason instanceof Error ? reason.message : '读取失败'}`)
    }
  }

  return {
    archive: files.length ? buildZipBlob(files) : null,
    files,
    failures,
    emptyNodeTitles: collection.emptyNodeTitles
  }
}

export function formatBatchDownloadNotice(result: BatchDownloadArchiveResult): BatchDownloadNotice {
  if (!result.archive) {
    const details = [
      ...result.failures,
      ...(result.emptyNodeTitles.length
        ? [`无有效内容节点：${result.emptyNodeTitles.join('、')}`]
        : [])
    ]
    return {
      variant: 'error',
      message: details.length
        ? `没有可下载的文件：${details.join('；')}`
        : '选中的节点没有可下载内容'
    }
  }

  const emptySummary = result.emptyNodeTitles.length
    ? `，${result.emptyNodeTitles.length} 个节点无有效内容：${result.emptyNodeTitles.join('、')}`
    : ''
  const failureSummary = result.failures.length
    ? `，${result.failures.length} 个文件失败：${result.failures.join('；')}`
    : ''
  return {
    variant: result.failures.length ? 'error' : 'success',
    message: `已打包 ${result.files.length} 个文件${failureSummary}${emptySummary}`
  }
}

export async function withBatchDownloading<T>(
  operation: () => Promise<T>,
  setDownloading: (value: boolean) => void
): Promise<T> {
  setDownloading(true)
  try {
    return await operation()
  } finally {
    setDownloading(false)
  }
}
