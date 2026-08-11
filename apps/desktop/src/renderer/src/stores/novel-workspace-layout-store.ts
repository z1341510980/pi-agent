import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { readLegacyViewMode } from './novel-legacy-view-mode'

// ── 工作台布局状态模型 ──
// Phase 1: 收口 novel-workspace.tsx 中散落的面板尺寸/显隐/模式状态，
// 统一持久化到 localStorage，为后续焦点布局、快捷键、专注模式提供基础。
//
// 注意：信息密度切换（标准 / 紧凑模式）尚未实现。此前这里存在一个 density 字段，
// 但没有任何组件读取它，已于 version 2 删除。将来要做密度切换时，
// 应连同消费方（样式 token / 组件间距）一起加，而不是只留一个没人读的状态。
// 同理，splitRatio（分屏比例）与 rightPanelDocked（右侧面板停靠）也因零消费一并删除。

// ── 类型定义 ──

/**
 * 主工作区布局：四个互斥选项。
 *
 * 取代此前的 `mainMode`（writing/matrix/split）× `viewMode`（matrix/canvas）两个
 * 独立持久化状态。旧模型的 6 种组合里有 2 种自相矛盾：
 *   - (split, canvas)  —— 选了分屏，正文编辑器却整个消失（canvas 分支优先级更高）
 *   - (writing, canvas) —— 选了画布却看到编辑器，画布在写作模式下根本到不了
 * 且视图开关只在 canvas 时渲染，一旦切到矩阵，开关自己从界面消失。
 * 合并成单一维度后，"能看到什么"与"选了什么"一一对应。
 */
export type WorkspaceLayoutMode =
  /** 正文：编辑器全宽 */
  | 'text'
  /** 正文 + 时间线：上下分屏 */
  | 'text-timeline'
  /** 时间线：章节 × 实体矩阵全宽 */
  | 'timeline'
  /** 关系图：实体关系画布全宽 */
  | 'graph'

/** 右侧面板显示状态 */
export type RightPanelVisibility = 'closed' | 'open'

/** 右侧面板当前视图（按"做什么"划分，职责单一） */
export type RightPanelView = 'conversation' | 'chat' | 'detail' | 'settings' | 'audit'
// - conversation：创作流程（工作流/群聊/反推/编排 4 模式 + 进度/检查点）
// - chat：章节自由对话（@ Agent/角色 问答）
// - detail：矩阵实体查看/编辑（12 类）+ 实体时间线
// - settings：项目级配置（标题/大纲/创作主模型/节奏模型/目标平台）
// - audit：一致性诊断（伏笔回收/钩子悬挂/孤儿实体/时间线矛盾）

// ── 尺寸约束常量 ──

export const LAYOUT_CONSTRAINTS = {
  sidebar: { default: 220, min: 180, max: 360 },
  rightPanel: { default: 340, min: 280, max: 600 },
  contentEditor: { default: 300, min: 120, max: 800 },
} as const

// ── Store 状态 ──

export interface NovelWorkspaceLayoutState {
  // ── 主工作区布局 ──
  layoutMode: WorkspaceLayoutMode

  // ── 左侧栏 ──
  sidebarVisible: boolean
  sidebarWidth: number

  // ── 右侧面板 ──
  rightPanelVisible: RightPanelVisibility
  rightPanelWidth: number
  rightPanelView: RightPanelView

  // ── 正文编辑器高度（px，仅 text-timeline 分屏有效，兼容旧 key）──
  contentEditorHeight: number

  // ── 专注模式（不持久化）──
  focusMode: boolean

  // ── Actions ──
  setLayoutMode: (mode: WorkspaceLayoutMode) => void

  toggleSidebar: () => void
  setSidebarVisible: (visible: boolean) => void
  setSidebarWidth: (width: number) => void

  toggleRightPanel: () => void
  setRightPanelVisible: (visible: RightPanelVisibility) => void
  setRightPanelWidth: (width: number) => void
  setRightPanelView: (view: RightPanelView) => void

