import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DESIGN_IMAGE_PLACEHOLDER,
  createDesignBoardDoc,
  createImageObject,
  createRectObject,
  createTextObject
} from '../design-board-types'
import { layoutDesignText, renderDesignBoardToCanvas } from '../design-board-renderer'

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
      radius: 0
    })
    await renderDesignBoardToCanvas(ctx, doc, () => Promise.resolve(DESIGN_IMAGE_PLACEHOLDER))
    expect(ctx.drawImage).not.toHaveBeenCalled()
  })
})
