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

  it('角色成员只读取私有上下文，不继承工种全知上下文', async () => {
    const createAgUiSession = vi.fn().mockResolvedValue({
      session: { prompt: vi.fn().mockResolvedValue('[抬眼] “我只按自己知道的事回答。”') },
      streamEmitter: { finishTextMessage: vi.fn() },
      messageId: 'private-context',
      dispose: vi.fn(),
    })
    const engine = new TeamDiscussionEngine(
      makeMockModerator([]),
      new AgentChannel(),
      { createAgUiSession, logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } } as any,
    ) as any
    engine.currentGoal = { task: '测试', context: '作者真相：凶手是父亲' }
    const member = makeMember({
      id: 'char-1',
      type: 'character',
      buildContextPrompt: () => '角色已知：门昨晚开过',
    })

    await engine.invokeMember(member, '回应', [], makeOptions(), { phase: 'acting', sceneId: 1 })

    expect(createAgUiSession).toHaveBeenCalledWith(expect.objectContaining({
      prefixUserMessage: '角色已知：门昨晚开过',
    }))
    expect(JSON.stringify(createAgUiSession.mock.calls[0][0])).not.toContain('凶手是父亲')
  })

  it('角色提纲输出会被归一化为动作和台词，不直接流入 Writer', () => {
    const engine = new TeamDiscussionEngine(
      makeMockModerator([]), new AgentChannel(), makeMockEngineContext() as any,
    ) as any
    const outline = '意图：拖延时间\n心理：担心秘密暴露\n应对：我需要先确认门外是谁。'

    expect(engine.isValidCharacterSpeech(outline)).toBe(false)
    expect(engine.normalizeCharacterSpeech(outline, '赵岩')).toBe('[赵岩看向对方] “我需要先确认门外是谁。”')
    expect(engine.isValidCharacterSpeech('[赵岩看向对方] “我需要先确认门外是谁。”')).toBe(true)
  })

  it('合并角色调用注入每个角色的身份，并记录全部参与者', async () => {
    const members = [
      makeMember({
        id: 'char-a', type: 'character', name: '林晚', knowledge: {},
        buildSystemPrompt: () => '角色 system',
        buildContextPrompt: () => '共同可见背景',
        buildIdentityPrompt: () => '林晚身份和短句说话风格',
      }),
      makeMember({
        id: 'char-b', type: 'character', name: '陆川', knowledge: {},
        buildSystemPrompt: () => '角色 system',
        buildContextPrompt: () => '共同可见背景',
        buildIdentityPrompt: () => '陆川身份和长句说话风格',
      }),
    ]
    const createAgUiSession = vi.fn().mockResolvedValue({
      session: { prompt: vi.fn().mockResolvedValue('### 林晚\n[抬眼] “我先说。”\n### 陆川\n[按住门] “让我补充。”') },
      streamEmitter: { finishTextMessage: vi.fn() },
      messageId: 'merged-actors',
      dispose: vi.fn(),
    })
    const onMemberInvocation = vi.fn()
    const engine = new TeamDiscussionEngine(
      makeMockModerator([]),
      new AgentChannel(),
      { createAgUiSession, logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } } as any,
    ) as any
    engine.currentGoal = { task: '测试', context: '作者真相' }
    const history: DiscussionMessage[] = []

    const handled = await engine.handleMergedInvite(
      { type: 'invite', agentId: 'char-a', agentIds: ['char-a', 'char-b'], prompt: '回应', reason: '同场' },
      ['char-a', 'char-b'], members, history,
      makeOptions({ reviewCharacterSpeech: false, onMemberInvocation }),
      'test-channel', { phase: 'acting', sceneId: 1 },
    )

    expect(handled).toBe(true)
    expect(createAgUiSession).toHaveBeenCalledTimes(1)
    expect(createAgUiSession).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: '角色 system',
      prefixUserMessage: [
        '共同可见背景',
        expect.stringContaining('林晚身份和短句说话风格'),
      ],
    }))
    expect(JSON.stringify(createAgUiSession.mock.calls[0][0].prefixUserMessage)).toContain('陆川身份和长句说话风格')
    expect(JSON.stringify(createAgUiSession.mock.calls[0][0])).not.toContain('作者真相')
    expect(history.filter(message => message.type === 'member').map(message => message.fromId)).toEqual(['char-a', 'char-b'])
    expect(onMemberInvocation).toHaveBeenCalledWith(expect.objectContaining({
      participantIds: ['char-a', 'char-b'],
      participantNames: ['林晚', '陆川'],
    }))
  })

  it('角色上下文不同或缺少认知快照时逐个调用全部被点名角色', async () => {
    const members = [
      makeMember({
        id: 'char-a', type: 'character', name: '林晚', knowledge: {},
        buildContextPrompt: () => '林晚可见背景', buildIdentityPrompt: () => '林晚身份',
      }),
      makeMember({
        id: 'char-b', type: 'character', name: '陆川', knowledge: {},
        buildContextPrompt: () => '陆川可见背景', buildIdentityPrompt: () => '陆川身份',
      }),
      makeMember({
        id: 'char-c', type: 'character', name: '苏遥', knowledge: undefined,
        buildContextPrompt: () => '苏遥可见背景', buildIdentityPrompt: () => '苏遥身份',
      }),
    ]
    const createAgUiSession = vi.fn().mockImplementation(async (opts: { prefixUserMessage?: string | string[] }) => ({
      session: {
        prompt: vi.fn().mockResolvedValue(
          `[看向众人] “${Array.isArray(opts.prefixUserMessage) ? opts.prefixUserMessage[0] : opts.prefixUserMessage}。”`,
        ),
      },
      streamEmitter: { finishTextMessage: vi.fn() },
      messageId: 'single-actor',
      dispose: vi.fn(),
    }))
    const engine = new TeamDiscussionEngine(
      makeMockModerator([]), new AgentChannel(),
      { createAgUiSession, logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } } as any,
    ) as any
    const history: DiscussionMessage[] = []

    await engine.handleMergedInvite(
      { type: 'invite', agentId: 'char-a', agentIds: members.map(member => member.id), prompt: '回应', reason: '同场' },
      members.map(member => member.id), members, history,
      makeOptions({ reviewCharacterSpeech: false }),
      'test-channel', { phase: 'acting', sceneId: 1 },
    )

    expect(createAgUiSession).toHaveBeenCalledTimes(3)
    expect(createAgUiSession.mock.calls.map(([opts]) => opts.prefixUserMessage)).toEqual([
      ['林晚可见背景', '林晚身份'],
      ['陆川可见背景', '陆川身份'],
      ['苏遥可见背景', '苏遥身份'],
    ])
    expect(history.filter(message => message.type === 'member').map(message => message.fromId)).toEqual([
      'char-a', 'char-b', 'char-c',
    ])
  })

  it('身份含私密信息的角色即使认知和上下文相同也逐个调用', async () => {
    const members = [
      makeMember({
        id: 'char-a', type: 'character', name: '林晚', knowledge: {},
        allowMergedInvocation: false,
        buildContextPrompt: () => '共同可见背景', buildIdentityPrompt: () => '隐藏秘密：卧底',
      }),
      makeMember({
        id: 'char-b', type: 'character', name: '陆川', knowledge: {},
        buildContextPrompt: () => '共同可见背景', buildIdentityPrompt: () => '陆川身份',
      }),
    ]
    const createAgUiSession = vi.fn().mockResolvedValue({
      session: { prompt: vi.fn().mockResolvedValue('[看向对方] “我只说自己知道的事。”') },
      streamEmitter: { finishTextMessage: vi.fn() },
      messageId: 'private-identity',
      dispose: vi.fn(),
    })
    const engine = new TeamDiscussionEngine(
      makeMockModerator([]), new AgentChannel(),
      { createAgUiSession, logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } } as any,
    ) as any
    const history: DiscussionMessage[] = []

    await engine.handleMergedInvite(
      { type: 'invite', agentId: 'char-a', agentIds: ['char-a', 'char-b'], prompt: '回应' },
      ['char-a', 'char-b'], members, history,
      makeOptions({ reviewCharacterSpeech: false }),
      'test-channel', { phase: 'acting', sceneId: 1 },
    )

    expect(createAgUiSession).toHaveBeenCalledTimes(2)
    expect(createAgUiSession.mock.calls.map(([opts]) => opts.prefixUserMessage)).toEqual([
      ['共同可见背景', '隐藏秘密：卧底'],
      ['共同可见背景', '陆川身份'],
    ])
    expect(history.filter(message => message.type === 'member').map(message => message.fromId)).toEqual([
      'char-a', 'char-b',
    ])
  })

  it('合并调用失败或缺少角色分段时逐角色回退', async () => {
    const members = [
      makeMember({
        id: 'char-a', type: 'character', name: '林晚', knowledge: {},
        buildContextPrompt: () => '共同背景', buildIdentityPrompt: () => '林晚身份',
      }),
      makeMember({
        id: 'char-b', type: 'character', name: '陆川', knowledge: {},
        buildContextPrompt: () => '共同背景', buildIdentityPrompt: () => '陆川身份',
      }),
    ]
    let callCount = 0
    const createAgUiSession = vi.fn().mockImplementation(async () => {
      callCount++
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            if (callCount === 1) throw new Error('合并调用超时')
            return '[看向对方] “单独回应。”'
          }),
        },
        streamEmitter: { finishTextMessage: vi.fn() },
        messageId: `fallback-${callCount}`,
        dispose: vi.fn(),
      }
    })
    const engine = new TeamDiscussionEngine(
      makeMockModerator([]), new AgentChannel(),
      { createAgUiSession, logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } } as any,
    ) as any
    const history: DiscussionMessage[] = []

    await engine.handleMergedInvite(
      { type: 'invite', agentId: 'char-a', agentIds: ['char-a', 'char-b'], prompt: '回应' },
      ['char-a', 'char-b'], members, history,
      makeOptions({ reviewCharacterSpeech: false }),
      'test-channel', { phase: 'acting', sceneId: 1 },
    )

    expect(createAgUiSession).toHaveBeenCalledTimes(3)
    expect(history.filter(message => message.type === 'member').map(message => message.fromId)).toEqual([
      'char-a', 'char-b',
    ])
  })

  it('合并输出的每个角色分段仍分别经过 Reviewer', async () => {
    const reviewer = makeMember({ id: 'novel-reviewer', name: '审稿' })
    const members = [
      reviewer,
      makeMember({
        id: 'char-a', type: 'character', name: '林晚', knowledge: {},
        buildContextPrompt: () => '共同背景', buildIdentityPrompt: () => '林晚身份',
      }),
      makeMember({
        id: 'char-b', type: 'character', name: '陆川', knowledge: {},
        buildContextPrompt: () => '共同背景', buildIdentityPrompt: () => '陆川身份',
      }),
    ]
    const createAgUiSession = vi.fn().mockResolvedValue({
      session: { prompt: vi.fn().mockResolvedValue('### 林晚\n[抬眼] “我先说。”\n### 陆川\n[按住门] “我回应。”') },
      streamEmitter: { finishTextMessage: vi.fn() },
      messageId: 'merged-review',
      dispose: vi.fn(),
    })
    const engine = new TeamDiscussionEngine(
      makeMockModerator([]), new AgentChannel(),
      { createAgUiSession, logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } } as any,
    ) as any
    engine.reviewCharacterSpeech = vi.fn().mockResolvedValue({
      verdict: 'pass', issues: [], rewrite_suggestion: '', reason: '',
    })

    await engine.handleMergedInvite(
      { type: 'invite', agentId: 'char-a', agentIds: ['char-a', 'char-b'], prompt: '回应' },
      ['char-a', 'char-b'], members, [], makeOptions(),
      'test-channel', { phase: 'acting', sceneId: 1 },
    )

    expect(createAgUiSession).toHaveBeenCalledTimes(1)
    expect(engine.reviewCharacterSpeech).toHaveBeenCalledTimes(2)
    expect(engine.reviewCharacterSpeech.mock.calls.map(([member]: [DiscussionMember]) => member.id)).toEqual([
      'char-a', 'char-b',
    ])
  })

  it('群聊 Reviser 通过业务层工具化修订（buildReviserToolset）应用修改', async () => {
    const engine = new TeamDiscussionEngine(
      makeMockModerator([]), new AgentChannel(), makeMockEngineContext() as any,
    ) as any
    engine.invokeMember = vi.fn()
      .mockResolvedValueOnce('盲审：需要修订')
      .mockResolvedValueOnce('## 结论：revise')
      .mockResolvedValueOnce('Reviser 已调用 novel_apply_revision 工具')
    // ⚠️ 工具化方案：业务层通过 buildReviserToolset 提供 draft + 工具。
    // 引擎把工具注入 Reviser 的 LLM 调用，Reviser 调用工具修改 draft.content，
    // 引擎在 Reviser 结束后调用 extractResult() 得到最终正文。
    // 旧 applyRevision 回调让 Reviser 输出"原文/修改后"配对文本再正则解析，
    // 已被工具化方案替代。
    const extractResult = vi.fn().mockReturnValue({
      content: '第一段。\n\n新句。',
      appliedPatchCount: 1,
      successCount: 1,
      mode: 'patch' as const,
    })
    const buildReviserToolset = vi.fn().mockImplementation((originalContent: string) => ({
      tools: [{ name: 'novel_apply_revision' }],
      extractResult,
    }))

    const result = await engine.reviewFinalChapter(
      '第一段。\n\n旧句。',
      [
        makeMember({ id: 'novel-reviewer', name: '审稿' }),
        makeMember({ id: 'novel-reviser', name: '修订', canConverge: true }),
      ],
      [],
      makeOptions({
        onCheckpoint: vi.fn().mockResolvedValue('revise'),
        buildReviserToolset,
      }),
    )

    // 引擎必须用原章节正文调用工厂
    expect(buildReviserToolset).toHaveBeenCalledWith('第一段。\n\n旧句。')
    // 工具集必须传递给 invokeMember 的 ctx.extraTools
    const reviserCall = engine.invokeMember.mock.calls[2]
    expect(reviserCall[4].extraTools).toEqual([{ name: 'novel_apply_revision' }])
    // Reviser 提示词必须强制工具调用，禁止输出"原文/修改后"配对
    expect(reviserCall[1]).toContain('novel_apply_revision')
    expect(reviserCall[1]).not.toContain('只输出需要替换的"原文/修改后"配对')
    // 引擎必须调用 extractResult 取得最终正文
    expect(extractResult).toHaveBeenCalled()
    expect(result.content).toBe('第一段。\n\n新句。')
  })

  it('业务层未提供 buildReviserToolset 时，群聊 Reviser 修订不应用，保留原正文', async () => {
    const engine = new TeamDiscussionEngine(
      makeMockModerator([]), new AgentChannel(), makeMockEngineContext() as any,
    ) as any
    engine.invokeMember = vi.fn()
      .mockResolvedValueOnce('盲审：需要修订')
      .mockResolvedValueOnce('## 结论：revise')
      // 模拟旧模式：Reviser 输出"原文/修改后"配对文本（不会被引擎解析）
      .mockResolvedValueOnce('原文：\n旧句。\n\n修改后：\n新句。')

    const result = await engine.reviewFinalChapter(
      '第一段。\n\n旧句。',
      [
        makeMember({ id: 'novel-reviewer', name: '审稿' }),
        makeMember({ id: 'novel-reviser', name: '修订', canConverge: true }),
      ],
      [],
      makeOptions({
        onCheckpoint: vi.fn().mockResolvedValue('revise'),
        // 不提供 buildReviserToolset：引擎应保留原正文，不把 Reviser 文本当作正文落库
      }),
    )

    // 关键安全保证：未走工具化路径时，原正文保留，"修改意见"不会覆盖正文
    expect(result.content).toBe('第一段。\n\n旧句。')
  })

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

  it('群聊质量门不因正文达到目标 80% 就自动重写', () => {
    const engine = new TeamDiscussionEngine(
      makeMockModerator([]), new AgentChannel(), makeMockEngineContext() as any,
    )
    const content = Array.from({ length: 2400 }, (_, index) =>
      String.fromCodePoint(0x4e00 + (index % 1800)),
    ).join('')

    const result = (engine as any).runDiscussionPostWriteGuard(content, 3000)

    expect(result.shouldRewrite).toBe(false)
  })

  it('群聊质量门拦截只输出写作说明而没有正文的结果', () => {
    const engine = new TeamDiscussionEngine(
      makeMockModerator([]), new AgentChannel(), makeMockEngineContext() as any,
    )
    const content = '我将先核对人物设定、章节目标和矩阵约束，然后按照导演方案分场景展开，确保冲突升级、伏笔推进和结尾钩子都得到落实。'.repeat(4)

    const result = (engine as any).runDiscussionPostWriteGuard(content)

    expect(result.shouldRewrite).toBe(true)
    expect(result.reason).toBe('模型未输出正文')
  })

  it('群聊重写结果退化为写作说明时保留原正文', async () => {
    const engine = new TeamDiscussionEngine(
      makeMockModerator([]), new AgentChannel(), makeMockEngineContext() as any,
    ) as any
    const original = Array.from({ length: 20 }, (_, i) => `第${i + 1}段是各不相同的场景描写和人物行动。`).join('\n')
    engine.invokeMember = vi.fn().mockResolvedValue(
      '我将先核对章纲、矩阵和导演方案，然后确保冲突、伏笔、钩子全部落实，再输出完整正文。'.repeat(4),
    )

    const result = await engine.guardAndMaybeRewrite(
      original,
      makeMember({ id: 'novel-writer', canConverge: true }),
      '写正文',
      makeOptions(),
      undefined,
      ['李四'],
    )

    expect(result).toBe(original)
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
      '盲审：人物声音成立',
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
    expect(reviewerStarts).toHaveLength(2)
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
    const outputs = [recoveredContent, '盲审：通过', '## 结论：accept']
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
    expect(prompts).toHaveLength(3)
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
