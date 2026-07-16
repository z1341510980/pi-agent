import type { DiscussionMessage, DiscussionResult } from '../../../core/agent/discussion-types.js'
import type { ChapterChatMessage, ChapterChatStore } from './chapter-chat-store.js'

type PersistedChapterChatMessage = Omit<ChapterChatMessage, 'id'>

function isInitialSharedContext(message: DiscussionMessage, index: number): boolean {
  return index === 0
    && message.fromId === 'system'
    && message.content.startsWith('目标：')
    && message.content.includes('\n\n## 上下文\n')
}

function resolveAgentType(message: DiscussionMessage): string | undefined {
  if (message.type === 'moderator') return 'moderator'
  if (message.type !== 'member') return undefined
  if (message.fromId.startsWith('char-')) return 'character'
  return message.fromId.replace(/^novel-/, '')
}

/**
 * 把一次群聊运行结果转换为章节级历史消息。
 *
 * 初始 shared context 体积很大，且属于运行输入而不是对话，因此不落入聊天历史；
 * Director、角色、主持人和场景切换消息则完整保留，方便失败后复盘。
 */
export function buildDiscussionHistoryMessages(
  projectId: string,
  chapterNumber: number,
  result: DiscussionResult,
  runId: string,
): PersistedChapterChatMessage[] {
  const transcript = result.transcript.filter((message, index) => !isInitialSharedContext(message, index))
  const firstTimestamp = transcript[0]?.timestamp ?? Date.now()
  const lastTimestamp = transcript[transcript.length - 1]?.timestamp ?? firstTimestamp
  const commonMetadata = {
    flowMode: 'discussion' as const,
    discussionRunId: runId,
  }

  const messages: PersistedChapterChatMessage[] = [{
    projectId,
    chapterNumber,
    role: 'system',
    fromId: 'system',
    fromName: '系统',
    content: `第 ${chapterNumber} 章群聊创作开始`,
    phase: 'discussion',
    metadata: {
      ...commonMetadata,
      discussionMessageType: 'run_start',
      discussionRunStatus: result.status,
    },
    createdAt: Math.max(0, firstTimestamp - 1),
  }]

  for (const message of transcript) {
    const agentType = resolveAgentType(message)
    messages.push({
      projectId,
      chapterNumber,
      role: message.type === 'member' || message.type === 'moderator' ? 'agent' : 'system',
      fromId: message.fromId,
      fromName: message.fromName,
      content: message.content,
      phase: 'discussion',
      metadata: {
        ...commonMetadata,
        ...(agentType ? { agentType } : {}),
        discussionMessageType: message.type,
        ...(message.sceneId !== undefined ? { sceneId: message.sceneId } : {}),
      },
      createdAt: message.timestamp,
    })
  }

  const statusText = result.status === 'completed'
    ? '群聊创作完成'
    : result.status === 'cancelled'
      ? '群聊创作已取消'
      : `群聊创作失败：${result.error ?? '未知错误'}`
  messages.push({
    projectId,
    chapterNumber,
    role: 'system',
    fromId: 'system',
    fromName: '系统',
    content: statusText,
    phase: 'discussion',
    metadata: {
      ...commonMetadata,
      discussionMessageType: 'run_end',
      discussionRunStatus: result.status,
      discussionCanResume: result.status === 'error' && result.failedPhase === 'chapter_weaving',
    },
    createdAt: lastTimestamp + 1,
  })

  return messages
}

export function persistDiscussionHistory(
  store: ChapterChatStore,
  projectId: string,
  chapterNumber: number,
  result: DiscussionResult,
  runId: string,
): void {
  store.addMany(buildDiscussionHistoryMessages(projectId, chapterNumber, result, runId))
}
