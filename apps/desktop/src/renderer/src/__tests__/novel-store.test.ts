import { describe, it, expect, beforeEach } from 'vitest'
import { useNovelDataStore } from '@/stores/novel-data-store'
import { useNovelUiStore } from '@/stores/novel-ui-store'

describe('novel-store playheadChapter', () => {
  beforeEach(() => {
    useNovelDataStore.getState().clearProjectData()
  })

  it('初始值为 1', () => {
    expect(useNovelUiStore.getState().playheadChapter).toBe(1)
  })
  it('setPlayheadChapter 更新值', () => {
    useNovelUiStore.getState().setPlayheadChapter(5)
    expect(useNovelUiStore.getState().playheadChapter).toBe(5)
  })
  it('clearProjectData 后重置为 1', () => {
    useNovelUiStore.getState().setPlayheadChapter(8)
    useNovelDataStore.getState().clearProjectData()
    expect(useNovelUiStore.getState().playheadChapter).toBe(1)
  })
})
