/**
 * ChatPanel：章节自由对话视图（从 NovelConversationPanel 拆出）
 *
 * 职责单一：仅承载章节自由对话（@ Agent/角色问答）。
 * 创作流程（工作流/群聊/反推/编排）走 ConversationPanel；
 * 本面板不再承担"创作模式选择/进度/检查点/质量门"。
 *
 * 自由对话支持按 Provider+Model 选择本次模型，并随 POST /chat 透传。
 */
import { useMemo, useState, type ReactElement } from 'react'
import { AlertCircle } from 'lucide-react'
import {
  ConversationStream,
  ConversationInput,
  ConversationEmptyState,
  type ConversationMessage,
  type MentionOption
} from '@/components/shared/conversation'
import type { ChatAgentOutput } from '@/hooks/use-chapter-chat'
import { type ChapterChatMessage } from '@/api/novel-client'
import { ModelPicker, type ModelRef } from './model-picker'

export interface ChatPanelProps {
  /** 持久化聊天历史（用户/Agent 已完成消息） */
  chapterChatMessages?: ChapterChatMessage[]
  /** 流式 Agent 输出（正在生成中的内容） */
  chapterChatAgentOutputs?: ChatAgentOutput[]
  /** 聊天是否正在运行 */
  chapterChatRunning: boolean
  /** 聊天错误信息（红条提示） */
  chapterChatError: string | null
  /** 发送消息回调（可 @ Agent/角色，可带 per-call 模型） */
  onSendChapterChat: (message: string, mentionedAgents?: string[], modelId?: ModelRef | null) => void
  /** 中止当前流式回复 */
  onAbortChapterChat?: () => void
  /** @ 提及候选（Agent + 角色） */
  chatMentionOptions?: MentionOption[]
}


export function ChatPanel({
  chapterChatMessages,
  chapterChatAgentOutputs,
  chapterChatRunning,
  chapterChatError,
  onSendChapterChat,
  onAbortChapterChat,
  chatMentionOptions
}: ChatPanelProps): ReactElement {
  // per-call 模型（输入框旁自由切换；null = 默认）
  const [modelRef, setModelRef] = useState<ModelRef | null>(null)
  // 将持久化历史 + 当前流式输出映射为统一的 ConversationMessage 流
  const messages = useMemo<ConversationMessage[]>(() => {
    const msgs: ConversationMessage[] = []

    for (const msg of chapterChatMessages ?? []) {
      if (msg.role === 'user') {
        msgs.push({
          id: `chat-${msg.id}`,
          role: 'user',
          content: msg.content,
          status: 'complete',
          timestamp: msg.createdAt,
        })
      } else if (msg.role === 'agent') {
        msgs.push({
          id: `chat-${msg.id}`,
          role: 'assistant',
          agentName: msg.fromName,
          agentType: 'context',
          content: msg.content,
          status: 'complete',
          timestamp: msg.createdAt,
        })
      }
    }

    for (const output of chapterChatAgentOutputs ?? []) {
      const meta = output.agentType ? { agentType: output.agentType as ConversationMessage['agentType'] } : {}
      msgs.push({
        id: `chat-stream-${output.messageId ?? output.timestamp}`,
        role: 'assistant',
        agentName: output.agentName,
        ...meta,
        content: output.streaming ? output.preview : output.content,
        streamingBuffer: output.streaming ? output.content : undefined,
        status: output.streaming ? 'streaming' : 'complete',
        timestamp: output.timestamp,
      })
    }

    return msgs.sort((a, b) => a.timestamp - b.timestamp)
  }, [chapterChatMessages, chapterChatAgentOutputs])

  const isEmpty = messages.length === 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      {chapterChatError && (
        <div className="shrink-0 flex items-start gap-2 px-3 py-2 mx-2 mt-2 rounded-lg border border-destructive/45 bg-destructive/8 text-xs text-destructive">
          <AlertCircle className="size-3.5 shrink-0 mt-0.5" aria-hidden />
          <span className="flex-1 whitespace-pre-wrap break-words">{chapterChatError}</span>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {isEmpty ? (
          <ConversationEmptyState
            variant="chat"
            title="章节自由对话"
            hint="输入消息与 Agent/角色自由对话，@ 可指定回复方"
          />
        ) : (
          <ConversationStream
            messages={messages}
            onCheckpointResolve={() => {}}
            onSystemAction={() => {}}
            emptyHint="输入消息与 Agent/角色自由对话，@ 可指定回复方"
            emptyTitle="章节自由对话"
            emptyVariant="chat"
          />
        )}
      </div>
      <div className="shrink-0 border-t border-border">
        <div className="flex items-center gap-2 px-2 pt-1.5">
          <ModelPicker
            value={modelRef}
            onChange={setModelRef}
            label="本次回复"
          />
          <span className="ml-auto text-nano text-hint">@ 指定回复方，未选模型用默认</span>
        </div>
        <ConversationInput
          onSend={(text) => onSendChapterChat(text, undefined, modelRef)}
          onSendWithMentions={(_, mentioned) =>
            onSendChapterChat(_, mentioned && mentioned.length > 0 ? mentioned : undefined, modelRef)
          }
          onAbort={() => onAbortChapterChat?.()}
          isRunning={chapterChatRunning}
          allowSendWhileRunning
          placeholder={chapterChatRunning ? 'Agent 正在回复…' : '输入消息 @ Agent/角色 自由对话'}
          showStart={false}
          mentionOptions={chatMentionOptions}
        />
      </div>
    </div>
  )
}
