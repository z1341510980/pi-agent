import { canvasGeneratedImageContent } from '@/api/infinite-canvas-client'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'

export const DESIGN_BOARD_DOC_VERSION = 1
export const DESIGN_IMAGE_PLACEHOLDER = 'design-board:placeholder'

const SYSTEM_FONT_STACK = `system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif`

export function designBoardFontFamily(): string {
  return SYSTEM_FONT_STACK
}

export type DesignBoardTextAlign = 'left' | 'center' | 'right'

interface DesignBoardBase {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface DesignBoardTextObject extends DesignBoardBase {
  kind: 'text'
  text: string
  fontSize: number
  fontWeight: number
  align: DesignBoardTextAlign
  color: string
}

export interface DesignBoardImageObject extends DesignBoardBase {
  kind: 'image'
  source: DesignImageSource
  radius: number
}

export interface DesignBoardRectObject extends DesignBoardBase {
  kind: 'rect'
  fill: string
  stroke: string
  strokeWidth: number
  radius: number
}

export type DesignImageSource =
  | { kind: 'node-ref'; nodeId: string; index: number }
  | { kind: 'url'; url: string }
  | { kind: 'data'; dataUrl: string }

export type DesignBoardObject =
  | DesignBoardTextObject
  | DesignBoardImageObject
  | DesignBoardRectObject

export interface DesignBoardDoc {
  version: typeof DESIGN_BOARD_DOC_VERSION
  width: number
  height: number
  background: string
  objects: DesignBoardObject[]
}

function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, value))
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return crypto.randomUUID()
  return `dbo-${Math.random().toString(36).slice(2)}`
}

export function createDesignBoardDoc(width: number, height: number): DesignBoardDoc {
  return {
    version: DESIGN_BOARD_DOC_VERSION,
    width: clampInt(width, 100, 16000, 1080),
    height: clampInt(height, 100, 16000, 1440),
    background: '#ffffff',
    objects: []
  }
}

export function createTextObject(x: number, y: number, width: number): DesignBoardTextObject {
  const fontSize = 64
  return {
    id: makeId(),
    kind: 'text',
    x,
    y,
    width,
    height: Math.round(fontSize * 1.22),
    text: '',
    fontSize,
    fontWeight: 400,
    align: 'left',
    color: '#171717'
  }
}

export function createRectObject(
  x: number,
  y: number,
  width: number,
  height: number
): DesignBoardRectObject {
  return {
    id: makeId(),
    kind: 'rect',
    x,
    y,
    width,
    height,
    fill: '#262626',
    stroke: 'transparent',
    strokeWidth: 0,
    radius: 0
  }
}

export function createImageObject(
  source: DesignImageSource,
  x: number,
  y: number,
  width: number,
  height: number
): DesignBoardImageObject {
  return { id: makeId(), kind: 'image', x, y, width, height, source, radius: 0 }
}

export type DesignBoardZOrderAction = 'front' | 'back' | 'forward' | 'backward'

export function reorderDesignBoardObject(
  objects: DesignBoardObject[],
  id: string,
  action: DesignBoardZOrderAction
): DesignBoardObject[] {
  const index = objects.findIndex((object) => object.id === id)
  if (index === -1) return objects
  const last = objects.length - 1
  if ((action === 'front' || action === 'forward') && index === last) return objects
  if ((action === 'back' || action === 'backward') && index === 0) return objects
  const next = objects.slice()
  if (action === 'front' || action === 'back') {
    const [object] = next.splice(index, 1)
    if (action === 'front') next.push(object)
    else next.unshift(object)
    return next
  }
  const target = action === 'forward' ? index + 1 : index - 1
  next[index] = objects[target]
  next[target] = objects[index]
  return next
}

