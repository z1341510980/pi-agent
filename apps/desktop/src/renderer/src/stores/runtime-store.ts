import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { AgentRuntimeType, RuntimeSelection } from '@/types/runtime'

interface RuntimeStoreState extends RuntimeSelection {
  setRuntime: (type: AgentRuntimeType) => void
  setModel: (modelId: string) => void
  setTeam: (teamId: string) => void
  reset: () => void
}

export const useRuntimeStore = create<RuntimeStoreState>()(
  persist(
    (set) => ({
      runtime: 'chat-api',
      modelId: undefined,
      teamId: undefined,
      setRuntime: (type) => set({ runtime: type, modelId: undefined, teamId: undefined }),
      setModel: (modelId) => set({ modelId }),
      setTeam: (teamId) => set({ teamId }),
      reset: () => set({ runtime: 'chat-api', modelId: undefined, teamId: undefined }),
    }),
    {
      name: 'wenlang-agent.runtime-selection',
      storage: createJSONStorage(() => localStorage),
    },
  ),
)
