import { describe, expect, it, vi } from 'vitest'
import { Moderator } from '../core/agent/moderator.js'
import type { DiscussionGoal, DiscussionMessage, DiscussionMember, ModeratorState } from '../core/agent/discussion-types.js'

/** 创建 mock 成员 */
function makeMember(overrides: Partial<DiscussionMember> = {}): DiscussionMember {
  return {
    id: 'test-agent',
    type: 'role',
    name: '测试Agent',
    expertise: '测试',
    canConverge: false,
    buildSystemPrompt: () => 'test prompt',
    ...overrides,
  }
}

/** 创建 mock 会话工厂 */
function makeMockContext(decision: string) {
  const mockSession = {
    prompt: vi.fn().mockResolvedValue(decision),
    dispose: vi.fn(),
  }
  return {
    createSession: vi.fn().mockResolvedValue(mockSession),
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    mockSession,
  }
}

describe('Moderator', () => {
  const goal: DiscussionGoal = { task: '创作第3章', context: '上下文' }
  const history: DiscussionMessage[] = []
  const members: DiscussionMember[] = [
    makeMember({ id: 'novel-director', name: '导演', canConverge: false }),
    makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
  ]
  const state: ModeratorState = { phase: 'planning', round: 0, scenesDefined: false }

  it('解析 invite 决策', async () => {
    const ctx = makeMockContext(JSON.stringify({
      type: 'invite',
      agentId: 'novel-director',
      prompt: '分析故事状态并规划叙事任务',
      reason: '需要先规划',
    }))
    const moderator = new Moderator(ctx as any)
    const decision = await moderator.decide(goal, history, members, state)
    expect(decision.type).toBe('invite')
    if (decision.type === 'invite') {
      expect(decision.agentId).toBe('novel-director')
      expect(decision.prompt).toContain('规划')
    }
    expect(ctx.mockSession.dispose).toHaveBeenCalled()
  })

  it('解析 pause 决策', async () => {
    const ctx = makeMockContext(JSON.stringify({
      type: 'pause',
      question: '叙事方向选A还是B？',
      options: ['A', 'B'],
      reason: '需要用户拍板',
    }))
    const moderator = new Moderator(ctx as any)
    const decision = await moderator.decide(goal, history, members, state)
    expect(decision.type).toBe('pause')
    if (decision.type === 'pause') {
      expect(decision.question).toContain('A')
      expect(decision.options).toEqual(['A', 'B'])
    }
  })

  it('解析 converge 决策', async () => {
    const ctx = makeMockContext(JSON.stringify({
      type: 'converge',
      agentId: 'novel-writer',
      scope: 'chapter',
      reason: '讨论充分',
    }))
    const moderator = new Moderator(ctx as any)
    const decision = await moderator.decide(goal, history, members, state)
    expect(decision.type).toBe('converge')
    if (decision.type === 'converge') {
      expect(decision.agentId).toBe('novel-writer')
      expect(decision.scope).toBe('chapter')
    }
  })

  it('解析 next_scene 决策', async () => {
    const ctx = makeMockContext(JSON.stringify({
      type: 'next_scene',
      reason: '场景演完',
    }))
    const moderator = new Moderator(ctx as any)
    const decision = await moderator.decide(goal, history, members, state)
    expect(decision.type).toBe('next_scene')
  })

  it('解析 observe 决策', async () => {
    const ctx = makeMockContext(JSON.stringify({
      type: 'observe',
      reason: '等待反应',
    }))
    const moderator = new Moderator(ctx as any)
    const decision = await moderator.decide(goal, history, members, state)
    expect(decision.type).toBe('observe')
  })

  it('容错：LLM 输出被 markdown 代码块包裹', async () => {
    const ctx = makeMockContext('```json\n{"type":"observe","reason":"等待"}\n```')
    const moderator = new Moderator(ctx as any)
    const decision = await moderator.decide(goal, history, members, state)
    expect(decision.type).toBe('observe')
  })

  it('容错：LLM 输出非法 JSON 时重试，仍失败则降级', async () => {
    const mockSession = {
      prompt: vi.fn().mockResolvedValue('not json at all'),
      dispose: vi.fn(),
    }
    const ctx = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }
    const moderator = new Moderator(ctx as any)
    const decision = await moderator.decide(goal, history, members, state)
    // 降级为规则协调：round=0 → invite 第一个成员
    expect(decision.type).toBe('invite')
    expect(ctx.createSession).toHaveBeenCalledTimes(2) // 初次 + 重试
    expect(mockSession.dispose).toHaveBeenCalled()
  })

  it('容错：prompt() reject 时降级为规则协调', async () => {
    const mockSession = {
      prompt: vi.fn().mockRejectedValue(new Error('timeout')),
      dispose: vi.fn(),
    }
    const ctx = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }
    const moderator = new Moderator(ctx as any)
    const decision = await moderator.decide(goal, history, members, state)
    expect(decision.type).toBe('invite') // 降级
    expect(ctx.createSession).toHaveBeenCalledTimes(2) // 初次 + 重试
  })

  it('降级模式：round >= 3 时强制 converge', async () => {
    const mockSession = {
      prompt: vi.fn().mockResolvedValue('invalid'),
      dispose: vi.fn(),
    }
    const ctx = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }
    const moderator = new Moderator(ctx as any)
    const lateState: ModeratorState = { ...state, round: 3 }
    const decision = await moderator.decide(goal, history, members, lateState)
    expect(decision.type).toBe('converge')
  })

  it('降级模式：演出阶段只邀请当前场景角色', async () => {
    const mockSession = {
      prompt: vi.fn().mockResolvedValue('invalid'),
      dispose: vi.fn(),
    }
    const ctx = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }
    const actingMembers: DiscussionMember[] = [
      makeMember({ id: 'novel-director', name: '导演' }),
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
      makeMember({ id: 'novel-reviewer', name: '审稿' }),
      makeMember({ id: 'char-zhaoyan', name: '赵岩', type: 'character' }),
    ]
    const moderator = new Moderator(ctx as any)
    const decision = await moderator.decide(goal, history, actingMembers, {
      phase: 'acting',
      round: 0,
      scenesDefined: true,
      currentScene: {
        sceneId: 1,
        title: '对峙',
        location: '客厅',
        time: '夜',
        presentCharacters: ['char-zhaoyan'],
        goal: '推进冲突',
      },
    })

    expect(decision).toMatchObject({ type: 'invite', agentId: 'char-zhaoyan' })
  })
})
