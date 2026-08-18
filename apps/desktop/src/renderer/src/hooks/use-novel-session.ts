import { useCallback, useMemo } from 'react'
import { useChapterChat, type ChatAgentOutput, type UseChapterChatReturn } from './use-chapter-chat'
import { useNovelCreationFlow, type UseNovelCreationFlowReturn } from './use-novel-creation-flow'

export type NovelRunKind = 'idle' | 'chat' | 'workflow' | 'discussion' | 'arrange' | 'reverse'

export interface NovelActiveRun {
  kind: NovelRunKind
  isRunning: boolean
  runId?: string
}

export interface UseNovelSessionReturn {
  creationFlow: UseNovelCreationFlowReturn
  chapterChat: UseChapterChatReturn
  activeRun: NovelActiveRun
  chatAgentOutputs: ChatAgentOutput[]
  startWorkflow: UseNovelCreationFlowReturn['startCreation']
  startDiscussion: UseNovelCreationFlowReturn['startDiscussion']
  resumeWorkflow: UseNovelCreationFlowReturn['resumeWorkflow']
  resumeDiscussion: UseNovelCreationFlowReturn['resumeDiscussion']
  sendChat: UseChapterChatReturn['sendMessage']
  abortChat: UseChapterChatReturn['abort']
  sendInterject: UseNovelCreationFlowReturn['sendInterject']
}

/**
 * 章节统一会话适配层。
 *
 * 后端执行器仍保持独立，这里只统一前端状态入口和运行态判断，避免工作区
 * 同时理解两个 Hook 的并发、错误与流式输出细节。
 */
export function useNovelSession(): UseNovelSessionReturn {
  const creationFlow = useNovelCreationFlow()
  const chapterChat = useChapterChat()

  const startWorkflow = useCallback<UseNovelCreationFlowReturn['startCreation']>(
    (...args) => creationFlow.startCreation(...args),
    [creationFlow.startCreation],
  )
  const startDiscussion = useCallback<UseNovelCreationFlowReturn['startDiscussion']>(
    (...args) => creationFlow.startDiscussion(...args),
    [creationFlow.startDiscussion],
  )
  const resumeWorkflow = useCallback<UseNovelCreationFlowReturn['resumeWorkflow']>(
    (...args) => creationFlow.resumeWorkflow(...args),
    [creationFlow.resumeWorkflow],
  )
  const resumeDiscussion = useCallback<UseNovelCreationFlowReturn['resumeDiscussion']>(
    (...args) => creationFlow.resumeDiscussion(...args),
    [creationFlow.resumeDiscussion],
  )
  const sendChat = useCallback<UseChapterChatReturn['sendMessage']>(
    (...args) => chapterChat.sendMessage(...args),
    [chapterChat.sendMessage],
  )
  const abortChat = useCallback<UseChapterChatReturn['abort']>(
    () => chapterChat.abort(),
    [chapterChat.abort],
  )
  const sendInterject = useCallback<UseNovelCreationFlowReturn['sendInterject']>(
    (...args) => creationFlow.sendInterject(...args),
    [creationFlow.sendInterject],
  )

  const activeRun = useMemo<NovelActiveRun>(() => {
    if (creationFlow.isRunning || creationFlow.phase !== 'idle') {
      const kind: NovelRunKind = creationFlow.result?.discussionRunId
        ? 'discussion'
        : creationFlow.phase === 'idle' && !creationFlow.isRunning
          ? 'idle'
          : 'workflow'
      return {
        kind,
        isRunning: creationFlow.isRunning,
        runId: creationFlow.result?.workflowRunId ?? creationFlow.result?.discussionRunId
      }
    }
    if (chapterChat.isRunning || chapterChat.agentOutputs.length > 0) {
      return { kind: 'chat', isRunning: chapterChat.isRunning }
    }
    return { kind: 'idle', isRunning: false }
  }, [chapterChat.agentOutputs.length, chapterChat.isRunning, creationFlow])

  return {
    creationFlow,
    chapterChat,
    activeRun,
    chatAgentOutputs: chapterChat.agentOutputs,
    startWorkflow,
    startDiscussion,
    resumeWorkflow,
    resumeDiscussion,
    sendChat,
    abortChat,
    sendInterject,
  }
}
