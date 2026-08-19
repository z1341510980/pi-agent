import { create } from 'zustand'

/**
 * 时间线重建的对话流可见化状态。
 *
 * TimelineRebuildControl 是唯一写入方（轮询 job 时同步），
 * novel-conversation-panel 读取并渲染为对话中的系统消息，
 * 让重建过程不再是只有顶栏按钮可见的黑盒。
 */
export type TimelineRebuildPhase =
  | 'idle' // 无失效、无任务
  | 'invalidated' // 已检测到失效，等待用户启动重建
  | 'analyzing' // 隔离分析进行中
  | 'awaiting_apply' // 分析完成，等待用户应用
  | 'applying' // 逐章应用进行中
  | 'completed' // 全部应用完成，闸门解除
  | 'failed' // 启动/分析/应用失败

export interface TimelineRebuildStatus {
  phase: TimelineRebuildPhase
  /** 失效/重建起始章号 */
  startChapterNumber: number | null
  /** 重建范围章节数 */
  total: number
  /** 已完成章节数（分析或应用，按阶段解释） */
  completed: number
  error: string | null
  /** 状态刷新时间，作为对话消息的排序 timestamp */
  updatedAt: number
}

interface TimelineRebuildActionsSlot {
  /** 启动/重试重建（含确认弹框） */
  start?: () => void
  /** 应用全部待应用章节并完成任务 */
  applyAll?: () => void
}

interface TimelineRebuildStoreState {
  status: TimelineRebuildStatus
  /** 由 TimelineRebuildControl 挂载时注册；对话消息按钮点击时调用 */
  actions: TimelineRebuildActionsSlot
  patchStatus: (patch: Partial<Omit<TimelineRebuildStatus, 'updatedAt'>>) => void
  registerActions: (actions: TimelineRebuildActionsSlot) => () => void
}

const INITIAL_STATUS: TimelineRebuildStatus = {
  phase: 'idle',
  startChapterNumber: null,
  total: 0,
  completed: 0,
  error: null,
  updatedAt: 0,
}

export const useTimelineRebuildStore = create<TimelineRebuildStoreState>((set) => ({
  status: INITIAL_STATUS,
  actions: {},
  patchStatus: (patch) => {
    set((state) => ({
      status: {
        ...state.status,
        ...patch,
        updatedAt: Date.now(),
      },
    }))
  },
  registerActions: (actions) => {
    set({ actions })
    return () => set({ actions: {} })
  },
}))
