import { proxyExternalImageUrl } from '@/api/infinite-canvas-client'
import { DESIGN_IMAGE_PLACEHOLDER, designBoardFontFamily } from './design-board-types'
import type {
  DesignBoardArrowObject,
  DesignBoardDoc,
  DesignBoardEllipseObject,
  DesignBoardImageObject,
  DesignBoardLineObject,
  DesignBoardPolygonObject,
  DesignBoardRectObject,
  DesignBoardStarObject,
  DesignBoardTextObject
} from './design-board-types'

export interface DesignTextLayout {
  lines: string[]
  lineHeight: number
  height: number
}

export const DESIGN_TEXT_LINE_HEIGHT_RATIO = 1.22

/** 与 canvas 渲染一致的字体设置：DOM 文本排版测量前复用，保证换行结果同源。 */
export function exportDesignTextFont(
  ctx: CanvasRenderingContext2D,
  object: DesignBoardTextObject
): void {
  ctx.font = `${object.fontWeight} ${object.fontSize}px ${designBoardFontFamily()}`
}

export function measureDesignTextLine(ctx: CanvasRenderingContext2D, line: string): number {
  return ctx.measureText(line).width
}

export function layoutDesignText(
  object: DesignBoardTextObject,
  ctx: CanvasRenderingContext2D
): DesignTextLayout {
  exportDesignTextFont(ctx, object)
  const lineHeight = object.fontSize * DESIGN_TEXT_LINE_HEIGHT_RATIO
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
  fillAndStroke(ctx, object.fill, object.stroke, object.strokeWidth)
}

function fillAndStroke(
  ctx: CanvasRenderingContext2D,
  fill: string,
  stroke: string,
  strokeWidth: number
): void {
  ctx.fillStyle = fill
  ctx.fill()
  if (strokeWidth > 0) {
    ctx.strokeStyle = stroke
    ctx.lineWidth = strokeWidth
    ctx.stroke()
  }
}

function formatCoord(value: number): number {
  return Math.round(value * 100) / 100
}

/** 多边形顶点序列：顶点从 -π/2 起按边数等分（外接于宽高框）。 */
function polygonVertexes(width: number, height: number, sides: number): Array<[number, number]> {
  const count = Math.max(3, sides)
  const result: Array<[number, number]> = []
  for (let i = 0; i < count; i += 1) {
    const angle = -Math.PI / 2 + (i / count) * Math.PI * 2
    result.push([
      width / 2 + Math.cos(angle) * (width / 2),
      height / 2 + Math.sin(angle) * (height / 2)
    ])
  }
  return result
}

/** 星形顶点序列：2·points 个顶点交替外/内半径（1 / 0.45）。 */
function starVertexes(width: number, height: number, points: number): Array<[number, number]> {
  const count = Math.max(4, points)
  const result: Array<[number, number]> = []
  for (let i = 0; i < count * 2; i += 1) {
    const angle = -Math.PI / 2 + (i / (count * 2)) * Math.PI * 2
    const ratio = i % 2 === 0 ? 1 : 0.45
    result.push([
      width / 2 + Math.cos(angle) * (width / 2) * ratio,
      height / 2 + Math.sin(angle) * (height / 2) * ratio
    ])
  }
  return result
}

/** SVG points 语法顶点串：DOM 渲染与 canvas 共用顶点公式。 */
export function designPolygonPoints(width: number, height: number, sides: number): string {
  return polygonVertexes(width, height, sides)
    .map(([x, y]) => `${formatCoord(x)},${formatCoord(y)}`)
    .join(' ')
}

export function designStarPoints(width: number, height: number, points: number): string {
  return starVertexes(width, height, points)
    .map(([x, y]) => `${formatCoord(x)},${formatCoord(y)}`)
    .join(' ')
}

export interface DesignArrowGeometry {
  /** 线段 y（= height/2） */
  y: number
  /** 线段起点 x（左端内缩防裁切） */
  shaftX1: number
  /** 箭头尖端 x */
  tipX: number
  headLen: number
  spread: number
}