  setContentEditorHeight: (height: number) => void

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

// ── 持久化版本迁移 ──
//
// version 1 → 2：删除零消费字段 splitRatio / density / rightPanelDocked。
// version 2 → 3：mainMode + ui-store 的 viewMode 合并为 layoutMode。
//
// 必须显式提供 migrate：zustand persist 在版本号不一致且没有 migrate 时会
// 直接丢弃整份 persisted state（并打印 console.error），
// 那会连带清掉用户已有的 sidebarWidth / rightPanelWidth 等偏好。
// 这里只剔除废弃 key、原样保留其余字段，老用户的 localStorage 不会残留字段，
// 也不会因为多余 key 被 merge 的 `...p` 重新灌回 state。
const DROPPED_KEYS_V2 = ['splitRatio', 'density', 'rightPanelDocked'] as const

/** ui-store 的 viewMode 已废弃，但 v3 迁移仍需它还原"上次看到的是哪个视图" */

/**
 * 旧 (mainMode, viewMode) → layoutMode。
 *
 * 按"上次屏幕上实际显示的东西"映射，而不是按字面语义，因此
 * (split, canvas) 映射到 graph —— 那种组合下正文编辑器本来就不显示。
 */
function deriveLayoutMode(mainMode: unknown, viewMode: 'matrix' | 'canvas'): WorkspaceLayoutMode {
  // writing 下 canvas 分支被 `mainMode !== 'writing'` 挡住，画布到不了
  if (mainMode === 'writing') return 'text'
  if (viewMode === 'canvas') return 'graph'
  if (mainMode === 'matrix') return 'timeline'
  return 'text-timeline'
}


/**
 * 持久化 payload 迁移。导出仅为可测 —— 迁移写错的代价是用户布局偏好被静默丢弃，
 * 而这条路径只在版本升级那一次执行，手工验证成本很高。
 */
export function migrateWorkspaceLayoutPersisted(persisted: unknown, version: number): unknown {
  if (version >= 3 || persisted == null || typeof persisted !== 'object') return persisted
  const next: Record<string, unknown> = { ...(persisted as Record<string, unknown>) }

  if (version < 2) {
    for (const key of DROPPED_KEYS_V2) {
      delete next[key]
    }
  }

  // v2 → v3：合并两个模式维度。mainMode 缺失（更早的 payload）时也走一遍，
  // deriveLayoutMode 会落到 text-timeline，与旧的 mainMode 默认值 'split' 一致。
  if (!('layoutMode' in next)) {
    next.layoutMode = deriveLayoutMode(next.mainMode, readLegacyViewMode())
  }
  delete next.mainMode

  return next
}


// ── Store ──

export const useNovelWorkspaceLayoutStore = create<NovelWorkspaceLayoutState>()(
  persist(
    (set): NovelWorkspaceLayoutState => ({
      // ── 初始状态 ──
      layoutMode: 'text-timeline',

      sidebarVisible: true,
      sidebarWidth: LAYOUT_CONSTRAINTS.sidebar.default,

      rightPanelVisible: 'open',
      rightPanelWidth: LAYOUT_CONSTRAINTS.rightPanel.default,
      rightPanelView: 'conversation',

      contentEditorHeight: LAYOUT_CONSTRAINTS.contentEditor.default,

      focusMode: false,

      // ── Actions ──
      setLayoutMode: (mode) => set({ layoutMode: mode }),

      toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
      setSidebarVisible: (visible) => set({ sidebarVisible: visible }),
      setSidebarWidth: (width) =>
        set({ sidebarWidth: clamp(width, LAYOUT_CONSTRAINTS.sidebar.min, LAYOUT_CONSTRAINTS.sidebar.max) }),

      toggleRightPanel: () =>
        set((s) => ({ rightPanelVisible: s.rightPanelVisible === 'closed' ? 'open' : 'closed' })),
      setRightPanelVisible: (visible) => set({ rightPanelVisible: visible }),
      setRightPanelWidth: (width) =>
        set({ rightPanelWidth: clamp(width, LAYOUT_CONSTRAINTS.rightPanel.min, LAYOUT_CONSTRAINTS.rightPanel.max) }),
      setRightPanelView: (view) => set({ rightPanelView: view }),

      setContentEditorHeight: (height) =>
        set({ contentEditorHeight: clamp(height, LAYOUT_CONSTRAINTS.contentEditor.min, LAYOUT_CONSTRAINTS.contentEditor.max) }),

      toggleFocusMode: () => set((s) => ({ focusMode: !s.focusMode })),
      setFocusMode: (active) => set({ focusMode: active }),
    }),
    {
      name: 'wenlang-agent-novel-workspace-layout',
      storage: createJSONStorage(() => localStorage),
      version: 3,
      migrate: migrateWorkspaceLayoutPersisted,
      // 只持久化布局偏好，不持久化 focusMode（临时状态）
      partialize: (state) => ({
        layoutMode: state.layoutMode,
        sidebarVisible: state.sidebarVisible,
        sidebarWidth: state.sidebarWidth,
        rightPanelVisible: state.rightPanelVisible,
        rightPanelWidth: state.rightPanelWidth,
        rightPanelView: state.rightPanelView,
        contentEditorHeight: state.contentEditorHeight,
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
          layoutMode: p.layoutMode ?? current.layoutMode,
          sidebarVisible: p.sidebarVisible ?? current.sidebarVisible,
          sidebarWidth: p.sidebarWidth ?? current.sidebarWidth,
          rightPanelVisible: p.rightPanelVisible ?? current.rightPanelVisible,
          rightPanelWidth: p.rightPanelWidth ?? current.rightPanelWidth,
          rightPanelView: p.rightPanelView ?? current.rightPanelView,
          contentEditorHeight: legacyHeight ?? p.contentEditorHeight ?? current.contentEditorHeight,
          // focusMode 永远不持久化
          focusMode: false,
        }
      },
    },
  ),
)
