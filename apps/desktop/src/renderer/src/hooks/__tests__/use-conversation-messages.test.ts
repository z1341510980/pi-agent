/**
 * buildConversationMessages 单测（P2-1a）
 *
 * 覆盖七类来源的合并规则：
 * - 自由聊天历史 / 文风审查系统消息
 * - workflow 历史恢复（无实时状态时才恢复，decision 回填 checkpoint）
 * - discussion 历史恢复（插话去重、可续跑 run_end 系统动作）
 * - 实时 agentOutputs / chapterChat 流式 / userMessages / interjectMessages
 * - checkpoint 历史 + 当前检查点
 * - 完成系统消息（canSave 分支）/ 时间线重建状态消息
 * - 按时间戳排序
 */
import { describe, expect, it } from 'vitest'
import {
  buildConversationMessages,
  mapAgentType,
  renderCheckpointContent,
  type ConversationMessagesInput,
} from '../use-conversation-messages'
import type { AgentOutput, CheckpointData, CheckpointDecision, UserMessage, InterjectMessage } from '@/hooks/use-novel-creation-flow'
import type { ChatAgentOutput } from '@/hooks/use-chapter-chat'
import type { ChapterChatMessage } from '@/api/novel-client'
import type { TimelineRebuildStatus } from '@/stores/timeline-rebuild-store'

const IDLE_STATUS: TimelineRebuildStatus = {
  phase: 'idle',
  startChapterNumber: null,
  total: 0,
  completed: 0,
  error: null,
  updatedAt: 0
}

function makeChatMessage(overrides: Partial<ChapterChatMessage> & Pick<ChapterChatMessage, 'id' | 'role' | 'phase' | 'content'>): ChapterChatMessage {
  return {
    projectId: 'p1',
    chapterNumber: 1,
    fromId: overrides.role === 'user' ? 'u1' : 'a1',
    fromName: overrides.fromName ?? '导演',
    createdAt: 1000,
    ...overrides
  }
}

function makeAgentOutput(overrides: Partial<AgentOutput>): AgentOutput {
  return {
    agentType: 'director',
    agentName: '导演',
    content: '正文内容',
    preview: '预览',
    timestamp: 2000,
    ...overrides
  }
}

function makeCheckpoint(overrides: Partial<CheckpointData> & Pick<CheckpointData, 'type'>): CheckpointData {
  return {
    phase: 'checkpoint_review',
    data: '检查点内容',
    createdAt: 3000,
    checkpointId: 'cp-1',
    ...overrides
  }
}

function baseInput(overrides: Partial<ConversationMessagesInput> = {}): ConversationMessagesInput {
  return {
    flowType: 'workflow',
    chapterChatMessages: [],
    agentOutputs: [],
    chapterChatAgentOutputs: [],
    userMessages: [],
    interjectMessages: [],
    checkpointHistory: [],
    currentCheckpoint: null,
    isRunning: false,
    isCompleted: false,
    completedActionLabel: '创作',
    canSave: false,
    chapterNumber: 3,
    timelineStatus: IDLE_STATUS,
    ...overrides
  }
}

describe('buildConversationMessages：自由聊天历史', () => {
  it('free_chat 用户与 agent 消息映射为 user/assistant，非 free_chat 不渲染', () => {
    const messages = buildConversationMessages(baseInput({
      chapterChatMessages: [
        makeChatMessage({ id: 'c1', role: 'user', phase: 'free_chat', content: '你好' }),
        makeChatMessage({ id: 'c2', role: 'agent', phase: 'free_chat', content: '回答', metadata: { agentType: 'writer' } }),
        // workflow 落库消息不应出现在 free_chat 分支（也无 workflow 实时态时由恢复分支处理）
        makeChatMessage({ id: 'c3', role: 'agent', phase: 'review', content: '审稿意见' })
      ]
    }))
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ id: 'chat-history-c1', role: 'user', content: '你好' })
    expect(messages[1]).toMatchObject({ id: 'chat-history-c2', role: 'assistant', agentType: 'writer' })
  })
})

