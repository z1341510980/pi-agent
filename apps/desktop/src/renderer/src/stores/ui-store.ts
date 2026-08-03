import { create } from 'zustand'

// ── 类型定义 ──

export type RightPanelType = 'context' | 'files' | 'memory' | 'preview'

export interface FilePreviewState {
  name: string
  content?: string
  encoding?: string
  mimeType?: string
  thumbnail?: string
  size: number
  type: 'image' | 'file'
  /** 打开后要定位并高亮的行号（来自助手输出里的 `path:42` 引用） */
  highlightLine?: number
  /** 高亮区间的结束行（`#L10-L20` 形式） */
  highlightEndLine?: number
}

interface UIState {
  // ── 面板状态 ──
  rightPanel: RightPanelType
  devLogOpen: boolean
  commandPaletteOpen: boolean
  /** 左栏（会话列表）是否展开 */
  leftPanelOpen: boolean
  /** 右栏（上下文/记忆/用量）是否展开 */
  rightPanelOpen: boolean
  /** 文件预览状态 */
  filePreview: FilePreviewState | null

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
  openFilePreview: (file: FilePreviewState) => void
  closeFilePreview: () => void
}

export const useUIStore = create<UIState>()((set) => ({
  rightPanel: 'context',
  devLogOpen: false,
  commandPaletteOpen: false,
  leftPanelOpen: true,
  rightPanelOpen: true,
  filePreview: null,

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
  openFilePreview: (file) => set({ filePreview: file, rightPanel: 'preview', rightPanelOpen: true }),
  closeFilePreview: () => set({ filePreview: null, rightPanel: 'context' }),
}))
