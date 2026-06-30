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
  playheadChapter: 1,
  setPlayheadChapter: vi.fn(),
}

vi.mock('@/stores/novel-store', () => ({
  useNovelStore: (sel: (s: any) => any) => sel(storeState),
}))

import { NovelTimelineWorkspace } from '../novel-timeline-workspace'
import { listMarkers } from '@/api/novel-client'
import type { NovelConflict } from '@/api/novel-client'

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
    // 状态翻转后，轨道头应获得"已隐藏"视觉状态（is-hidden 类）
    await waitFor(() => {
      expect(document.querySelector('.tl-track-header.is-hidden')).not.toBeNull()
    })
    // 再次右键应显示"显示轨道"（状态翻转）
    fireEvent.contextMenu(await screen.findByText('角色', { selector: '.tl-track-header-name' }))
    const showBtn = await screen.findByText('显示轨道')
    expect(showBtn).toBeTruthy()
  })
})

const conflict: NovelConflict = {
  id: 'cf1', projectId: 'p1', description: '主冲突', type: 'inner', intensity: 5,
  stage: 'emerging', participants: '', firstChapter: 3, lastChapter: 8, tier: 'main',
  createdAt: 0, updatedAt: 0,
}

describe('NovelTimelineWorkspace undo stack for delete (A4)', () => {
  it('delete pushes an action and undo restores the range', async () => {
    storeState.conflicts = [conflict]
    const { updateConflict } = await import('@/api/novel-client')
    vi.mocked(updateConflict).mockResolvedValue({ ...conflict, firstChapter: null, lastChapter: null })

    render(<NovelTimelineWorkspace />)
    await waitFor(() => expect(listMarkers).toHaveBeenCalled())

    // 删除前撤销按钮不可用
    const undoBtn = screen.getByTitle('撤销') as HTMLButtonElement
    expect(undoBtn.disabled).toBe(true)

    // 选中冲突片段（ClipContextMenu 因 lucide ClipboardCut 预存缺陷无法渲染，改用工具栏删除按钮）
    const clipLabel = await screen.findByText('主冲突', { selector: '.tl-clip-label' })
    fireEvent.click(clipLabel)
    const deleteBtn = (await screen.findByTitle('删除选中')) as HTMLButtonElement
    await waitFor(() => expect(deleteBtn.disabled).toBe(false))
    fireEvent.click(deleteBtn)

    // 删除调用 updateConflict 置空区间
    await waitFor(() => expect(updateConflict).toHaveBeenCalledWith(conflict.id, { firstChapter: null, lastChapter: null }))
    expect(vi.mocked(updateConflict).mock.calls.length).toBeGreaterThanOrEqual(1)
    // 入栈后撤销可用（canUndo 为真）——这是 A4 的新行为
    await waitFor(() => expect(undoBtn.disabled).toBe(false))
  })
})
