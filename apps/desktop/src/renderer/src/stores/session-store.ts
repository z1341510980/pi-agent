import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { SessionSummary } from '@/components/chat/session-list'
import type { MessageStreamState } from '@/components/chat/message-stream'
import type { FileAttachment } from '@/components/chat/types'

// ── 类型定义 ──

export interface SelectedModel {
  provider: string
  modelId: string
}

/**
 * 排队待发的消息。
 *
 * Agent 忙的时候用户想到的后续指令不该被丢弃，也不该逼他们等着。
 * 排队项在当前轮结束后自动出队发送。
 */
export interface QueuedCommand {
  id: string
  text: string
  /** 附件只存在内存里，不参与持久化（见 partialize 说明） */
  attachments?: FileAttachment[]
  createdAt: number
}

/** 队列长度上限：再多就不是"顺手补一句"而是失控了 */
export const MAX_QUEUE_LENGTH = 20
/** 单条排队消息的字符上限 */
export const MAX_QUEUE_ITEM_CHARS = 20_000

export type EnqueueResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'empty' | 'queue-full' | 'too-long' }

interface SessionState {
  // ── 会话数据 ──
  sessions: SessionSummary[]
  activeThreadId: string
  sessionMessages: Record<string, MessageStreamState>
  drafts: Record<string, string>
  /** 每个会话的待发队列 */
  commandQueues: Record<string, QueuedCommand[]>
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
  /** 入队；超出上限时返回失败原因，由 UI 决定怎么提示 */
  enqueueCommand: (
    threadId: string,
    text: string,
    attachments?: FileAttachment[],
  ) => EnqueueResult
  /** 取出队首并从队列移除；队列为空返回 undefined */
  shiftCommand: (threadId: string) => QueuedCommand | undefined
  removeCommand: (threadId: string, id: string) => void
  updateCommandText: (threadId: string, id: string, text: string) => void
  /** 按给定 id 顺序重排（不在列表里的 id 会被忽略） */
  reorderQueue: (threadId: string, ids: string[]) => void
  clearQueue: (threadId: string) => void
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

// ── 持久化版本迁移 ──

/** 当前持久化版本；0 是那个曾经把 sessionMessages 写进 localStorage 的隐式版本 */
export const SESSION_STORE_PERSIST_VERSION = 1

/**
 * 持久化 payload 迁移。导出仅为可测 —— 这条路径只在版本升级那一次跑，
 * 写错的代价是用户的会话列表/草稿被静默清空，手工验证成本很高。
 *
 * ## v0 → v1：丢弃 sessionMessages
 *
 * v0 的 `partialize` 里有 `sessionMessages`，而当时的 `ChatMessage` 是旧模型
 * （旁挂 `toolCalls` + `thinking`，**没有 `segments`**）。`segments` 是后来的
 * 有序分段重构引入的。现在的 partialize 已经不再写 sessionMessages，但
 * **partialize 只管写、不管读** —— rehydrate 仍会把旧快照里的 sessionMessages
 * merge 回 state，于是 `collectToolCalls` 在 ChatWorkspace 首次 useMemo 时就
 * 撞上 `undefined` 并整页白屏。必须在这里从源头剔除。
 *
 * 顺带解释为什么必须显式提供 migrate 而不是只加 version：zustand persist 在版本号
 * 不一致且没有 migrate 时会直接丢弃**整份** persisted state（并打印 console.error），
 * 那会连带清掉 sessions / drafts / selectedModel。这里只删一个 key、原样保留其余字段。
 */
export function migrateSessionPersisted(persisted: unknown, version: number): unknown {
  if (version >= SESSION_STORE_PERSIST_VERSION) return persisted
  if (persisted == null || typeof persisted !== 'object') return persisted
  const next: Record<string, unknown> = { ...(persisted as Record<string, unknown>) }
  // delete 而不是置空对象：留着空对象会被 merge 的 `...persisted` 覆盖掉
  // 初始状态，语义上没差别，但多一个永远为空的持久化字段没有意义
  delete next.sessionMessages
  return next
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      // ── 初始状态 ──
      sessions: createDefaultSessions(),
      activeThreadId: 'desktop-main',
      sessionMessages: {},
      drafts: {},
      commandQueues: {},
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
          commandQueues: Object.fromEntries(
            Object.entries(state.commandQueues).filter(([k]) => k !== threadId),
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

      // ── 待发队列 ──

      enqueueCommand: (threadId, text, attachments) => {
        const trimmed = text.trim()
        if (!trimmed && (!attachments || attachments.length === 0)) {
          return { ok: false, reason: 'empty' }
        }
        if (trimmed.length > MAX_QUEUE_ITEM_CHARS) {
          return { ok: false, reason: 'too-long' }
        }
        const queue = get().commandQueues[threadId] ?? []
        if (queue.length >= MAX_QUEUE_LENGTH) {
          return { ok: false, reason: 'queue-full' }
        }
        const item: QueuedCommand = {
          id: crypto.randomUUID(),
          text: trimmed,
          attachments: attachments && attachments.length > 0 ? attachments : undefined,
          createdAt: Date.now(),
        }
        set((state) => ({
          commandQueues: {
            ...state.commandQueues,
            [threadId]: [...(state.commandQueues[threadId] ?? []), item],
          },
        }))
        return { ok: true, id: item.id }
      },

      shiftCommand: (threadId) => {
        const queue = get().commandQueues[threadId] ?? []
        const [head, ...rest] = queue
        if (!head) return undefined
        set((state) => ({
          commandQueues: { ...state.commandQueues, [threadId]: rest },
        }))
        return head
      },

      removeCommand: (threadId, id) =>
        set((state) => ({
          commandQueues: {
            ...state.commandQueues,
            [threadId]: (state.commandQueues[threadId] ?? []).filter((c) => c.id !== id),
          },
        })),

      updateCommandText: (threadId, id, text) =>
        set((state) => ({
          commandQueues: {
            ...state.commandQueues,
            [threadId]: (state.commandQueues[threadId] ?? []).map((c) =>
              c.id === id ? { ...c, text } : c,
            ),
          },
        })),

      reorderQueue: (threadId, ids) =>
        set((state) => {
          const queue = state.commandQueues[threadId] ?? []
          const byId = new Map(queue.map((c) => [c.id, c]))
          const reordered = ids
            .map((id) => byId.get(id))
            .filter((c): c is QueuedCommand => c !== undefined)
          // 没被列出的项追加到尾部，避免重排请求不完整时丢数据
          const listed = new Set(ids)
          const leftovers = queue.filter((c) => !listed.has(c.id))
          return {
            commandQueues: {
              ...state.commandQueues,
              [threadId]: [...reordered, ...leftovers],
            },
          }
        }),

      clearQueue: (threadId) =>
        set((state) => ({
          commandQueues: { ...state.commandQueues, [threadId]: [] },
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
          commandQueues: {},
          compactionCount: 0,
        }),
    }),
    {
      name: 'wenlang-agent-session',
      storage: createJSONStorage(() => localStorage),
      version: SESSION_STORE_PERSIST_VERSION,
      migrate: migrateSessionPersisted,
      // 只持久化数据字段，不持久化 actions
      partialize: (state) => ({
        sessions: state.sessions,
        activeThreadId: state.activeThreadId,
        /**
         * `sessionMessages` **刻意不持久化**。
         *
         * 历史消息的权威来源是后端 JSONL（`GET /api/sessions/:threadId/messages`）。
         * 本地消息的 id 是 `crypto.randomUUID()`，历史消息的 id 是 pi-agent-core 的
         * entry id（如 `5665a76e`）—— 两个 id 空间**永不相交**，而
         * `chat-workspace` 的 `mergedMessages` 只按 id 去重。所以一旦两边都有内容，
         * 同一段对话会显示两遍。
         *
         * 另外两个理由：
         * - 消息里可能带附件 base64，localStorage 有配额上限；小说侧已经因为把章节
         *   正文塞进 persist 而踩过 QuotaExceededError（写入失败会让**整个 store**
         *   的持久化静默失效，见 novel-data-store 的注释）
         * - `streamError` / `activeRunId` 属于运行时状态，持久化后会让上次的错误
         *   在重启后复活
         *
         * 代价：后端不可达时聊天区看起来是空的。可接受 —— 那种状态下也发不出消息，
         * 而草稿（drafts）仍然保留。
         */
        drafts: state.drafts,
        // 队列持久化，但**剥掉附件**：附件内容是 base64，几百 KB 起步，
        // 塞进 localStorage 会顶到配额上限并让整个 store 写入失败。
        // 代价是重载后排队项保留文字、需要重新添加附件 —— 比丢掉整条指令好。
        commandQueues: Object.fromEntries(
          Object.entries(state.commandQueues).map(([threadId, queue]) => [
            threadId,
            queue.map(({ id, text, createdAt }) => ({ id, text, createdAt })),
          ]),
        ),
        selectedModel: state.selectedModel,
        compactionCount: state.compactionCount,
        activeAgentId: state.activeAgentId,
      }),
    },
  ),
)
