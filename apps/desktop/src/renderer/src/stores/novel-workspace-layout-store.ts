import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

// ── 工作台布局状态模型 ──
// Phase 1: 收口 novel-workspace.tsx 中散落的面板尺寸/显隐/模式状态，
// 统一持久化到 localStorage，为后续焦点布局、快捷键、专注模式提供基础。

// ── 类型定义 ──

/** 主工作区模式：写作（编辑器全宽）/ 矩阵（矩阵全宽）/ 分屏（上下分割） */
export type WorkspaceMainMode = 'writing' | 'matrix' | 'split'

/** 右侧面板显示状态 */
export type RightPanelVisibility = 'closed' | 'open'

/** 右侧面板当前视图 */
export type RightPanelView = 'conversation' | 'detail' | 'audit'

/** 信息密度偏好 */
export type DensityPreference = 'standard' | 'compact'

// ── 尺寸约束常量 ──

export const LAYOUT_CONSTRAINTS = {
  sidebar: { default: 220, min: 180, max: 360 },
  rightPanel: { default: 340, min: 280, max: 600 },
  contentEditor: { default: 300, min: 120, max: 800 },
  /** 分屏模式下编辑器占比（0-1），默认 40% 给编辑器，60% 给矩阵 */
  splitRatio: { default: 0.4, min: 0.2, max: 0.7 },
} as const

// ── Store 状态 ──

export interface NovelWorkspaceLayoutState {
  // ── 主工作区模式 ──
  mainMode: WorkspaceMainMode

  // ── 左侧栏 ──
  sidebarVisible: boolean
  sidebarWidth: number

  // ── 右侧面板 ──
  rightPanelVisible: RightPanelVisibility
  rightPanelDocked: boolean
  rightPanelWidth: number
  rightPanelView: RightPanelView

  // ── 分屏比例（编辑器占主区域的百分比，仅 split 模式有效）──
  splitRatio: number

  // ── 正文编辑器高度（px，仅 split 模式有效，兼容旧 key）──
  contentEditorHeight: number

  // ── 信息密度偏好 ──
  density: DensityPreference

  // ── 专注模式（不持久化）──
  focusMode: boolean

  // ── Actions ──
  setMainMode: (mode: WorkspaceMainMode) => void

  toggleSidebar: () => void
  setSidebarVisible: (visible: boolean) => void
  setSidebarWidth: (width: number) => void

  toggleRightPanel: () => void
  setRightPanelVisible: (visible: RightPanelVisibility) => void
  setRightPanelDocked: (docked: boolean) => void
  setRightPanelWidth: (width: number) => void
  setRightPanelView: (view: RightPanelView) => void

  setSplitRatio: (ratio: number) => void
  setContentEditorHeight: (height: number) => void

  setDensity: (density: DensityPreference) => void

  toggleFocusMode: () => void
  setFocusMode: (active: boolean) => void
}

// ── 辅助：clamp ──

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// ── 旧 localStorage key 迁移 ──

const LEGACY_CONTENT_SPLIT_KEY = 'wenlang-agent-content-split'

function migrateLegacyContentSplit(): number | undefined {
  try {
    const raw = localStorage.getItem(LEGACY_CONTENT_SPLIT_KEY)
    if (raw != null) {
      const value = Number(raw)
      if (!Number.isNaN(value) && value > 0) {
        // 迁移后删除旧 key，避免后续混淆
        localStorage.removeItem(LEGACY_CONTENT_SPLIT_KEY)
        return clamp(value, LAYOUT_CONSTRAINTS.contentEditor.min, LAYOUT_CONSTRAINTS.contentEditor.max)
      }
    }
  } catch {
    // localStorage 不可用时静默忽略
  }
  return undefined
}

// ── Store ──

