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
function makeMockEngineContext(): Record<string, unknown> {
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

  it('群聊质量门拦截正文遗漏的矩阵实体', () => {
    const engine = new TeamDiscussionEngine(
      makeMockModerator([]), new AgentChannel(), makeMockEngineContext() as any,
    )
    const content = Array.from({ length: 20 }, (_, i) => `第${i + 1}段是各不相同的场景描写和人物行动。`).join('\n')

    const result = (engine as any).runDiscussionPostWriteGuard(content, undefined, ['李四'])

    expect(result.shouldRewrite).toBe(true)
    expect(result.reason).toBe('未完整执行矩阵编排')
    expect(result.details).toContain('李四')
  })

  it('每次成员调用完成后发送完整审计信息', async () => {
    const member = makeMember({
      id: 'novel-director',
      name: '导演',
      modelId: { provider: 'xai', modelId: 'grok-4' },
    })
    const moderator = makeMockModerator([{ type: 'observe', reason: '等待' }])
    const ctx = makeMockEngineContext()
    const engine = new TeamDiscussionEngine(moderator, new AgentChannel(), ctx as any)
    const onMemberInvocation = vi.fn()

    const content = await (engine as any).invokeMember(
      member,
      '规划本章',
      [],
      makeOptions({ onMemberInvocation }),
      { phase: 'planning' },
    )

    expect(content).toBe('成员发言内容')
    expect(ctx.createAgUiSession).toHaveBeenCalledWith(expect.objectContaining({
      modelId: { provider: 'xai', modelId: 'grok-4' },
    }))
    expect(onMemberInvocation).toHaveBeenCalledWith(expect.objectContaining({
      member,
      phase: 'planning',
      chapterContext: '',
      userMessage: expect.stringContaining('规划本章'),
      result: '成员发言内容',
      status: 'success',
    }))
  })

  it('共享上下文只作为缓存前缀发送一次，成员身份位于共享前缀之后', async () => {
    const members = [
      makeMember({
        id: 'novel-director',
        name: '导演',
        buildSystemPrompt: () => '共享 system',
        buildIdentityPrompt: () => '导演身份',
      }),
      makeMember({
        id: 'novel-writer',
        name: '写作',
        canConverge: true,
        buildSystemPrompt: () => '共享 system',
        buildIdentityPrompt: () => '写作身份',
      }),
    ]
    const moderator = makeMockModerator([
      { type: 'invite', agentId: 'novel-director', prompt: '规划', reason: '开始' },
      { type: 'converge', agentId: 'novel-writer', scope: 'chapter', reason: '完成' },
    ])
    const calls: Array<{ systemPrompt: string; prefixUserMessage?: string | string[]; userMessage: string }> = []
    const ctx = {
      createAgUiSession: vi.fn().mockImplementation(async (opts) => {
        calls.push(opts)
        return {
          session: { prompt: vi.fn().mockResolvedValue('成员发言内容') },
          streamEmitter: { finishTextMessage: vi.fn() },
          messageId: 'msg-cache',
          dispose: vi.fn(),
        }
      }),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
    }
    const engine = new TeamDiscussionEngine(moderator, new AgentChannel(), ctx as any)

    await engine.run(goal, members, makeOptions())

    const directorCall = calls[0]
    expect(directorCall.systemPrompt).toBe('共享 system')
    expect(directorCall.prefixUserMessage).toEqual(['上下文', '导演身份'])
    expect(directorCall.userMessage).not.toContain('上下文')
    expect(directorCall.userMessage.match(/上下文/g)).toBeNull()
  })

  it('把 provider 返回的缓存 usage 透传给成员调用日志', async () => {
    const member = makeMember({ id: 'novel-director', name: '导演' })
    const onMemberInvocation = vi.fn()
    let usageListener: ((event: Record<string, unknown>) => void) | undefined
    const ctx = {
      createAgUiSession: vi.fn().mockResolvedValue({
        session: {
          subscribe: vi.fn((listener) => {
            usageListener = listener
            return vi.fn()
          }),
          prompt: vi.fn().mockImplementation(async () => {
            usageListener?.({
              type: 'message_end',
              message: {
                role: 'assistant',
                provider: 'anthropic',
                model: 'claude-test',
                usage: { input: 1200, output: 300, cacheRead: 900, cacheWrite: 100 },
              },
            })
            return '规划结果'
          }),
        },
        streamEmitter: { finishTextMessage: vi.fn() },
        messageId: 'msg-usage',
        dispose: vi.fn(),
      }),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
    }
    const engine = new TeamDiscussionEngine(makeMockModerator([]), new AgentChannel(), ctx as any)

    await (engine as any).invokeMember(
      member,
      '规划本章',
      [],
      makeOptions({ onMemberInvocation }),
      { phase: 'planning' },
    )

    expect(onMemberInvocation).toHaveBeenCalledWith(expect.objectContaining({
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 900,
      cacheWriteTokens: 100,
      llmProvider: 'anthropic',
      llmModel: 'claude-test',
    }))
  })

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

  it('从 chapter_weaving 快照恢复时跳过 Moderator 和角色推演', async () => {
    const members = [
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
      makeMember({ id: 'novel-reviewer', name: '审稿' }),
      makeMember({ id: 'char-1', name: '叶明远', type: 'character' }),
    ]
    const prompts: string[] = []
    // 正文需超过 PostWriteGuard 的 100 字下限，否则测试会进入重写分支。
    const recoveredContent = '矿道深处传来碎石滚落声，叶明远稳住呼吸，沿着石壁继续向前。'.repeat(5)
    const outputs = [recoveredContent, '## 结论：accept']
    let callCount = 0
    const ctx = {
      createAgUiSession: vi.fn().mockImplementation(async (opts: { userMessage: string }) => {
        prompts.push(opts.userMessage)
        return {
          session: { prompt: vi.fn().mockResolvedValue(outputs[callCount++] ?? '') },
          streamEmitter: { finishTextMessage: vi.fn() },
          messageId: `resume-msg-${callCount}`,
          dispose: vi.fn(),
        }
      }),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
    }
    const moderator = makeMockModerator([])
    const decide = vi.spyOn(moderator, 'decide')
    const engine = new TeamDiscussionEngine(moderator, new AgentChannel(), ctx as any)

    const result = await engine.resumeChapterWeaving(
      goal,
      members,
      makeOptions(),
      {
        phase: 'chapter_weaving',
        transcript: [{
          id: 'saved-role-line',
          fromId: 'char-1',
          fromName: '叶明远',
          content: '已保存的角色推演',
          timestamp: 1,
          type: 'member',
          sceneId: 1,
        }],
        scenes: [{
          sceneId: 1,
          title: '突破',
          location: '矿道',
          time: '夜',
          presentCharacters: ['char-1'],
          goal: '完成突破',
        }],
      },
    )

    expect(result.status).toBe('completed')
    expect(result.content).toBe(recoveredContent)
    expect(result.transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'saved-role-line' }),
      expect.objectContaining({ fromId: 'novel-writer', content: recoveredContent }),
      expect.objectContaining({ fromId: 'novel-reviewer', content: '## 结论：accept' }),
    ]))
    expect(decide).not.toHaveBeenCalled()
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain('已保存的角色推演')
  })

  it('中止信号会让群聊断点续跑返回 cancelled 并保留快照', async () => {
    const controller = new AbortController()
    controller.abort(new Error('用户手动停止'))
    const engine = new TeamDiscussionEngine(
      makeMockModerator([]),
      new AgentChannel(),
      {
        createAgUiSession: vi.fn().mockRejectedValue(controller.signal.reason),
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
      } as any,
    )
    const transcript: DiscussionMessage[] = [{
      id: 'saved-before-cancel',
      fromId: 'char-1',
      fromName: '叶明远',
      content: '已保存的推演',
      timestamp: 1,
      type: 'member',
      sceneId: 1,
    }]

    const result = await engine.resumeChapterWeaving(
      goal,
      [makeMember({ id: 'novel-writer', name: '写作', canConverge: true })],
      makeOptions({ signal: controller.signal }),
      {
        phase: 'chapter_weaving',
        transcript,
        scenes: [{
          sceneId: 1,
          title: '突破',
          location: '矿道',
          time: '夜',
          presentCharacters: ['char-1'],
          goal: '完成突破',
        }],
      },
    )

    expect(result.status).toBe('cancelled')
    expect(result.transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'saved-before-cancel' }),
    ]))
  })
})
