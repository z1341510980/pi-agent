import { describe, expect, it, vi } from 'vitest'
import { TeamDiscussionEngine } from '../core/agent/team-discussion-engine.js'
import { Moderator, type ModeratorContext } from '../core/agent/moderator.js'
import { AgentChannel } from '../core/agent/agent-channel.js'
import type {
  DiscussionGoal,
  DiscussionMember,
  DiscussionMessage,
  DiscussionOptions,
  ModeratorDecision,
} from '../core/agent/discussion-types.js'

function makeMember(overrides: Partial<DiscussionMember> = {}): DiscussionMember {
  return {
    id: 'test-agent',
    type: 'role',
    name: '测试',
    expertise: '测试',
    canConverge: false,
    buildSystemPrompt: () => 'system prompt',
    ...overrides,
  }
}

function makeOptions(overrides: Partial<DiscussionOptions> = {}): DiscussionOptions {
  return {
    emit: vi.fn(),
    onCheckpoint: vi.fn().mockResolvedValue('approve'),
    onProgress: vi.fn(),
    ...overrides,
  }
}

/** mock Moderator：按预设序列返回决策 */
function makeMockModerator(decisions: ModeratorDecision[]): Moderator {
  let index = 0
  const ctx: ModeratorContext = {
    createSession: vi.fn().mockResolvedValue({
      prompt: vi.fn().mockImplementation(async () => {
        const d = decisions[index] ?? decisions[decisions.length - 1]
        index++
        return JSON.stringify(d)
      }),
      dispose: vi.fn(),
    }),
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
  }
  return new Moderator(ctx)
}

/** mock 引擎上下文（createAgUiSession 工厂） */
function makeMockEngineContext() {
  return {
    createAgUiSession: vi.fn().mockResolvedValue({
      session: { prompt: vi.fn().mockResolvedValue('成员发言内容') },
      streamEmitter: { finishTextMessage: vi.fn() },
      messageId: 'msg-test',
      dispose: vi.fn(),
    }),
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
  }
}