describe('buildConversationMessages：workflow 历史恢复', () => {
  it('无实时状态时恢复 workflow 历史，decision 合并回 checkpoint', () => {
    const messages = buildConversationMessages(baseInput({
      flowType: 'workflow',
      chapterChatMessages: [
        makeChatMessage({
          id: 'w1', role: 'system', phase: 'checkpoint', content: '',
          metadata: { flowMode: 'workflow', workflowMessageType: 'checkpoint', checkpointType: 'narrative_task', checkpointId: 'cp1', checkpointData: '推进主线' }
        }),
        makeChatMessage({
          id: 'w2', role: 'user', phase: 'checkpoint', content: 'approve',
          metadata: { flowMode: 'workflow', workflowMessageType: 'decision', checkpointId: 'cp1', decision: 'approve' }
        }),
        makeChatMessage({ id: 'w3', role: 'agent', phase: 'checkpoint', content: '开始写作', metadata: { flowMode: 'workflow', workflowMessageType: 'agent', agentType: 'writer' } })
      ]
    }))
    const checkpoints = messages.filter((m) => m.id === 'workflow-history-checkpoint-w1')
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0].checkpointResolved).toBe('approve')
    // decision 消息不单独展示
    expect(messages.some((m) => m.content === 'approve')).toBe(false)
    expect(messages.some((m) => m.id === 'workflow-history-w3')).toBe(true)
  })

  it('有实时状态时不恢复 workflow 历史，避免重复', () => {
    const chatMessages = [
      makeChatMessage({ id: 'w1', role: 'agent', phase: 'checkpoint', content: '历史输出', metadata: { flowMode: 'workflow', workflowMessageType: 'agent' } })
    ]
    const withLive = buildConversationMessages(baseInput({
      chapterChatMessages: chatMessages,
      isRunning: true
    }))
    expect(withLive.some((m) => m.id === 'workflow-history-w1')).toBe(false)

    const withoutLive = buildConversationMessages(baseInput({ chapterChatMessages: chatMessages }))
    expect(withoutLive.some((m) => m.id === 'workflow-history-w1')).toBe(true)
  })

  it('历史用户插话带 queued 兜底状态', () => {
    const messages = buildConversationMessages(baseInput({
      flowType: 'discussion',
      interjectMessages: [],
      chapterChatMessages: [
        makeChatMessage({
          id: 'd1', role: 'user', phase: 'discussion', content: '插一句',
          metadata: { flowMode: 'discussion', interject: true }
        })
      ]
    }))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'user', content: '插一句', interjectStatus: 'queued' })
  })
})

describe('buildConversationMessages：discussion 插话去重', () => {
  it('有本地实时插话时跳过历史插话条目', () => {
    const messages = buildConversationMessages(baseInput({
      flowType: 'discussion',
      chapterChatMessages: [
        makeChatMessage({
          id: 'd1', role: 'user', phase: 'discussion', content: '历史插话',
          metadata: { flowMode: 'discussion', interject: true }
        })
      ],
      interjectMessages: [
        { messageId: 'i1', content: '实时插话', status: 'injected', timestamp: 5000 }
      ]
    }))
    expect(messages.some((m) => m.content === '历史插话')).toBe(false)
    expect(messages.some((m) => m.id === 'interject-i1')).toBe(true)
  })

  it('run_end 失败且可续跑时生成「从中断处继续」系统动作', () => {
    const messages = buildConversationMessages(baseInput({
      flowType: 'discussion',
      chapterChatMessages: [
        makeChatMessage({
          id: 'end1', role: 'system', phase: 'discussion', content: '流程失败',
          metadata: { flowMode: 'discussion', discussionMessageType: 'run_end', discussionRunStatus: 'error', discussionCanResume: true, discussionRunId: 'run-9' }
        })
      ]
    }))
    expect(messages).toHaveLength(1)
    expect(messages[0].systemActions).toEqual([
      { label: '从中断处继续', action: 'resume-discussion:run-9', variant: 'default' }
    ])
  })
})

