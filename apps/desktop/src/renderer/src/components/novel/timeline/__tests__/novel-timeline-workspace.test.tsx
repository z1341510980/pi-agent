import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'

// jsdom 不支持 ResizeObserver，需 mock（TimelineMinimap 在挂载时使用）
class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', MockResizeObserver)

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))

vi.mock('@/api/novel-client', () => ({
  listMarkers: vi.fn().mockResolvedValue([]),
  createMarker: vi.fn(),
  updateMarker: vi.fn(),
  deleteMarker: vi.fn(),
  createCharacterHistory: vi.fn(),
  batchCreateCharacterHistory: vi.fn(),
  deleteCharacterHistory: vi.fn(),
  deleteChapter: vi.fn(),
  updateConflict: vi.fn(),
  updateForeshadow: vi.fn(),
  updateFaction: vi.fn(),
  updateLocation: vi.fn(),
}))

const storeState: Record<string, unknown> = {
  currentProjectId: 'p1',
  characters: [], chapters: [], conflicts: [], foreshadows: [],
  factions: [], locations: [], worldElements: [], characterHistory: [],
  relationships: [], markers: [],
  selectNode: vi.fn(),
  upsertConflict: vi.fn(), upsertForeshadow: vi.fn(), upsertFaction: vi.fn(), upsertLocation: vi.fn(),
  removeChapter: vi.fn(), setCharacterHistory: vi.fn(), addCharacterHistory: vi.fn(), removeCharacterHistory: vi.fn(),
  setMarkers: vi.fn(), upsertMarker: vi.fn(), removeMarker: vi.fn(),
}

vi.mock('@/stores/novel-store', () => ({
  useNovelStore: (sel: (s: any) => any) => sel(storeState),
}))

import { NovelTimelineWorkspace } from '../novel-timeline-workspace'
import { listMarkers } from '@/api/novel-client'

afterEach(() => { cleanup(); vi.clearAllMocks() })
beforeEach(() => { vi.mocked(listMarkers).mockResolvedValue([]) })

describe('NovelTimelineWorkspace track state lifting (A7)', () => {
  it('TrackContextMenu toggle visible is wired (not a no-op)', async () => {
    render(<NovelTimelineWorkspace />)
    await waitFor(() => expect(listMarkers).toHaveBeenCalled())
    // 等待轨道渲染（占位轨道存在）。筛选器按钮也含"角色"文案，需用 selector 收窄到轨道头 span。
    const trackHeader = await screen.findByText('角色', { selector: '.tl-track-header-name' })
    fireEvent.contextMenu(trackHeader)
    // 菜单弹出后点击"隐藏轨道"
    const hideBtn = await screen.findByText('隐藏轨道')
    fireEvent.click(hideBtn)
    // 再次右键应显示"显示轨道"（状态翻转）
    fireEvent.contextMenu(await screen.findByText('角色', { selector: '.tl-track-header-name' }))
    await screen.findByText('显示轨道')
    expect(true).toBe(true)
  })
})