function parseBase(raw: Record<string, unknown>): DesignBoardBase | null {
  const x = clampNumber(toNumber(raw.x), -100000, 100000, 0)
  const y = clampNumber(toNumber(raw.y), -100000, 100000, 0)
  const width = clampInt(toNumber(raw.width), 1, 16000, 1)
  const height = clampInt(toNumber(raw.height), 1, 16000, 1)
  const id = typeof raw.id === 'string' && raw.id ? raw.id : makeId()
  return { id, x, y, width, height }
}

function parseImageSource(raw: unknown): DesignImageSource | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (
    value.kind === 'node-ref' &&
    typeof value.nodeId === 'string' &&
    Number.isInteger(value.index) &&
    (value.index as number) >= 0
  ) {
    return { kind: 'node-ref', nodeId: value.nodeId, index: value.index as number }
  }
  if (value.kind === 'url' && typeof value.url === 'string' && value.url)
    return { kind: 'url', url: value.url }
  if (
    value.kind === 'data' &&
    typeof value.dataUrl === 'string' &&
    value.dataUrl.startsWith('data:')
  ) {
    return { kind: 'data', dataUrl: value.dataUrl }
  }
  return null
}

function parseObject(raw: unknown): DesignBoardObject | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const base = parseBase(value)
  if (!base) return null
  if (value.kind === 'text') {
    return {
      ...base,
      kind: 'text',
      text: typeof value.text === 'string' ? value.text : '',
      fontSize: clampInt(toNumber(value.fontSize), 8, 512, 64),
      fontWeight: clampInt(toNumber(value.fontWeight), 100, 900, 400),
      align: value.align === 'center' || value.align === 'right' ? value.align : 'left',
      color: typeof value.color === 'string' && value.color ? value.color : '#171717'
    }
  }
  if (value.kind === 'image') {
    const source = parseImageSource(value.source)
    if (!source) return null
    return { ...base, kind: 'image', source, radius: clampInt(toNumber(value.radius), 0, 16000, 0) }
  }
  if (value.kind === 'rect') {
    return {
      ...base,
      kind: 'rect',
      fill: typeof value.fill === 'string' && value.fill ? value.fill : '#262626',
      stroke: typeof value.stroke === 'string' && value.stroke ? value.stroke : 'transparent',
      strokeWidth: clampNumber(toNumber(value.strokeWidth), 0, 1600, 0),
      radius: clampInt(toNumber(value.radius), 0, 16000, 0)
    }
  }
  return null
}

export function parseDesignBoardDoc(raw: unknown): DesignBoardDoc | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (value.version !== DESIGN_BOARD_DOC_VERSION) return null
  if (typeof value.width !== 'number' || typeof value.height !== 'number') return null
  if (!Array.isArray(value.objects)) return null
  const objects = value.objects
    .map((item) => parseObject(item))
    .filter((item): item is DesignBoardObject => item !== null)
  return {
    version: DESIGN_BOARD_DOC_VERSION,
    width: clampInt(value.width, 100, 16000, 1080),
    height: clampInt(value.height, 100, 16000, 1440),
    background:
      typeof value.background === 'string' && value.background ? value.background : '#ffffff',
    objects
  }
}

export function resolveDesignImageSource(
  source: DesignImageSource,
  nodes: CanvasNodeData[]
): string {
  if (source.kind === 'url') return source.url
  if (source.kind === 'data') return source.dataUrl
  const node = nodes.find((item) => item.id === source.nodeId)
  if (!node) return DESIGN_IMAGE_PLACEHOLDER
  if (source.index === 0) {
    const content = node.metadata?.content
    return typeof content === 'string' && content ? content : DESIGN_IMAGE_PLACEHOLDER
  }
  const images = Array.isArray(node.metadata?.images) ? node.metadata.images : []
  const entry = images[source.index - 1]
  if (entry === undefined) return DESIGN_IMAGE_PLACEHOLDER
  const content = canvasGeneratedImageContent(entry)
  return typeof content === 'string' && content ? content : DESIGN_IMAGE_PLACEHOLDER
}
