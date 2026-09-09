import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'
import { createDesignBoardDoc, createRectObject } from '../design-board-types'
import type { DesignBoardDoc } from '../design-board-types'
import { renderDesignBoardToCanvas } from '../design-board-renderer'
import { exportDesignBoardImage } from '../design-board-export'
import { getDesignBoardThumbnail, invalidateDesignBoardThumbnail } from '../design-board-thumbnail'

vi.mock('../design-board-renderer', async (importOriginal) => {
  const original = await importOriginal<typeof import('../design-board-renderer')>()
  return {
    ...original,
    renderDesignBoardToCanvas: vi.fn(async (ctx: CanvasRenderingContext2D, doc: DesignBoardDoc) => {
      ctx.fillRect(0, 0, doc.width, doc.height)
    })
  }
})

function stubCanvasContext(): CanvasRenderingContext2D {
  const ctx = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    measureText: vi.fn(() => ({ width: 0 })),
    fillText: vi.fn()
  }
  return ctx as unknown as CanvasRenderingContext2D
}

const renderCallCount = (): number => vi.mocked(renderDesignBoardToCanvas).mock.calls.length

function boardNode(id: string, designUpdatedAt: number): CanvasNodeData {
  return {
    id,
    type: 'design-board',
    title: `画板${id}`,
    position: { x: 0, y: 0 },
    width: 340,
    height: 240,
    metadata: { design: createDesignBoardDoc(100, 100), designUpdatedAt }
  }
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => stubCanvasContext())
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (
    this: HTMLCanvasElement,
    type?: string
  ) {
    return `data:${type ?? 'image/png'};base64,TEST`
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('exportDesignBoardImage', () => {
  it('renders at multiplier and returns data url with dimensions', async () => {
    const doc = createDesignBoardDoc(100, 200)
    doc.objects.push(createRectObject(0, 0, 10, 10))
    const result = await exportDesignBoardImage(doc, [], { format: 'png', multiplier: 2 })
    expect(result).toMatchObject({ width: 200, height: 400 })
    expect(result.dataUrl.startsWith('data:image/png')).toBe(true)
  })

  it('uses image/jpeg mime for jpg format', async () => {
    const result = await exportDesignBoardImage(createDesignBoardDoc(50, 50), [], { format: 'jpg' })
    expect(result.dataUrl.startsWith('data:image/jpeg')).toBe(true)
  })
})

describe('getDesignBoardThumbnail', () => {
  it('caches by node key and renders only once for repeated requests', async () => {
    const node = boardNode('board1', 1)
    const callsBefore = renderCallCount()
    const first = await getDesignBoardThumbnail(node, [])
    const second = await getDesignBoardThumbnail(node, [])
    expect(first).toBeTruthy()
    expect(second).toBe(first)
    expect(renderCallCount()).toBe(callsBefore + 1)
  })

  it('re-renders after invalidation while other boards stay cached', async () => {
    const nodeA = boardNode('board-a', 2)
    const nodeB = boardNode('board-b', 3)
    const callsBefore = renderCallCount()
    await getDesignBoardThumbnail(nodeA, [])
    await getDesignBoardThumbnail(nodeB, [])
    expect(renderCallCount()).toBe(callsBefore + 2)
    invalidateDesignBoardThumbnail('board-a')
    const refreshed = await getDesignBoardThumbnail(nodeA, [])
    expect(refreshed).toBeTruthy()
    expect(renderCallCount()).toBe(callsBefore + 3)
    await getDesignBoardThumbnail(nodeB, [])
    expect(renderCallCount()).toBe(callsBefore + 3)
  })
})
