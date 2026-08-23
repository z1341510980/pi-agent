import { describe, expect, it, vi } from 'vitest'
import type { DiscussionResult } from '../core/discussion/engine/discussion-types.js'
import {
  buildDiscussionHistoryMessages,
  persistDiscussionHistory,
} from '../core/discussion/discussion-history.js'

describe('discussion history persistence', () => {
  const result: DiscussionResult = {
    status: 'error',
    error: 'LLM 调用失败: 502',
    failedPhase: 'chapter_weaving',
    scenes: [],
    transcript: [
      {
        id: 'context',
        fromId: 'system',
        fromName: '系统',
        content: '目标：创作第 9 章正文\n\n## 上下文\n很长的共享上下文',
        timestamp: 1000,
        type: 'system',
      },
      {
        id: 'moderator',
        fromId: 'moderator',
        fromName: '主持人',
        content: '@导演 请拆分场景',
        timestamp: 2000,
        type: 'moderator',
      },
      {
        id: 'director',
        fromId: 'novel-director',
        fromName: '导演 Agent',
        content: '场景规划',
        timestamp: 3000,
        type: 'member',
      },
      {
        id: 'character',
        fromId: 'char-1',
        fromName: '叶明远',
        content: '角色推演',
        timestamp: 4000,
        type: 'member',
        sceneId: 1,
      },
    ],
  }

  it('filters the large shared context and keeps reviewable discussion messages', () => {
    const messages = buildDiscussionHistoryMessages('project-1', 9, result, 'run-1')

    expect(messages.map(message => message.content)).toEqual([
      '第 9 章群聊创作开始',
      '@导演 请拆分场景',
      '场景规划',
      '角色推演',
      '群聊创作失败：LLM 调用失败: 502',
    ])
    expect(messages[1]).toMatchObject({
      role: 'agent',
      fromName: '主持人',
      metadata: { agentType: 'moderator', discussionRunId: 'run-1' },
    })
    expect(messages[3]).toMatchObject({
      role: 'agent',
      metadata: { agentType: 'character', sceneId: 1 },
    })
    expect(messages[4].metadata).toMatchObject({
      discussionRunStatus: 'error',
      discussionCanResume: true,
    })
  })

  it('writes the whole run in one batch', () => {
    const addMany = vi.fn()
    persistDiscussionHistory({ addMany } as never, 'project-1', 9, result, 'run-1')

    expect(addMany).toHaveBeenCalledOnce()
    expect(addMany.mock.calls[0][0]).toHaveLength(5)
  })

  it('插话消息不再二次落库：端点已以 role=user + metadata.interject 落过一次', () => {
    const withInterject: DiscussionResult = {
      ...result,
      transcript: [
        ...result.transcript,
        {
          // 引擎 drainInterjectQueue 的插话标记：id 以 interject- 为前缀
          id: 'interject-ij-1',
          fromId: 'user',
          fromName: '用户',
          content: '【用户中途反馈】\n（讨论进行中用户提出，可影响讨论方向）\n打斗戏改用棍',
          timestamp: 5000,
          type: 'user',
        },
      ],
    }

    const messages = buildDiscussionHistoryMessages('project-1', 9, withInterject, 'run-1')

    // 插话被跳过：历史里不出现带【用户中途反馈】前缀的第二份文本
    expect(messages.some(message => message.content.includes('用户中途反馈'))).toBe(false)
    expect(messages).toHaveLength(5)
  })

  it('type=user 的 transcript 消息映射 role=user（不再伪装成 system）', () => {
    const messages = buildDiscussionHistoryMessages('project-1', 9, {
      ...result,
      transcript: [{
        id: 'user-note',
        fromId: 'user',
        fromName: '用户',
        content: '一条用户发言',
        timestamp: 5000,
        type: 'user',
      }],
    }, 'run-1')

    const userMessage = messages.find(message => message.content === '一条用户发言')
    expect(userMessage).toBeDefined()
    expect(userMessage!.role).toBe('user')
  })
})
