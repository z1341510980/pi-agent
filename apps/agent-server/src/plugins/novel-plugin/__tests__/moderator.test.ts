import { describe, expect, it, vi } from 'vitest'
import { Moderator } from '../core/discussion/engine/moderator.js'
import type { DiscussionGoal, DiscussionMessage, DiscussionMember, ModeratorState } from '../core/discussion/engine/discussion-types.js'

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
      reason: '需要先规划',    }))
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

  it('降级模式：round 达到 limits.maxRoundsPerScene 时强制 converge（2026-08-24 前为硬编码 3）', async () => {
    const mockSession = {
      prompt: vi.fn().mockResolvedValue('invalid'),
      dispose: vi.fn(),
    }
    const ctx = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }
    // 未传 limits 时回落 DISCUSSION_LIMITS.MAX_ROUNDS_PER_SCENE(10)：round=3 不再触发收敛
    const moderator = new Moderator(ctx as any)
    const earlyDecision = await moderator.decide(goal, history, members, { ...state, round: 3 })
    expect(earlyDecision.type).toBe('invite')

    // 显式注入 limits 后按注入值收敛：降级轮数与引擎 maxRoundsPerScene 同源
    const limitedModerator = new Moderator(ctx as any, undefined, { maxRoundsPerScene: 3 })
    const lateState: ModeratorState = { ...state, round: 3 }
    const decision = await limitedModerator.decide(goal, history, members, lateState)
    expect(decision.type).toBe('converge')
    if (decision.type === 'converge') {
      expect(decision.scope).toBe(state.phase === 'planning' ? 'chapter' : 'scene')
      expect(decision.reason).toContain('上限')
    }
  })

  it('降级模式：未发言者优先轮流，不漏人', async () => {
    const mockSession = {
      prompt: vi.fn().mockResolvedValue('invalid'),
      dispose: vi.fn(),
    }
    const ctx = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }
    const actingMembers: DiscussionMember[] = [
      makeMember({ id: 'char-a', name: '甲', type: 'character' }),
      makeMember({ id: 'char-b', name: '乙', type: 'character' }),
      makeMember({ id: 'char-c', name: '丙', type: 'character' }),
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
    ]
    const moderator = new Moderator(ctx as any, undefined, { maxRoundsPerScene: 10 })
    const actingState: ModeratorState = {
      phase: 'acting',
      round: 0,
      scenesDefined: true,
      currentScene: {
        sceneId: 1,
        title: '对峙',
        location: '客厅',
        time: '夜',
        presentCharacters: ['char-a', 'char-b', 'char-c'],
        goal: '推进冲突',
      },
    }
    // history 中甲乙已发言、丙未发言 → 降级应优先点丙
    const spokenHistory: DiscussionMessage[] = [
      { id: 'm1', fromId: 'char-a', fromName: '甲', content: '[点头] “好。”', timestamp: 1, sceneId: 1, type: 'member' },
      { id: 'm2', fromId: 'char-b', fromName: '乙', content: '[摇头] “不行。”', timestamp: 2, sceneId: 1, type: 'member' },
    ]
    const decision = await moderator.decide(goal, spokenHistory, actingMembers, actingState)
    expect(decision).toMatchObject({ type: 'invite', agentId: 'char-c' })
  })

  it('降级演出点名携带场景契约与对手台词（反刻板，不再裸模板）', async () => {
    const mockSession = {
      prompt: vi.fn().mockRejectedValue(new Error('timeout')),
      dispose: vi.fn(),
    }
    const ctx = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }
    const actingMembers: DiscussionMember[] = [
      makeMember({ id: 'char-a', name: '甲', type: 'character' }),
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
    ]
    const moderator = new Moderator(ctx as any, undefined, { maxRoundsPerScene: 10 })
    const history: DiscussionMessage[] = [
      { id: 'm1', fromId: 'char-b', fromName: '乙', content: '[按刀] “昨夜部队已全灭。”', timestamp: 2, sceneId: 1, type: 'member' },
    ]
    const decision = await moderator.decide(goal, history, actingMembers, {
      phase: 'acting',
      round: 0,
      scenesDefined: true,
      currentScene: {
        sceneId: 1,
        title: '残垣哨所',
        location: '哨所入口',
        time: '清晨',
        conflict: '幸存者身份存疑',
        presentCharacters: ['char-a'],
        goal: '确认身份并带离',
      },
    })
    expect(decision.type).toBe('invite')
    if (decision.type === 'invite') {
      // 场景契约 + 对手台词进入 prompt，替代旧裸模板
      expect(decision.prompt).toContain('残垣哨所')
      expect(decision.prompt).toContain('幸存者身份存疑')
      expect(decision.prompt).toContain('昨夜部队已全灭')
      expect(decision.prompt).not.toContain('请基于当前群聊记录演出')
    }
    // 双次失败计一次降级轮，供 diagnostics 透出
    expect(moderator.degradedRounds).toBe(1)
  })

  it('规划阶段 converge scope=scene 自动纠偏为 chapter（防 planning 死循环）', async () => {
    const mockSession = {
      prompt: vi.fn().mockResolvedValue(JSON.stringify({
        type: 'converge',
        agentId: 'novel-writer',
        scope: 'scene',
        reason: '拆场完成',
      })),
      dispose: vi.fn(),
    }
    const ctx = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }
    const planningMembers: DiscussionMember[] = [
      makeMember({ id: 'novel-director', name: '导演' }),
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
    ]
    const moderator = new Moderator(ctx as any)
    const decision = await moderator.decide(goal, history, planningMembers, { phase: 'planning', round: 1, scenesDefined: false })
    expect(decision).toMatchObject({ type: 'converge', scope: 'chapter', agentId: 'novel-writer' })
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

  it('收到中止信号时不重试也不降级调度', async () => {
    const controller = new AbortController()
    controller.abort(new Error('用户手动停止'))
    const ctx = {
      createSession: vi.fn().mockRejectedValue(controller.signal.reason),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }
    const moderator = new Moderator(ctx as any)

    await expect(moderator.decide(goal, history, members, state, controller.signal))
      .rejects.toThrow('用户手动停止')
    expect(ctx.createSession).toHaveBeenCalledTimes(1)
  })

  // ── 多角色点名（演出阶段合并调用的协议层）──
  //
  // agentIds 是可选优化字段：非法值应被丢弃而不是触发重试/降级 ——
  // 退回单角色仍是完全正确的行为。

  describe('多角色点名 agentIds', () => {
    const actingState: ModeratorState = { phase: 'acting', round: 1, scenesDefined: true }
    const actingMembers: DiscussionMember[] = [
      makeMember({ id: 'char-a', name: '甲', type: 'character' }),
      makeMember({ id: 'char-b', name: '乙', type: 'character' }),
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
    ]

    it('演出阶段保留合法的多角色点名', async () => {
      const ctx = makeMockContext(JSON.stringify({
        type: 'invite',
        agentId: 'char-a',
        agentIds: ['char-a', 'char-b'],
        prompt: '对峙',
        reason: '同场对戏',
      }))
      const decision = await new Moderator(ctx as any).decide(goal, history, actingMembers, actingState)

      expect(decision).toMatchObject({ type: 'invite', agentIds: ['char-a', 'char-b'] })
    })

    it('剔除不存在的成员 id', async () => {
      const ctx = makeMockContext(JSON.stringify({
        type: 'invite',
        agentId: 'char-a',
        agentIds: ['char-a', 'char-ghost'],
        prompt: '对峙',
        reason: 'x',
      }))
      const decision = await new Moderator(ctx as any).decide(goal, history, actingMembers, actingState)

      // 只剩 1 人 → 退回单角色
      expect(decision).toMatchObject({ type: 'invite', agentIds: undefined })
    })

    it('剔除非角色成员 —— 工种 Agent 不参与角色演出', async () => {
      const ctx = makeMockContext(JSON.stringify({
        type: 'invite',
        agentId: 'char-a',
        agentIds: ['char-a', 'novel-writer'],
        prompt: '对峙',
        reason: 'x',
      }))
      const decision = await new Moderator(ctx as any).decide(goal, history, actingMembers, actingState)

      expect(decision).toMatchObject({ agentIds: undefined })
    })

    it('规划阶段不允许多角色（该阶段只该 Director 发言）', async () => {
      const ctx = makeMockContext(JSON.stringify({
        type: 'invite',
        agentId: 'novel-director',
        agentIds: ['novel-director', 'novel-writer'],
        prompt: '规划',
        reason: 'x',
      }))
      const decision = await new Moderator(ctx as any).decide(goal, history, members, state)

      expect(decision).toMatchObject({ type: 'invite', agentIds: undefined })
    })

    it('agentId 自动补进 agentIds 首位（决定演出顺序）', async () => {
      const ctx = makeMockContext(JSON.stringify({
        type: 'invite',
        agentId: 'char-a',
        agentIds: ['char-b'],
        prompt: '对峙',
        reason: 'x',
      }))
      const decision = await new Moderator(ctx as any).decide(goal, history, actingMembers, actingState)

      expect(decision).toMatchObject({ agentIds: ['char-a', 'char-b'] })
    })

    it('去重', async () => {
      const ctx = makeMockContext(JSON.stringify({
        type: 'invite',
        agentId: 'char-a',
        agentIds: ['char-a', 'char-a', 'char-b'],
        prompt: '对峙',
        reason: 'x',
      }))
      const decision = await new Moderator(ctx as any).decide(goal, history, actingMembers, actingState)

      expect(decision).toMatchObject({ agentIds: ['char-a', 'char-b'] })
    })

    it('agentIds 非数组时丢弃而不抛错', async () => {
      const ctx = makeMockContext(JSON.stringify({
        type: 'invite',
        agentId: 'char-a',
        agentIds: 'char-b',
        prompt: '对峙',
        reason: 'x',
      }))
      const decision = await new Moderator(ctx as any).decide(goal, history, actingMembers, actingState)

      expect(decision).toMatchObject({ type: 'invite', agentId: 'char-a', agentIds: undefined })
    })

    it('未提供 agentIds 时行为与合并前完全一致', async () => {
      const ctx = makeMockContext(JSON.stringify({
        type: 'invite',
        agentId: 'char-a',
        prompt: '对峙',
        reason: 'x',
      }))
      const decision = await new Moderator(ctx as any).decide(goal, history, actingMembers, actingState)

      expect(decision).toMatchObject({ type: 'invite', agentId: 'char-a' })
      expect((decision as { agentIds?: string[] }).agentIds).toBeUndefined()
    })
  })

  // ── 2026-08-24：思考型模型输出容错（B 类降级根治）──

  describe('思考型模型输出解析', () => {
    const actingState: ModeratorState = {
      phase: 'acting',
      round: 0,
      scenesDefined: true,
      currentScene: {
        sceneId: 1,
        title: '对峙',
        location: '客厅',
        time: '夜',
        presentCharacters: ['char-a'],
        goal: '推进冲突',
      },
    }
    const actingMembers: DiscussionMember[] = [
      makeMember({ id: 'char-a', name: '甲', type: 'character' }),
    ]

    it('剥掉 <think> 思考块后提取 JSON', async () => {
      const raw = `<think>用户想让我决定谁先发言。也许 {"type":"observe"} 是个选项，但我觉得 invite 更好。</think>\n\n{"type":"invite","agentId":"char-a","prompt":"演出","reason":"开场"}`
      const ctx = makeMockContext(raw)
      const decision = await new Moderator(ctx as any).decide(goal, history, actingMembers, actingState)
      expect(decision).toMatchObject({ type: 'invite', agentId: 'char-a' })
    })

    it('散文夹杂多个大括号片段时平铺扫描取合法决策', async () => {
      const raw = `分析：{场景 tension 高}。建议 {type: 非法格式} 由 {甲} 先发言。\n{"type":"invite","agentId":"char-a","prompt":"回应质疑","reason":"推动对戏"}`
      const ctx = makeMockContext(raw)
      const decision = await new Moderator(ctx as any).decide(goal, history, actingMembers, actingState)
      expect(decision).toMatchObject({ type: 'invite', agentId: 'char-a', prompt: '回应质疑' })
    })

    it('首次无 JSON 时第二次用纠正性重试 prompt 恢复', async () => {
      // 按调用次序出队：第 1 次（任一 session）返回散文，第 2 次返回合法 JSON
      const responses = [
        '我觉得应该让角色先发言。', // 无任何大括号
        '{"type":"invite","agentId":"char-a","prompt":"演出","reason":"重试成功"}',
      ]
      const ctx = {
        createSession: vi.fn().mockImplementation(async () => ({
          prompt: vi.fn().mockResolvedValue(responses.shift()),
          dispose: vi.fn(),
        })),
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }
      const moderator = new Moderator(ctx as any)
      const decision = await moderator.decide(goal, history, actingMembers, actingState)

      expect(decision).toMatchObject({ type: 'invite', agentId: 'char-a' })
      expect(moderator.degradedRounds).toBe(0) // 纠正性重试成功，不降级
      // 第二次调用必须携带纠正要求
      const secondCall = ctx.createSession.mock.calls[1][0] as { userMessage: string }
      expect(secondCall.userMessage).toContain('重试要求')
      expect(secondCall.userMessage).toContain('第一个字符必须是')
    })

    it('lastErrorReason 记录解析失败原因供 UI 透出', async () => {
      const ctx = makeMockContext('纯散文，没有任何大括号')
      const moderator = new Moderator(ctx as any)
      await moderator.decide(goal, history, actingMembers, actingState)
      expect(moderator.lastErrorReason).toContain('JSON')
    })
  })
})