describe('buildConversationMessages：实时流', () => {
  it('agentOutputs 优先 messageId；流式中 thinking 进入 streamingBuffer', () => {
    const messages = buildConversationMessages(baseInput({
      agentOutputs: [
        makeAgentOutput({ messageId: 'msg-a', timestamp: 100, streaming: false, content: '完成文本' }),
        makeAgentOutput({ timestamp: 101, streaming: true, hasStreamedText: false, thinking: '推理中…', content: '', preview: '已启动' })
      ]
    }))
    expect(messages[0]).toMatchObject({ id: 'agent-msg-a', content: '完成文本', status: 'complete' })
    expect(messages[1]).toMatchObject({ id: 'agent-101-director-1', status: 'streaming', content: '已启动' })
    expect(messages[1].streamingBuffer).toContain('思考过程')
  })

  it('未流式且无正文时用 thinking 充当气泡内容', () => {
    const messages = buildConversationMessages(baseInput({
      agentOutputs: [makeAgentOutput({ timestamp: 102, streaming: false, hasStreamedText: false, thinking: '深度推理', content: '' })]
    }))
    expect(messages[0].content).toBe('**思考过程**\n\n深度推理')
  })

  it('自由聊天流式输出进入同一条时间线', () => {
    const output: ChatAgentOutput = {
      messageId: 'cm1',
      agentId: 'agent-writer',
      agentType: 'writer',
      agentName: '写作',
      content: '流式正文',
      preview: '流式…',
      streaming: true,
      timestamp: 6000
    }
    const messages = buildConversationMessages(baseInput({ chapterChatAgentOutputs: [output] }))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ id: 'chat-stream-cm1', status: 'streaming', content: '流式…', streamingBuffer: '流式正文' })
  })

  it('userMessages 与 interjectMessages 渲染为 user 气泡，插话带状态徽标', () => {
    const userMessages: UserMessage[] = [{ id: 'u1', content: '开始吧', timestamp: 7000 }]
    const interjectMessages: InterjectMessage[] = [
      { messageId: 'i9', content: '节奏慢了', status: 'dropped', timestamp: 7100 }
    ]
    const messages = buildConversationMessages(baseInput({ userMessages, interjectMessages }))
    expect(messages.find((m) => m.id === 'user-u1')?.content).toBe('开始吧')
    expect(messages.find((m) => m.id === 'interject-i9')).toMatchObject({
      interjectStatus: 'dropped',
      role: 'user'
    })
  })
})

describe('buildConversationMessages：检查点与终态', () => {
  it('checkpointHistory 与 currentCheckpoint 都渲染，当前检查点未 resolved', () => {
    const history = [makeCheckpoint({ type: 'narrative_task', checkpointId: 'cp-old', decision: 'approve', createdAt: 100 })]
    const current = makeCheckpoint({ type: 'review', checkpointId: 'cp-cur', createdAt: 200 })
    const messages = buildConversationMessages(baseInput({ checkpointHistory: history, currentCheckpoint: current }))
    const ids = messages.map((m) => m.id)
    expect(ids).toContain('checkpoint-cp-old')
    expect(ids).toContain('checkpoint-cp-cur')
    expect(messages.find((m) => m.id === 'checkpoint-cp-old')?.checkpointResolved).toBe('approve')
    expect(messages.find((m) => m.id === 'checkpoint-cp-cur')?.checkpointResolved).toBeUndefined()
  })

  it('完成消息：canSave 时给保存/丢弃动作，否则只给完成', () => {
    const saving = buildConversationMessages(baseInput({ isCompleted: true, canSave: true }))
    expect(saving.at(-1)?.systemActions?.map((a) => a.label)).toEqual(['保存到章节', '丢弃'])
    expect(saving.at(-1)?.content).toBe('第 3 章创作完成')

    const noSave = buildConversationMessages(baseInput({ isCompleted: true, canSave: false, completedActionLabel: '反推' }))
    expect(noSave.at(-1)?.systemActions?.map((a) => a.label)).toEqual(['完成'])
    expect(noSave.at(-1)?.content).toBe('第 3 章反推完成')
  })

  it('时间线重建 invalidated 且无错误时提供「开始重建」动作', () => {
    const messages = buildConversationMessages(baseInput({
      timelineStatus: { ...IDLE_STATUS, phase: 'invalidated', total: 4, startChapterNumber: 2, updatedAt: 9000 }
    }))
    const status = messages.find((m) => m.id === 'timeline-rebuild-status')
    expect(status?.systemActions).toEqual([{ label: '开始重建', action: 'timeline-start', variant: 'default' }])
    expect(status?.content).toContain('第 2 章起 4 章')
  })
})

