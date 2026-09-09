import { proxyExternalImageUrl } from '@/api/infinite-canvas-client'
import { DESIGN_IMAGE_PLACEHOLDER, designBoardFontFamily } from './design-board-types'
import type {
  DesignBoardDoc,
  DesignBoardImageObject,
  DesignBoardRectObject,
  DesignBoardTextObject
} from './design-board-types'

export interface DesignTextLayout {
  lines: string[]
  lineHeight: number
  height: number
}

const TEXT_LINE_HEIGHT_RATIO = 1.22

function setFont(ctx: CanvasRenderingContext2D, object: DesignBoardTextObject): void {
  ctx.font = `${object.fontWeight} ${object.fontSize}px ${designBoardFontFamily()}`
}

export function measureDesignTextLine(ctx: CanvasRenderingContext2D, line: string): number {
  return ctx.measureText(line).width
}

export function layoutDesignText(
  object: DesignBoardTextObject,
  ctx: CanvasRenderingContext2D
): DesignTextLayout {
  setFont(ctx, object)
  const lineHeight = object.fontSize * TEXT_LINE_HEIGHT_RATIO
  const maxWidth = Math.max(8, object.width)
  const lines: string[] = []
  for (const paragraph of object.text.split(/\r?\n/)) {
    if (!paragraph) {
      lines.push('')
      continue
    }
    const tokens = paragraph.split(/(\s+)/).filter((token) => token.length > 0)
    let current = ''
    for (const token of tokens) {
      const candidate = current + token
      if (measureDesignTextLine(ctx, candidate) <= maxWidth) {
        current = candidate
        continue
      }
      if (current) lines.push(current.trimEnd())
      let remaining = token.trimStart()
      while (measureDesignTextLine(ctx, remaining) > maxWidth && remaining.length > 1) {
        const chars = Array.from(remaining)
        let cut = 1
        while (
          cut < chars.length &&
          measureDesignTextLine(ctx, chars.slice(0, cut + 1).join('')) <= maxWidth
        ) {
          cut += 1
        }
        lines.push(chars.slice(0, cut).join(''))
        remaining = chars.slice(cut).join('')
      }
      current = remaining
    }
    lines.push(current)
  }
  return { lines, lineHeight, height: Math.max(lineHeight, lines.length * lineHeight) }
}

export function designTextBaselineOffset(
  ctx: CanvasRenderingContext2D,
  fontSize: number,
  lineHeight: number
): number {
  const metrics = ctx.measureText('Mg') as unknown as {
    fontBoundingBoxAscent?: number
    fontBoundingBoxDescent?: number
    actualBoundingBoxAscent?: number
    actualBoundingBoxDescent?: number
  }
  const ascent = metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent ?? fontSize * 0.8
  const descent =
    metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent ?? fontSize * 0.2
  const fontBox = Math.max(1, ascent + descent)
  return (lineHeight - fontBox) / 2 + ascent
}

const imageElementCache = new Map<string, Promise<HTMLImageElement | null>>()
const IMAGE_ELEMENT_CACHE_LIMIT = 64

export function loadDesignImageElement(rawUrl: string): Promise<HTMLImageElement | null> {
  if (rawUrl === DESIGN_IMAGE_PLACEHOLDER) return Promise.resolve(null)
  const safeUrl = proxyExternalImageUrl(rawUrl)
  const cached = imageElementCache.get(safeUrl)
  if (cached) return cached
  const task = new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image()
    if (!safeUrl.startsWith('data:') && !safeUrl.startsWith('blob:')) {
      image.crossOrigin = 'anonymous'
    }
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = safeUrl
  })
  imageElementCache.set(safeUrl, task)
  void task.then((element) => {
    if (!element) {
      imageElementCache.delete(safeUrl)
      return
    }
    while (imageElementCache.size > IMAGE_ELEMENT_CACHE_LIMIT) {
      const oldest = imageElementCache.keys().next().value
      if (oldest === undefined || oldest === safeUrl) break
      imageElementCache.delete(oldest)
    }
  })
  return task
}

type CanvasContextWithoutRoundRect = Omit<CanvasRenderingContext2D, 'roundRect'> & {
  roundRect?: CanvasRenderingContext2D['roundRect']
}

export function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  radius: number
): void {
  const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2))
  ctx.beginPath()
  const context = ctx as CanvasContextWithoutRoundRect
  if (typeof context.roundRect === 'function') {
    context.roundRect(0, 0, width, height, r)
    return
  }
  context.moveTo(r, 0)
  context.lineTo(width - r, 0)
  context.quadraticCurveTo(width, 0, width, r)
  context.lineTo(width, height - r)
  context.quadraticCurveTo(width, height, width - r, height)
  context.lineTo(r, height)
  context.quadraticCurveTo(0, height, 0, height - r)
  context.lineTo(0, r)
  context.quadraticCurveTo(0, 0, r, 0)
  context.closePath()
}

function drawRect(ctx: CanvasRenderingContext2D, object: DesignBoardRectObject): void {
  roundedRectPath(ctx, object.width, object.height, object.radius)
  ctx.fillStyle = object.fill
  ctx.fill()
  if (object.strokeWidth > 0) {
    ctx.strokeStyle = object.stroke
    ctx.lineWidth = object.strokeWidth
    ctx.stroke()
  }
}

function drawText(ctx: CanvasRenderingContext2D, object: DesignBoardTextObject): void {
  const layout = layoutDesignText(object, ctx)
  const baseline = designTextBaselineOffset(ctx, object.fontSize, layout.lineHeight)
  const anchorX =
    object.align === 'center' ? object.width / 2 : object.align === 'right' ? object.width : 0
  ctx.fillStyle = object.color
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  layout.lines.forEach((line, index) => {
    const y = index * layout.lineHeight + baseline
    const lineWidth = measureDesignTextLine(ctx, line)
    const startX =
      object.align === 'center'
        ? anchorX - lineWidth / 2
        : object.align === 'right'
          ? anchorX - lineWidth
          : 0
    ctx.fillText(line, startX, y)
  })
}

async function drawImageObject(
  ctx: CanvasRenderingContext2D,
  object: DesignBoardImageObject,
  resolveImage: (ref: string) => Promise<string>
): Promise<void> {
  const raw =
    object.source.kind === 'node-ref'
      ? await resolveImage(`${object.source.nodeId}:${object.source.index}`)
      : object.source.kind === 'url'
        ? object.source.url
        : object.source.dataUrl
  if (!raw || raw === DESIGN_IMAGE_PLACEHOLDER) return
  const element = await loadDesignImageElement(raw)
  if (!element) return
  ctx.save()
  roundedRectPath(ctx, object.width, object.height, object.radius)
  ctx.clip()
  ctx.drawImage(element, 0, 0, object.width, object.height)
  ctx.restore()
}

export async function renderDesignBoardToCanvas(
  ctx: CanvasRenderingContext2D,
  doc: DesignBoardDoc,
  resolveImage: (ref: string) => Promise<string>
): Promise<void> {
  ctx.clearRect(0, 0, doc.width, doc.height)
  ctx.fillStyle = doc.background
  ctx.fillRect(0, 0, doc.width, doc.height)
  for (const object of doc.objects) {
    // 调用方必须对 ctx 独占（await 交错会损坏状态栈）
    ctx.save()
    ctx.translate(object.x + object.width / 2, object.y + object.height / 2)
    ctx.translate(-object.width / 2, -object.height / 2)
    if (object.kind === 'rect') drawRect(ctx, object)
    else if (object.kind === 'text') drawText(ctx, object)
    else await drawImageObject(ctx, object, resolveImage)
    ctx.restore()
  }
}
