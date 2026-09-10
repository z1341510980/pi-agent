import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DESIGN_IMAGE_PLACEHOLDER,
  createArrowObject,
  createDesignBoardDoc,
  createEllipseObject,
  createImageObject,
  createLineObject,
  createPolygonObject,
  createRectObject,
  createStarObject,
  createTextObject,
  designBoardFontFamily
} from '../design-board-types'
import {
  designArrowGeometry,
  exportDesignTextFont,
  layoutDesignText,
  renderDesignBoardToCanvas
} from '../design-board-renderer'

function mockCtx(): CanvasRenderingContext2D {
  let currentFont = ''
  const ctx = {
    fillRect: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    roundRect: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    clip: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    setTransform: vi.fn(),
    quadraticCurveTo: vi.fn(),
    ellipse: vi.fn(),
    setLineDash: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: text.length * 10 })),
    set font(value: string) {
      currentFont = value
    },
    get font() {
      return currentFont
    }
  }
  return ctx as unknown as CanvasRenderingContext2D
}

class StubImageElement {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  crossOrigin: string | null = null
  private srcValue = ''

  get src(): string {
    return this.srcValue
  }

  set src(value: string) {
    this.srcValue = value
    queueMicrotask(() => this.onload?.())
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('layoutDesignText', () => {
  it('splits explicit newlines and computes lineHeight from fontSize', () => {
    const layout = layoutDesignText({ ...createTextObject(0, 0, 400), text: 'a\nb' }, mockCtx())
    expect(layout.lines).toEqual(['a', 'b'])
    expect(layout.lineHeight).toBeCloseTo(64 * 1.22)
    expect(layout.height).toBeCloseTo(2 * 64 * 1.22)
  })

  it('wraps long single tokens at character level', () => {
    const layout = layoutDesignText({ ...createTextObject(0, 0, 25), text: 'abcdef' }, mockCtx())
    expect(layout.lines.length).toBeGreaterThanOrEqual(3)
    layout.lines.forEach((line) => expect(line.length).toBeGreaterThan(0))
  })

  it('exportDesignTextFont sets the shared canvas font string', () => {
    const ctx = mockCtx()
    exportDesignTextFont(ctx, { ...createTextObject(0, 0, 100), fontSize: 32, fontWeight: 700 })
    expect(ctx.font).toBe(`700 32px ${designBoardFontFamily()}`)
  })
})

describe('renderDesignBoardToCanvas', () => {
  it('fills background then draws each object and loads image sources', async () => {
    vi.stubGlobal('Image', StubImageElement)
    const ctx = mockCtx()
    const doc = createDesignBoardDoc(100, 100)
    doc.objects.push(createRectObject(0, 0, 50, 50))
    doc.objects.push(
      createImageObject({ kind: 'url', url: 'data:image/png;base64,AAA' }, 10, 10, 30, 20)
    )
    await renderDesignBoardToCanvas(ctx, doc, () => Promise.resolve('data:image/png;base64,AAA'))
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 100, 100)
    expect(ctx.fillRect).toHaveBeenCalled()
    expect(ctx.drawImage).toHaveBeenCalled()
  })

  it('resolves node-ref sources through the resolveImage callback', async () => {
    vi.stubGlobal('Image', StubImageElement)
    const ctx = mockCtx()
    const doc = createDesignBoardDoc(100, 100)
    doc.objects.push(createImageObject({ kind: 'node-ref', nodeId: 'n1', index: 0 }, 0, 0, 40, 40))
    const resolveImage = vi.fn(() => Promise.resolve('data:image/png;base64,BBB'))
    await renderDesignBoardToCanvas(ctx, doc, resolveImage)
    expect(resolveImage).toHaveBeenCalledWith('n1:0')
    expect(ctx.drawImage).toHaveBeenCalled()
  })

  it('draws nothing for placeholder sources without throwing', async () => {
    const ctx = mockCtx()
    const doc = createDesignBoardDoc(100, 100)
    doc.objects.push({
      id: 'i',
      kind: 'image',
      x: 0,
      y: 0,
      width: 50,
      height: 50,
      source: { kind: 'url', url: DESIGN_IMAGE_PLACEHOLDER },
      radius: 0,
      visible: true
    })
    await renderDesignBoardToCanvas(ctx, doc, () => Promise.resolve(DESIGN_IMAGE_PLACEHOLDER))
    expect(ctx.drawImage).not.toHaveBeenCalled()
  })

  it('skips invisible objects before touching the context state stack', async () => {
    const ctx = mockCtx()
    const doc = createDesignBoardDoc(100, 100)
    doc.objects.push(createRectObject(0, 0, 50, 50))
    doc.objects.push({ ...createRectObject(20, 20, 30, 30), visible: false })
    await renderDesignBoardToCanvas(ctx, doc, () => Promise.resolve(DESIGN_IMAGE_PLACEHOLDER))
    // 不可见对象在对象循环 save 之前被 continue：仅可见对象走一次 save/restore/translate
    expect(ctx.save).toHaveBeenCalledTimes(1)
    expect(ctx.restore).toHaveBeenCalledTimes(1)
    expect(ctx.translate).toHaveBeenCalledTimes(2)
  })

  it('ellipse: ctx.ellipse with centered radii, fill without stroke at width 0', async () => {
    const ctx = mockCtx()
    const doc = createDesignBoardDoc(200, 200)
    doc.objects.push(createEllipseObject(0, 0, 80, 60))
    await renderDesignBoardToCanvas(ctx, doc, () => Promise.resolve(DESIGN_IMAGE_PLACEHOLDER))
    expect(ctx.ellipse).toHaveBeenCalledWith(40, 30, 40, 30, 0, 0, Math.PI * 2)
    expect(ctx.fill).toHaveBeenCalledTimes(1)
    expect(ctx.stroke).not.toHaveBeenCalled()
  })

  it('polygon: traces sides count vertices, closes path and fills', async () => {
    const ctx = mockCtx()
    const doc = createDesignBoardDoc(200, 200)
    doc.objects.push(createPolygonObject(0, 0, 100, 100))
    await renderDesignBoardToCanvas(ctx, doc, () => Promise.resolve(DESIGN_IMAGE_PLACEHOLDER))
    expect(ctx.moveTo).toHaveBeenCalledTimes(1)
    expect(ctx.lineTo).toHaveBeenCalledTimes(5)
    expect(ctx.closePath).toHaveBeenCalledTimes(1)
    expect(ctx.fill).toHaveBeenCalledTimes(1)
    expect(ctx.stroke).not.toHaveBeenCalled()
  })

  it('star: traces 2·points vertices with alternating radii, closes path and fills', async () => {
    const ctx = mockCtx()
    const doc = createDesignBoardDoc(200, 200)
    doc.objects.push(createStarObject(0, 0, 100, 100))
    await renderDesignBoardToCanvas(ctx, doc, () => Promise.resolve(DESIGN_IMAGE_PLACEHOLDER))
    expect(ctx.lineTo).toHaveBeenCalledTimes(9)
    expect(ctx.closePath).toHaveBeenCalledTimes(1)
    expect(ctx.fill).toHaveBeenCalledTimes(1)
    expect(ctx.stroke).not.toHaveBeenCalled()
  })

  it('line: strokes a horizontal segment inset by half the stroke width', async () => {
    const ctx = mockCtx()
    const doc = createDesignBoardDoc(300, 100)
    doc.objects.push(createLineObject(0, 0, 200, 4))
    await renderDesignBoardToCanvas(ctx, doc, () => Promise.resolve(DESIGN_IMAGE_PLACEHOLDER))
    expect(ctx.beginPath).toHaveBeenCalled()
    expect(ctx.moveTo).toHaveBeenCalledWith(2, 2)
    expect(ctx.lineTo).toHaveBeenCalledWith(198, 2)
    expect(ctx.lineWidth).toBe(4)
    expect(ctx.stroke).toHaveBeenCalledTimes(1)
  })

  it('arrow: strokes the shaft then fills the closed head triangle', async () => {
    const ctx = mockCtx()
    const doc = createDesignBoardDoc(300, 100)
    doc.objects.push(createArrowObject(0, 0, 200, 4))
    await renderDesignBoardToCanvas(ctx, doc, () => Promise.resolve(DESIGN_IMAGE_PLACEHOLDER))
    expect(ctx.stroke).toHaveBeenCalledTimes(1)
    expect(ctx.fill).toHaveBeenCalledTimes(1)
    expect(ctx.closePath).toHaveBeenCalledTimes(1)
    const geometry = designArrowGeometry({ width: 200, height: 4, strokeWidth: 4, headSize: 1 })
    // 头部三角形四点：尖端 → 上角 → 内凹点 → 下角
    expect(ctx.moveTo).toHaveBeenLastCalledWith(
      expect.closeTo(geometry.tipX, 6),
      expect.closeTo(geometry.y, 6)
    )
    expect(ctx.lineTo).toHaveBeenLastCalledWith(
      expect.closeTo(geometry.tipX - geometry.headLen, 6),
      expect.closeTo(geometry.y + geometry.spread / 2, 6)
    )
  })
})
