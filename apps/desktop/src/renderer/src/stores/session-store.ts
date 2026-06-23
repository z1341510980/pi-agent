import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { SessionSummary } from '@/components/chat/session-list'
import type { MessageStreamState } from '@/components/chat/message-stream'

// ── 类型定义 ──

export interface SelectedModel {
  provider: string
  modelId: string
}

interface SessionState {
  // ── 会话数据 ──
  sessions: SessionSummary[]
  activeThreadId: string
  sessionMessages: Record<string, MessageStreamState>
  drafts: Record<string, string>
  selectedModel: SelectedModel | null
  compactionCount: number
  /** 当前活跃 Agent ID */
  activeAgentId: string

  // ── Actions ──
  setSessions: (sessions: SessionSummary[]) => void
  upsertSession: (session: SessionSummary) => void
  removeSession: (threadId: string) => void
  setActiveThreadId: (threadId: string) => void
  getSessionMessages: (threadId: string) => MessageStreamState | undefined
  setSessionMessages: (threadId: string, state: MessageStreamState) => void
  updateSessionMessages: (threadId: string, updater: (prev: MessageStreamState) => MessageStreamState) => void
  getDraft: (threadId: string) => string
  setDraft: (threadId: string, draft: string) => void
  setSelectedModel: (model: SelectedModel | null) => void
  incrementCompactionCount: () => void
  setActiveAgentId: (id: string) => void
  clearAll: () => void
}

// ── Store ──

const emptyMessageState: MessageStreamState = {
  messages: [],
  activeRunId: null,
  streamError: null,
}

/** 创建空的消息流状态 */
export function createEmptyMessageState(): MessageStreamState {
  return { ...emptyMessageState }
}

/** 默认会话列表（首次启动时使用） */
export function createDefaultSessions(): SessionSummary[] {
  const now = Date.now()
  return [
    {
      id: 'desktop-main',
      title: '新会话',
      preview: '准备连接 Pi Agent',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'sdk-integration',
      title: 'SDK 集成验证',
      preview: 'P0-P4 基线已就绪',
      createdAt: now - 86_400_000,
      updatedAt: now - 86_400_000,
    },
  ]
}

/** 发送消息后更新会话列表的预览/标题 */
export function upsertSessionAfterSend(
  sessions: SessionSummary[],
  sessionId: string,
  text: string,
): SessionSummary[] {
  const title = text.length > 24 ? `${text.slice(0, 24)}...` : text
  const preview = text.length > 42 ? `${text.slice(0, 42)}...` : text
  const existing = sessions.find((session) => session.id === sessionId)
  const nowTs = Date.now()

  if (!existing) {
    return [
      {
        id: sessionId,
        title,
        preview,
        createdAt: nowTs,
        updatedAt: nowTs,
      },
      ...sessions,
    ]
  }

  return sessions.map((session) =>
    session.id === sessionId
      ? {
          ...session,
          title: session.title === '新会话' ? title : session.title,
          preview,
          updatedAt: nowTs,
        }
      : session,
  )
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      // ── 初始状态 ──
      sessions: createDefaultSessions(),
      activeThreadId: 'desktop-main',
      sessionMessages: {},
      drafts: {},
      selectedModel: null,
      compactionCount: 0,
      activeAgentId: 'default',

      // ── Actions ──
      setSessions: (sessions) => set({ sessions }),

      upsertSession: (session) =>
        set((state) => {
          const idx = state.sessions.findIndex((s) => s.id === session.id)
          if (idx >= 0) {
            const newSessions = [...state.sessions]
            newSessions[idx] = session
            return { sessions: newSessions }
          }
          return { sessions: [session, ...state.sessions] }
        }),

      removeSession: (threadId) =>
        set((state) => ({
          sessions: state.sessions.filter((s) => s.id !== threadId),
          sessionMessages: Object.fromEntries(
            Object.entries(state.sessionMessages).filter(([k]) => k !== threadId),
          ),
          drafts: Object.fromEntries(
            Object.entries(state.drafts).filter(([k]) => k !== threadId),
          ),
        })),

      setActiveThreadId: (threadId) => set({ activeThreadId: threadId }),

      getSessionMessages: (threadId) => get().sessionMessages[threadId],

      setSessionMessages: (threadId, messageState) =>
        set((state) => ({
          sessionMessages: { ...state.sessionMessages, [threadId]: messageState },
        })),

      updateSessionMessages: (threadId, updater) =>
        set((state) => ({
          sessionMessages: {
            ...state.sessionMessages,
            [threadId]: updater(state.sessionMessages[threadId] ?? emptyMessageState),
          },
        })),

      getDraft: (threadId) => get().drafts[threadId] ?? '',

      setDraft: (threadId, draft) =>
        set((state) => ({
          drafts: { ...state.drafts, [threadId]: draft },
        })),

      setSelectedModel: (model) => set({ selectedModel: model }),

      setActiveAgentId: (id) => set({ activeAgentId: id }),

      incrementCompactionCount: () =>
        set((state) => ({ compactionCount: state.compactionCount + 1 })),

      clearAll: () =>
        set({
          sessions: [],
          sessionMessages: {},
          drafts: {},
          compactionCount: 0,
        }),
    }),
    {
      name: 'pi-agent-session',
      storage: createJSONStorage(() => localStorage),
      // 只持久化数据字段，不持久化 actions
      partialize: (state) => ({
        sessions: state.sessions,
        activeThreadId: state.activeThreadId,
        sessionMessages: state.sessionMessages,
        drafts: state.drafts,
        selectedModel: state.selectedModel,
        compactionCount: state.compactionCount,
        activeAgentId: state.activeAgentId,
      }),
    },
  ),
)
