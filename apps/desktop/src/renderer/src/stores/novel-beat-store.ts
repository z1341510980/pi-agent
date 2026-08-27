import { create } from 'zustand'
import type { NovelBeatPlan } from '@/api/novel-client'

/**
 * 节拍表专用共享 store（单一数据源）。
 *
 * 大纲树章节行（OutlineTree/ChapterRow）、侧栏节拍表分组（BeatPlanGroup）
 * 与创作面板横幅都从这里读节拍，避免多份本地 state 漂移。
 * 不持久化：节拍是规划数据，权威源在后端，进入项目时由 useBeatPlansLoader 拉取。
 */
export interface NovelBeatState {
  /** 当前已加载节拍所属项目；null 表示尚未加载任何项目 */
  loadedProjectId: string | null
  beats: NovelBeatPlan[]
  setBeats: (projectId: string, beats: NovelBeatPlan[]) => void
  upsertBeat: (beat: NovelBeatPlan) => void
  removeBeat: (id: string) => void
  clear: () => void
}

export const useNovelBeatStore = create<NovelBeatState>()((set) => ({
  loadedProjectId: null,
  beats: [],
  setBeats: (projectId, beats) => set({ loadedProjectId: projectId, beats }),
  upsertBeat: (beat) =>
    set((state) => ({
      beats: state.beats.some((item) => item.id === beat.id)
        ? state.beats.map((item) => (item.id === beat.id ? beat : item))
        : [...state.beats, beat],
    })),
  removeBeat: (id) => set((state) => ({ beats: state.beats.filter((item) => item.id !== id) })),
  clear: () => set({ loadedProjectId: null, beats: [] })
}))