describe('TeamDiscussionEngine', () => {
  const goal: DiscussionGoal = { task: '测试任务', context: '上下文' }

  it('执行 invite → converge(chapter) 完整流程', async () => {
    const members = [
      makeMember({ id: 'director', name: '导演' }),
      makeMember({ id: 'writer', name: '写作', canConverge: true }),
    ]
    const decisions: ModeratorDecision[] = [
      { type: 'invite', agentId: 'director', prompt: '规划', reason: '开始' },
      { type: 'converge', agentId: 'writer', scope: 'chapter', reason: '完成' },
    ]
    const moderator = makeMockModerator(decisions)
    const channel = new AgentChannel()
    const ctx = makeMockEngineContext()
    const engine = new TeamDiscussionEngine(moderator, channel, ctx as any)

    const result = await engine.run(goal, members, makeOptions())
    expect(result.status).toBe('completed')
    expect(result.transcript.length).toBeGreaterThanOrEqual(2)
  })

  it('pause 流程：onCheckpoint 被调用，用户回复后继续', async () => {
    const members = [makeMember({ id: 'director', name: '导演' })]
    const decisions: ModeratorDecision[] = [
      { type: 'pause', question: '确认？', reason: '需确认' },
      { type: 'converge', agentId: 'director', scope: 'chapter', reason: '完成' },
    ]
    const moderator = makeMockModerator(decisions)
    const channel = new AgentChannel()
    const ctx = makeMockEngineContext()
    const engine = new TeamDiscussionEngine(moderator, channel, ctx as any)

    const onCheckpoint = vi.fn().mockResolvedValue('approve')
    const result = await engine.run(goal, members, makeOptions({ onCheckpoint }))
    expect(onCheckpoint).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('completed')
  })

  it('死锁防护：连续 observe 超限后强制 converge', async () => {
    const members = [
      makeMember({ id: 'director', name: '导演' }),
      makeMember({ id: 'writer', name: '写作', canConverge: true }),
    ]
    const decisions: ModeratorDecision[] = Array(10).fill({
      type: 'observe' as const,
      reason: '等待',
    })
    const moderator = makeMockModerator(decisions)
    const channel = new AgentChannel()
    const ctx = makeMockEngineContext()
    const engine = new TeamDiscussionEngine(moderator, channel, ctx as any)

    const result = await engine.run(goal, members, makeOptions())
    expect(result.status).toBe('completed')
    expect(result.transcript.length).toBeGreaterThan(0)
  })

  it('总轮数超限后强制 converge', async () => {
    const members = [
      makeMember({ id: 'director', name: '导演' }),
      makeMember({ id: 'writer', name: '写作', canConverge: true }),
    ]
    const decisions: ModeratorDecision[] = Array(30).fill({
      type: 'invite' as const,
      agentId: 'director',
      prompt: '继续',
      reason: '继续',
    })
    const moderator = makeMockModerator(decisions)
    const channel = new AgentChannel()
    const ctx = makeMockEngineContext()
    const engine = new TeamDiscussionEngine(moderator, channel, ctx as any)

    const result = await engine.run(goal, members, makeOptions())
    expect(result.status).toBe('completed')
  })

  it('成员发言失败时记录错误并继续', async () => {
    const members = [
      makeMember({ id: 'director', name: '导演' }),
      makeMember({ id: 'writer', name: '写作', canConverge: true }),
    ]
    const decisions: ModeratorDecision[] = [
      { type: 'invite', agentId: 'director', prompt: '规划', reason: '开始' },
      { type: 'converge', agentId: 'writer', scope: 'chapter', reason: '完成' },
    ]
    const moderator = makeMockModerator(decisions)
    const channel = new AgentChannel()
    const ctx = {
      createAgUiSession: vi.fn().mockRejectedValue(new Error('LLM 超时')),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
    }
    const engine = new TeamDiscussionEngine(moderator, channel, ctx as any)

    const result = await engine.run(goal, members, makeOptions())
    expect(result.transcript.some(m => m.type === 'error')).toBe(true)
  })

  it('场景循环：Director 拆场 → 角色演出 → Writer 整理', async () => {
    const members = [
      makeMember({ id: 'novel-director', name: '导演' }),
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
      makeMember({ id: 'char-1', name: '赵岩', type: 'character' }),
    ]
    // Director 输出含场景拆分
    const directorOutput = `### 场景 1：客厅对峙
- 地点：客厅
- 时间：傍晚
- 在场角色：赵岩
- 冲突：父子冲突
- 目标：展现对立`
    // mock createAgUiSession 第一次返回 directorOutput，之后返回普通内容
    let callCount = 0
    const ctx = {
      createAgUiSession: vi.fn().mockImplementation(async () => {
        callCount++
        return {
          session: { prompt: vi.fn().mockResolvedValue(callCount === 1 ? directorOutput : '成员发言') },
          streamEmitter: { finishTextMessage: vi.fn() },
          messageId: 'msg-test',
          dispose: vi.fn(),
        }
      }),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
    }
    // Moderator 决策序列：invite director → converge(chapter) → (场景1) invite char-1 → converge(scene) → converge(chapter)
    const moderatorDecisions: ModeratorDecision[] = [
      { type: 'invite', agentId: 'novel-director', prompt: '规划', reason: '开始' },
      { type: 'converge', agentId: 'novel-writer', scope: 'chapter', reason: '规划完成' },
      // Phase 2 场景 1
      { type: 'invite', agentId: 'char-1', prompt: '演出', reason: '角色发言' },
      { type: 'converge', agentId: 'novel-writer', scope: 'scene', reason: '场景演完' },
      // Phase 3
      { type: 'converge', agentId: 'novel-writer', scope: 'chapter', reason: '全章完成' },
    ]
    const moderator = makeMockModerator(moderatorDecisions)
    const channel = new AgentChannel()
    const engine = new TeamDiscussionEngine(moderator, channel, ctx as any)

    const result = await engine.run(goal, members, makeOptions())
    expect(result.status).toBe('completed')
    expect(result.scenes.length).toBe(1)
    expect(result.scenes[0].title).toBe('客厅对峙')
  })

  it('只解析 Director 的场景规划，不受后续成员发言干扰', () => {
    const members = [
      makeMember({ id: 'novel-director', name: '导演' }),
      makeMember({ id: 'char-1', name: '赵岩', type: 'character' }),
    ]
    const history: DiscussionMessage[] = [
      {
        id: 'director-plan',
        fromId: 'novel-director',
        fromName: '导演',
        type: 'member',
        timestamp: 1,
        content: `### 场景1：客厅对峙\n- 地点：客厅\n- 时间：夜\n- 在场角色：赵岩\n- 目标：推进冲突`,
      },
      {
        id: 'character-reply',
        fromId: 'char-1',
        fromName: '赵岩',
        type: 'member',
        timestamp: 2,
        content: '[攥拳] "我不同意。"',
      },
    ]
    const engine = new TeamDiscussionEngine(makeMockModerator([]), new AgentChannel(), makeMockEngineContext() as any)

    const scenes = (engine as any).parseScenes(history, members)

    expect(scenes).toHaveLength(1)
    expect(scenes[0].presentCharacters).toEqual(['char-1'])
  })

  it('Director 提到未注册角色时动态创建对应 Agent，且不拉入其他角色', async () => {
    const members = [
      makeMember({ id: 'novel-director', name: '导演' }),
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
      makeMember({ id: 'char-bystander', name: '路人', type: 'character' }),
    ]
    const directorOutput = `### 场景1：父子对峙
- 地点：客厅
- 时间：夜
- 在场角色：赵父
- 冲突：父子冲突
- 目标：逼问真相`
    const prompts: string[] = []
    let callCount = 0
    const ctx = {
      createAgUiSession: vi.fn().mockImplementation(async (opts: { userMessage: string }) => {
        prompts.push(opts.userMessage)
        callCount++
        return {
          session: { prompt: vi.fn().mockResolvedValue(callCount === 1 ? directorOutput : '成员发言') },
          streamEmitter: { finishTextMessage: vi.fn() },
          messageId: `msg-${callCount}`,
          dispose: vi.fn(),
        }
      }),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
    }
    const moderator = makeMockModerator([
      { type: 'invite', agentId: 'novel-director', prompt: '规划', reason: '开始' },
      { type: 'converge', agentId: 'novel-writer', scope: 'chapter', reason: '规划完成' },
      { type: 'invite', agentId: 'char-temp-father', prompt: '演出', reason: '角色发言' },
      { type: 'converge', agentId: 'novel-writer', scope: 'scene', reason: '场景演完' },
    ])
    const engine = new TeamDiscussionEngine(moderator, new AgentChannel(), ctx as any)
    const resolveCharacterMembers = vi.fn().mockReturnValue([
      makeMember({ id: 'char-temp-father', name: '赵父', type: 'character' }),
    ])

    const result = await engine.run(goal, members, makeOptions({ resolveCharacterMembers }))

    expect(resolveCharacterMembers).toHaveBeenCalledWith(['赵父'])
    expect(result.scenes[0].presentCharacters).toEqual(['char-temp-father'])
    expect(result.transcript.some(m => m.fromId === 'char-temp-father')).toBe(true)
    expect(result.transcript.some(m => m.fromId === 'char-bystander')).toBe(false)
    expect(prompts.some(prompt => prompt.includes('父子对峙'))).toBe(true)
  })

  it('角色重发包含原始发言，内部审查不产生可见 agent_start', async () => {
    const members = [
      makeMember({ id: 'novel-director', name: '导演' }),
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
      makeMember({ id: 'novel-reviewer', name: '审稿' }),
      makeMember({ id: 'char-1', name: '赵岩', type: 'character' }),
    ]
    const directorOutput = `### 场景1：对峙\n- 地点：客厅\n- 时间：夜\n- 在场角色：赵岩\n- 目标：推进冲突`
    const rewriteInputs: string[] = []
    let callCount = 0
    const outputs = [
      directorOutput,
      '[低头] "都听您的。"',
      JSON.stringify({
        verdict: 'request_rewrite',
        issues: ['违背刚烈性格'],
        rewrite_suggestion: '改为明确反驳',
        reason: '人设不一致',
      }),
      '[抬头直视] "这件事我绝不退。"',
      '完整章节正文',
      '## 结论：accept',
    ]
    const ctx = {
      createAgUiSession: vi.fn().mockImplementation(async (opts: { userMessage: string }) => {
        rewriteInputs.push(opts.userMessage)
        const output = outputs[callCount++] ?? '完整章节正文'
        return {
          session: { prompt: vi.fn().mockResolvedValue(output) },
          streamEmitter: { finishTextMessage: vi.fn() },
          messageId: `msg-${callCount}`,
          dispose: vi.fn(),
        }
      }),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
    }
    const moderator = makeMockModerator([
      { type: 'invite', agentId: 'novel-director', prompt: '规划', reason: '开始' },
      { type: 'converge', agentId: 'novel-writer', scope: 'chapter', reason: '规划完成' },
      { type: 'invite', agentId: 'char-1', prompt: '演出', reason: '角色发言' },
      { type: 'converge', agentId: 'novel-writer', scope: 'scene', reason: '场景演完' },
    ])
    const onProgress = vi.fn()
    const engine = new TeamDiscussionEngine(moderator, new AgentChannel(), ctx as any)

    await engine.run(goal, members, makeOptions({ onProgress }))

    expect(rewriteInputs[3]).toContain('[低头] "都听您的。"')
    const reviewerStarts = onProgress.mock.calls
      .map(([event]) => event)
      .filter(event => event.type === 'agent_start' && event.data.agentId === 'novel-reviewer')
    expect(reviewerStarts).toHaveLength(1)
  })
})