/** 箭头几何：尖端/头长/张角公式（avnac 对齐），canvas 与 DOM 渲染共用。 */
export function designArrowGeometry(object: {
  width: number
  height: number
  strokeWidth: number
  headSize: number
}): DesignArrowGeometry {
  const sw = object.strokeWidth
  const pad = sw / 2
  return {
    y: object.height / 2,
    shaftX1: pad,
    tipX: Math.max(pad + 1, object.width - sw * 1.8),
    headLen: Math.max(sw * 2, sw * 4 * object.headSize),
    spread: Math.max(sw * 1.6, sw * 3.2 * object.headSize)
  }
}

function drawEllipse(ctx: CanvasRenderingContext2D, object: DesignBoardEllipseObject): void {
  ctx.beginPath()
  ctx.ellipse(
    object.width / 2,
    object.height / 2,
    object.width / 2,
    object.height / 2,
    0,
    0,
    Math.PI * 2
  )
  fillAndStroke(ctx, object.fill, object.stroke, object.strokeWidth)
}

function traceClosedPath(ctx: CanvasRenderingContext2D, points: Array<[number, number]>): void {
  ctx.beginPath()
  points.forEach(([x, y], index) => {
    if (index === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  ctx.closePath()
}

function drawPolygon(ctx: CanvasRenderingContext2D, object: DesignBoardPolygonObject): void {
  traceClosedPath(ctx, polygonVertexes(object.width, object.height, object.sides))
  fillAndStroke(ctx, object.fill, object.stroke, object.strokeWidth)
}

function drawStar(ctx: CanvasRenderingContext2D, object: DesignBoardStarObject): void {
  traceClosedPath(ctx, starVertexes(object.width, object.height, object.points))
  fillAndStroke(ctx, object.fill, object.stroke, object.strokeWidth)
}

function drawLine(ctx: CanvasRenderingContext2D, object: DesignBoardLineObject): void {
  const y = object.height / 2
  const x1 = object.strokeWidth / 2
  const x2 = Math.max(x1, object.width - object.strokeWidth / 2)
  ctx.beginPath()
  ctx.moveTo(x1, y)
  ctx.lineTo(x2, y)
  ctx.strokeStyle = object.stroke
  ctx.lineWidth = object.strokeWidth
  ctx.stroke()
}

function drawArrow(ctx: CanvasRenderingContext2D, object: DesignBoardArrowObject): void {
  const geometry = designArrowGeometry(object)
  const { y, shaftX1, tipX, headLen, spread } = geometry
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(shaftX1, y)
  ctx.lineTo(tipX, y)
  ctx.strokeStyle = object.stroke
  ctx.lineWidth = object.strokeWidth
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(tipX, y)
  ctx.lineTo(tipX - headLen, y - spread / 2)
  ctx.lineTo(tipX - headLen * 0.82, y)
  ctx.lineTo(tipX - headLen, y + spread / 2)
  ctx.closePath()
  ctx.fillStyle = object.stroke
  ctx.fill()
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
    if (!object.visible) continue
    // 调用方必须对 ctx 独占（await 交错会损坏状态栈）
    ctx.save()
    ctx.translate(object.x + object.width / 2, object.y + object.height / 2)
    ctx.translate(-object.width / 2, -object.height / 2)
    if (object.kind === 'rect') drawRect(ctx, object)
    else if (object.kind === 'ellipse') drawEllipse(ctx, object)
    else if (object.kind === 'polygon') drawPolygon(ctx, object)
    else if (object.kind === 'star') drawStar(ctx, object)
    else if (object.kind === 'line') drawLine(ctx, object)
    else if (object.kind === 'arrow') drawArrow(ctx, object)
    else if (object.kind === 'text') drawText(ctx, object)
    else await drawImageObject(ctx, object, resolveImage)
    ctx.restore()
  }
}
