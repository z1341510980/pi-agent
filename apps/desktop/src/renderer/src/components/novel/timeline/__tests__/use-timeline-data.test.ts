import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useTimelineData } from '../use-timeline-data'
import type { NovelCharacterHistory, NovelCharacter } from '@/api/novel-client'

function mkChar(id: string): NovelCharacter {
  return {
    id, projectId: 'p', name: id, description: '', identity: '', personality: '',
    appearance: '', currentState: '', currentGoal: '', currentPressure: '', secret: '',
    arcStage: '', arcHistory: '', speechStyle: '', isProtagonist: false, createdAt: 0, updatedAt: 0,
  }
}
function mkHist(charId: string, ch: number): NovelCharacterHistory {
  return { id: `h-${charId}-${ch}`, projectId: 'p', characterId: charId, chapterId: null, chapterNumber: ch, fieldName: 'currentState', oldValue: null, newValue: '', reason: '', createdAt: 0 }
}

describe('useTimelineData character contiguous spans (A1)', () => {
  it('produces two clips when character history has a gap', () => {
    const { result } = renderHook(() =>
      useTimelineData({
        characters: [mkChar('c1')],
        chapters: [],
        conflicts: [], foreshadows: [], factions: [], locations: [], worldElements: [],
        characterHistory: [mkHist('c1', 1), mkHist('c1', 2), mkHist('c1', 3), mkHist('c1', 8), mkHist('c1', 9)],
      }),
    )
    const charTracks = result.current.tracks.filter((t) => t.kind === 'character' && t.clips.length > 0)
    const c1Clips = charTracks.find((t) => t.id === 'character:c1')!.clips
    expect(c1Clips.length).toBe(2)
    expect(c1Clips[0].startChapter).toBe(1)
    expect(c1Clips[0].endChapter).toBe(3)
    expect(c1Clips[1].startChapter).toBe(8)
    expect(c1Clips[1].endChapter).toBe(9)
  })
})
