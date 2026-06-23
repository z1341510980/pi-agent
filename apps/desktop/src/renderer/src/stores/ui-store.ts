import { create } from 'zustand'

// ── 类型定义 ──

export type RightPanelType = 'context' | 'files' | 'memory'

interface UIState {
  // ── 面板状态 ──
  rightPanel: RightPanelType
  devLogOpen: boolean
  commandPaletteOpen: boolean
  /** 左栏（会话列表）是否展开 */
  leftPanelOpen: boolean
  /** 右栏（上下文/记忆/用量）是否展开 */
  rightPanelOpen: boolean

  // ── Actions ──
  setRightPanel: (panel: RightPanelType) => void
  setDevLogOpen: (open: boolean) => void
  toggleDevLog: () => void
  setCommandPaletteOpen: (open: boolean) => void
  toggleCommandPalette: () => void
  setLeftPanelOpen: (open: boolean) => void
  toggleLeftPanel: () => void
  setRightPanelOpen: (open: boolean) => void
  toggleRightPanel: () => void
}

export const useUIStore = create<UIState>()((set) => ({
  rightPanel: 'context',
  devLogOpen: false,
  commandPaletteOpen: false,
  leftPanelOpen: true,
  rightPanelOpen: true,

  setRightPanel: (panel) => set({ rightPanel: panel }),
  setDevLogOpen: (open) => set({ devLogOpen: open }),
  toggleDevLog: () => set((state) => ({ devLogOpen: !state.devLogOpen })),
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  toggleCommandPalette: () =>
    set((state) => ({ commandPaletteOpen: !state.commandPaletteOpen })),
  setLeftPanelOpen: (open) => set({ leftPanelOpen: open }),
  toggleLeftPanel: () => set((state) => ({ leftPanelOpen: !state.leftPanelOpen })),
  setRightPanelOpen: (open) => set({ rightPanelOpen: open }),
  toggleRightPanel: () => set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),
}))
