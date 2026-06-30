import { describe, it, expect, beforeEach } from 'vitest'
import { useNovelStore } from '@/stores/novel-store'

describe('novel-store playheadChapter', () => {
  beforeEach(() => {
    useNovelStore.getState().clearProjectData()
  })

  it('初始值为 1', () => {
    expect(useNovelStore.getState().playheadChapter).toBe(1)
  })
  it('setPlayheadChapter 更新值', () => {
    useNovelStore.getState().setPlayheadChapter(5)
    expect(useNovelStore.getState().playheadChapter).toBe(5)
  })
  it('clearProjectData 后重置为 1', () => {
    useNovelStore.getState().setPlayheadChapter(8)
    useNovelStore.getState().clearProjectData()
    expect(useNovelStore.getState().playheadChapter).toBe(1)
  })
})