describe('buildConversationMessages：排序', () => {
  it('混合来源按时间戳升序排列', () => {
    const messages = buildConversationMessages(baseInput({
      agentOutputs: [makeAgentOutput({ messageId: 'late', timestamp: 9999 })],
      userMessages: [{ id: 'early', content: '最早', timestamp: 1 }]
    }))
    expect(messages.map((m) => m.timestamp)).toEqual([...messages.map((m) => m.timestamp)].sort((a, b) => a - b))
    expect(messages[0].id).toBe('user-early')
    expect(messages.at(-1)?.id).toBe('agent-late')
  })
})

describe('mapAgentType 与 renderCheckpointContent', () => {
  it('未知 agentType 回退 context', () => {
    expect(mapAgentType('writer')).toBe('writer')
    expect(mapAgentType('whatever')).toBe('context')
  })

  it('post_write_guard 渲染守护原因与重写次数', () => {
    const content = renderCheckpointContent(makeCheckpoint({
      type: 'post_write_guard',
      data: { reason: '字数不足', details: '少于目标下限', wordCount: 800, rewriteCount: 1, maxRewrite: 2 }
    }))
    expect(content).toContain('写作守护触发原因')
    expect(content).toContain('**原因：** 字数不足')
    expect(content).toContain('**重写次数：** 1 / 2')
  })

  it('字符串 data 原样返回', () => {
    expect(renderCheckpointContent(makeCheckpoint({ type: 'review', data: '纯文本结论' }))).toBe('纯文本结论')
  })

  it('discussion_pause 渲染提问与候选项（2026-08-24 空检查点修复）', () => {
    const content = renderCheckpointContent(makeCheckpoint({
      type: 'discussion_pause',
      question: '两位角色的行动出现分歧，需要你拍板。',
      data: {
        message: '两位角色的行动出现分歧，需要你拍板。',
        choices: ['方案A：先去据点', '方案B：原地养伤'],
      },
    }))
    expect(content).toContain('两位角色的行动出现分歧')
    expect(content).toContain('- 方案A：先去据点')
    expect(content).toContain('- 方案B：原地养伤')
  })

  it('discussion_pause 的 data 缺失时回退 question 字段', () => {
    const content = renderCheckpointContent(makeCheckpoint({
      type: 'discussion_pause',
      question: '请确认下一步走向。',
      data: undefined,
    }))
    expect(content).toBe('请确认下一步走向。')
  })

  it('getCheckpointPresentation：discussion_pause 固定继续/终止按钮；options 全不匹配时保留默认按钮组', async () => {
    const { getCheckpointPresentation } = await import('../use-conversation-messages')
    // 服务端固定下发 approve/reject → 两枚按钮
    const matched = getCheckpointPresentation({
      type: 'discussion_pause',
      options: ['approve', 'reject'],
    })
    expect(matched.checkpointType).toBe('discussion_pause')
    expect(matched.checkpointOptions.map((o) => o.action)).toEqual(['approve', 'reject'])

    // LLM 自由文本选项匹配不上任何动作 → 兜底保留默认按钮组（不再渲染空按钮区）。
    // 该形态只来自旧版载荷，用断言模拟（新版引擎固定下发 approve/reject）。
    const fallback = getCheckpointPresentation({
      type: 'discussion_pause',
      options: ['方案A', '方案B'] as unknown as CheckpointDecision[],
    })
    expect(fallback.checkpointOptions.length).toBeGreaterThanOrEqual(2)
  })
})
