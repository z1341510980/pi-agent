import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { TimelineMinimap } from '../timeline-minimap'

// jsdom 不支持 ResizeObserver，需 mock
class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', MockResizeObserver)

afterEach(() => cleanup())

describe('TimelineMinimap', () => {
  it('renders viewport frame as a separate DOM element', () => {
    const tracks = [
      { id: 't1', kind: 'character' as const, label: 'A', clips: [
        { id: 'c1', startChapter: 1, endChapter: 5, effectId: 'x', entityType: 'character' as const, entityId: 'e1', label: 'A' },
      ] },
    ]
    const { container } = render(
      <TimelineMinimap tracks={tracks} maxChapter={100} chapterWidth={80} viewportStartChapter={10} viewportVisibleChapters={20} />,
    )
    const frame = container.querySelector('.tl-minimap-viewport') as HTMLElement | null
    expect(frame).not.toBeNull()
    // 视口框是独立 div，不是 canvas
    expect(frame!.tagName).toBe('DIV')
  })
})