export const useNovelWorkspaceLayoutStore = create<NovelWorkspaceLayoutState>()(
  persist(
    (set): NovelWorkspaceLayoutState => ({
      // ── 初始状态 ──
      mainMode: 'split',

      sidebarVisible: true,
      sidebarWidth: LAYOUT_CONSTRAINTS.sidebar.default,

      rightPanelVisible: 'open',
      rightPanelDocked: true,
      rightPanelWidth: LAYOUT_CONSTRAINTS.rightPanel.default,
      rightPanelView: 'conversation',

      splitRatio: LAYOUT_CONSTRAINTS.splitRatio.default,
      contentEditorHeight: LAYOUT_CONSTRAINTS.contentEditor.default,

      density: 'standard',

      focusMode: false,

      // ── Actions ──
      setMainMode: (mode) => set({ mainMode: mode }),

      toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
      setSidebarVisible: (visible) => set({ sidebarVisible: visible }),
      setSidebarWidth: (width) =>
        set({ sidebarWidth: clamp(width, LAYOUT_CONSTRAINTS.sidebar.min, LAYOUT_CONSTRAINTS.sidebar.max) }),

      toggleRightPanel: () =>
        set((s) => ({ rightPanelVisible: s.rightPanelVisible === 'closed' ? 'open' : 'closed' })),
      setRightPanelVisible: (visible) => set({ rightPanelVisible: visible }),
      setRightPanelDocked: (docked) => set({ rightPanelDocked: docked }),
      setRightPanelWidth: (width) =>
        set({ rightPanelWidth: clamp(width, LAYOUT_CONSTRAINTS.rightPanel.min, LAYOUT_CONSTRAINTS.rightPanel.max) }),
      setRightPanelView: (view) => set({ rightPanelView: view }),

      setSplitRatio: (ratio) =>
        set({ splitRatio: clamp(ratio, LAYOUT_CONSTRAINTS.splitRatio.min, LAYOUT_CONSTRAINTS.splitRatio.max) }),
      setContentEditorHeight: (height) =>
        set({ contentEditorHeight: clamp(height, LAYOUT_CONSTRAINTS.contentEditor.min, LAYOUT_CONSTRAINTS.contentEditor.max) }),

      setDensity: (density) => set({ density }),

      toggleFocusMode: () => set((s) => ({ focusMode: !s.focusMode })),
      setFocusMode: (active) => set({ focusMode: active }),
    }),
    {
      name: 'wenlang-agent-novel-workspace-layout',
      storage: createJSONStorage(() => localStorage),
      version: 1,
      // 只持久化布局偏好，不持久化 focusMode（临时状态）
      partialize: (state) => ({
        mainMode: state.mainMode,
        sidebarVisible: state.sidebarVisible,
        sidebarWidth: state.sidebarWidth,
        rightPanelVisible: state.rightPanelVisible,
        rightPanelDocked: state.rightPanelDocked,
        rightPanelWidth: state.rightPanelWidth,
        rightPanelView: state.rightPanelView,
        splitRatio: state.splitRatio,
        contentEditorHeight: state.contentEditorHeight,
        density: state.density,
      }),
      // 自定义 merge：兼容旧版本 localStorage 缺少新字段的情况
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<NovelWorkspaceLayoutState>

        // 迁移旧 content-split key（仅首次，迁移后旧 key 被删除）
        const legacyHeight = migrateLegacyContentSplit()

        return {
          ...current,
          ...p,
          // 确保新字段有默认值（旧 payload 不含这些 key）
          mainMode: p.mainMode ?? current.mainMode,
          sidebarVisible: p.sidebarVisible ?? current.sidebarVisible,
          sidebarWidth: p.sidebarWidth ?? current.sidebarWidth,
          rightPanelVisible: p.rightPanelVisible ?? current.rightPanelVisible,
          rightPanelDocked: p.rightPanelDocked ?? current.rightPanelDocked,
          rightPanelWidth: p.rightPanelWidth ?? current.rightPanelWidth,
          rightPanelView: p.rightPanelView ?? current.rightPanelView,
          splitRatio: p.splitRatio ?? current.splitRatio,
          contentEditorHeight: legacyHeight ?? p.contentEditorHeight ?? current.contentEditorHeight,
          density: p.density ?? current.density,
          // focusMode 永远不持久化
          focusMode: false,
        }
      },
    },
  ),
)
