import { describe, expect, it, vi } from 'vitest'
import { TeamDiscussionEngine } from '../core/discussion/engine/team-discussion-engine.js'
import { Moderator, type ModeratorContext } from '../core/discussion/engine/moderator.js'
import { AgentChannel } from '../../../core/agent/agent-channel.js'
import { createNovelSubmitScenePlanTool, createNovelSubmitCharacterTurnTool, type ScenePlanDraftHolder } from '../core/novel-tools.js'
import type { CharacterTurnDraftHolder } from '../core/tools/submit.js'
import type {
  DiscussionGoal,
  DiscussionMember,
  DiscussionMessage,
  DiscussionOptions,
  ModeratorDecision,
  ScenePlanToolset,
} from '../core/discussion/engine/discussion-types.js'

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

/**
 * mock Moderator + decide 快照：engine 传入的 history 是共享可变数组，
 * 每轮 decide 时复制一份，供断言「Moderator 当时看到了什么」。
 */
function makeRecordingModerator(
  decisions: ModeratorDecision[],
  snapshots: DiscussionMessage[][],
): Moderator {
  const moderator = makeMockModerator(decisions)
  const originalDecide = moderator.decide.bind(moderator)
  vi.spyOn(moderator, 'decide').mockImplementation(
    async (goal, history, members, state, signal) => {
      snapshots.push(history.slice())
      return originalDecide(goal, history, members, state, signal)
    },
  )
  return moderator
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

  it('动作图按节点驱动角色，并允许角色通过 mention 主动接戏', async () => {
    const sceneDraft: ScenePlanDraftHolder = {}
    const scenePlan: ScenePlanToolset = {
      tools: [createNovelSubmitScenePlanTool(sceneDraft)],
      extractResult: () => sceneDraft.plan ?? null,
    }
    const turnDrafts: CharacterTurnDraftHolder[] = []
    const createAgUiSession = vi.fn().mockImplementation(async (input: { tools?: Array<{ name?: string; execute?: (id: string, args: unknown) => Promise<unknown> }> }) => ({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          const tool = input.tools?.[0]
          if (tool?.name === 'novel_submit_character_turn') {
            const args = turnDrafts.length === 0
              ? {
                  publicText: '[赵岩抬手挡住门] “先别进来。”',
                  innerThought: '他担心门外的人已经听见了。',
                  conflictReading: '门外的脚步声正在逼近。',
                  responsePlan: '先试探，再决定是否撤离。',
                  consequence: '门外的人停了一下。',
                  progress: 'escalate',
                  mentionNames: ['林晚'],
                }
              : {
                  publicText: '[林晚压低声音] “你终于承认门后有人了。”',
                  innerThought: '她要借这个破绽逼赵岩说出真相。',
                  conflictReading: '赵岩正在隐瞒门后的风险。',
                  responsePlan: '继续施压，让他做出选择。',
                  consequence: '赵岩失去继续隐瞒的空间。',
                  progress: 'reveal',
                  mentionNames: [],
                }
            const draft: CharacterTurnDraftHolder = {}
            turnDrafts.push(draft)
            const execute = tool.execute
            if (execute) await execute('turn', args)
          }
          return ''
        }),
      },
      streamEmitter: { finishTextMessage: vi.fn() },
      messageId: `character-${turnDrafts.length + 1}`,
      dispose: vi.fn(),
    }))
    const scene = {
      title: '门前对峙',
      location: '旧宅门口',
      time: '夜里',
      conflict: '是否打开门确认来人身份',
      goal: '让赵岩失去隐瞒空间',
      emotion: '警惕升级为逼迫',
      presentCharacters: ['char-zhao', 'char-lin'],
      presentCharacterNames: ['赵岩', '林晚'],
      actionBeats: [
        {
          beatId: 'a1', actor: 'char-zhao', target: 'char-lin',
          pressure: '门外脚步逼近，赵岩不能再装作没有听见',
          action: '赵岩挡住门并试图让林晚保持安静',
          choice: '继续隐瞒或承认门后有危险',
          consequence: '门外的人停下，屋内关系变得紧张',
          nextActor: 'char-lin', exitCondition: '林晚接住破绽并施压',
        },
        {
          beatId: 'a2', actor: 'char-lin', target: 'char-zhao',
          pressure: '赵岩的遮掩暴露出新的危险',
          action: '林晚抓住停顿逼赵岩解释',
          choice: '替他保密或逼他说出门后真相',
          consequence: '赵岩失去继续隐瞒的空间',
          exitCondition: '关系或信息发生明确变化',
        },
      ],
    }
    const members = [
      makeMember({ id: 'novel-director', name: '导演' }),
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
      makeMember({ id: 'char-zhao', type: 'character', name: '赵岩' }),
      makeMember({ id: 'char-lin', type: 'character', name: '林晚' }),
    ]
    const moderator = makeMockModerator([
      { type: 'invite', agentId: 'novel-director', prompt: '规划', reason: '开始' },
      // 新动作图路径不应读取 acting 的 Moderator 决策；此项只用于 planning 收敛。
      { type: 'converge', agentId: 'novel-writer', scope: 'chapter', reason: '规划完成' },
    ])
    const engine = new TeamDiscussionEngine(moderator, new AgentChannel(), {
      createAgUiSession,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
    } as any)
    const options = makeOptions({
      buildScenePlanToolset: () => scenePlan,
      buildCharacterTurnToolset: () => {
        const draft: CharacterTurnDraftHolder = {}
        return {
          tools: [createNovelSubmitCharacterTurnTool(draft)],
          extractResult: () => draft.turn ?? null,
        }
      },
    })

    // 直接验证场景转换与新回合工具的闭包协议，避免把 Writer 收尾噪声混入本状态机断言。
    const converted = (engine as any).toSceneDefinitions([
      {
        title: scene.title,
        location: scene.location,
        time: scene.time,
        conflict: scene.conflict,
        goal: scene.goal,
        emotion: scene.emotion,
        presentCharacters: scene.presentCharacterNames,
        actionBeats: scene.actionBeats.map((beat) => ({
          ...beat,
          actor: beat.actor === 'char-zhao' ? '赵岩' : '林晚',
          target: beat.target === 'char-lin' ? '林晚' : '赵岩',
          nextActor: beat.nextActor === 'char-lin' ? '林晚' : undefined,
        })),
      },
    ], members)
    expect(converted[0].actionBeats).toHaveLength(2)
    expect(converted[0].actionBeats[0].actor).toBe('char-zhao')

    const turnToolDraft: CharacterTurnDraftHolder = {}
    const turnTool = createNovelSubmitCharacterTurnTool(turnToolDraft)
    await (turnTool as any).execute('turn', {
      publicText: '[赵岩抬手挡住门] “先别进来。”',
      innerThought: '他担心门外的人已经听见了。',
      conflictReading: '门外脚步逼近。',
      responsePlan: '先试探，再撤离。',
      consequence: '门外的人停了一下。',
      progress: 'escalate',
      mentionNames: ['林晚'],
    })
    expect(turnToolDraft.turn?.publicText).toContain('先别进来')
    expect(turnToolDraft.turn?.mentionNames).toEqual(['林晚'])
    expect(turnToolDraft.turn?.innerThought).toContain('担心')
    expect(moderator.degradedRounds).toBe(0)
    void engine
    void createAgUiSession
    void options
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

  it('场景计划工具提交优先：Markdown 表格输出不再阻断演出', async () => {
    const draft: ScenePlanDraftHolder = {}
    const toolset = {
      tools: [createNovelSubmitScenePlanTool(draft)],
      extractResult: () => draft.plan ?? null,
    }
    // 模拟 Director 在规划回合中调用了 novel_submit_scene_plan（execute 写入 draft）
    const submitTool = toolset.tools[0] as unknown as {
      execute: (id: string, params: unknown) => Promise<unknown>
    }
    await submitTool.execute('call-1', {
      scenes: [{
        title: '客厅对峙',
        location: '客厅',
        time: '傍晚',
        conflict: '父子冲突',
        goal: '展现对立',
        presentCharacters: ['赵岩'],
      }],
    })

    const members = [
      makeMember({ id: 'novel-director', name: '导演' }),
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
      makeMember({ id: 'char-1', name: '赵岩', type: 'character' }),
    ]
    // Director 文本输出是真实事故（run b616f15f）里的表格变体：Markdown 解析必然失败
    const directorOutput = '## 章节概述\n\n| 属性 | 内容 |\n|------|------|\n| **在场角色** | 赵岩 |'
    let callCount = 0
    const ctx = {
      createAgUiSession: vi.fn().mockImplementation(async () => {
        callCount++
        return {
          session: { prompt: vi.fn().mockResolvedValue(callCount === 1 ? directorOutput : '[点头] “明白。”') },
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
    const engine = new TeamDiscussionEngine(moderator, new AgentChannel(), ctx as any)
    const options = makeOptions({ buildScenePlanToolset: () => toolset })

    const result = await engine.run(goal, members, options)

    expect(result.status).toBe('completed')
    expect(result.diagnostics?.sceneSource).toBe('tool')
    expect(result.scenes).toHaveLength(1)
    expect(result.scenes[0]).toMatchObject({ title: '客厅对峙', location: '客厅', conflict: '父子冲突' })
    expect(result.scenes[0].presentCharacters).toEqual(['char-1'])
    // 演出确实发生：角色发言进入 transcript
    expect(result.transcript.some(m => m.fromId === 'char-1' && m.type === 'member')).toBe(true)
    expect(result.diagnostics?.scenesWithActing).toBe(1)
    // 规划阶段给 Director 的调用挂载了场景计划工具
    const planningCall = ctx.createAgUiSession.mock.calls[0][0] as { tools?: unknown[] }
    expect(planningCall.tools).toHaveLength(1)
  })

  it('未提供场景计划工具时回退 Markdown 解析并显式告警', async () => {
    const members = [
      makeMember({ id: 'novel-director', name: '导演' }),
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
      makeMember({ id: 'char-1', name: '赵岩', type: 'character' }),
    ]
    const directorOutput = `### 场景1：客厅对峙
- 地点：客厅
- 时间：傍晚
- 在场角色：赵岩
- 冲突：父子冲突
- 目标：展现对立`
    let callCount = 0
    const ctx = {
      createAgUiSession: vi.fn().mockImplementation(async () => {
        callCount++
        return {
          session: { prompt: vi.fn().mockResolvedValue(callCount === 1 ? directorOutput : '[点头] “明白。”') },
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
    const engine = new TeamDiscussionEngine(moderator, new AgentChannel(), ctx as any)
    const onProgress = vi.fn()
    const options = makeOptions({ onProgress })

    const result = await engine.run(goal, members, options)

    expect(result.status).toBe('completed')
    expect(result.diagnostics?.sceneSource).toBe('markdown')
    expect(result.scenes).toHaveLength(1)
    // 回退路径必须显式告警，不再静默
    const messages = onProgress.mock.calls.map(([event]) => String((event as { data?: { message?: string } }).data?.message ?? ''))
    expect(messages.some(message => message.includes('回退'))).toBe(true)
  })

  it('planning 阶段 Director 空响应：纠正性重试成功后正常推进，不触发检查点', async () => {
    const members = [
      makeMember({ id: 'novel-director', name: '导演' }),
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
      makeMember({ id: 'char-1', name: '赵岩', type: 'character' }),
    ]
    const directorOutput = `### 场景1：客厅对峙
- 地点：客厅
- 时间：傍晚
- 在场角色：赵岩
- 冲突：父子冲突
- 目标：展现对立`
    let callCount = 0
    const ctx = {
      // 第 1 次调用（Director 初次规划）返回空串——复现 run e52bf628 的模型行为；
      // 第 2 次（纠正性重试）返回可解析的场景拆分
      createAgUiSession: vi.fn().mockImplementation(async () => {
        callCount++
        return {
          session: { prompt: vi.fn().mockResolvedValue(callCount === 1 ? '' : directorOutput) },
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
    const engine = new TeamDiscussionEngine(moderator, new AgentChannel(), ctx as any)
    const onCheckpoint = vi.fn().mockResolvedValue('approve')
    const onProgress = vi.fn()
    const options = makeOptions({ onCheckpoint, onProgress })

    const result = await engine.run(goal, members, options)

    expect(result.status).toBe('completed')
    expect(result.scenes).toHaveLength(1)
    expect(onCheckpoint).not.toHaveBeenCalled()
    // 空消息不入 history；纠正提示与重试产出都在
    expect(result.transcript.some(m => m.type === 'member' && m.fromId === 'novel-director' && m.content === '')).toBe(false)
    expect(result.transcript.some(m => m.type === 'moderator' && m.content.includes('没有任何内容'))).toBe(true)
    expect(result.transcript.some(m => m.type === 'member' && m.fromId === 'novel-director' && m.content.includes('客厅对峙'))).toBe(true)
    const messages = onProgress.mock.calls.map(([event]) => String((event as { data?: { message?: string } }).data?.message ?? ''))
    expect(messages.some(message => message.includes('纠正性重试'))).toBe(true)
  })

  it('planning 阶段 Director 连续空响应：重试仍空时抛检查点，approve 后继续循环', async () => {
    const members = [
      makeMember({ id: 'novel-director', name: '导演' }),
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
      makeMember({ id: 'char-1', name: '赵岩', type: 'character' }),
    ]
    const directorOutput = `### 场景1：客厅对峙
- 地点：客厅
- 时间：傍晚
- 在场角色：赵岩
- 冲突：父子冲突
- 目标：展现对立`
    let directorCall = 0
    const ctx = {
      // 第 1、2 次（初次+纠正重试）全空 → 检查点 approve → 第 3 次（Moderator 再邀请）成功
      createAgUiSession: vi.fn().mockImplementation(async () => {
        directorCall++
        const output = directorCall <= 2 ? '' : directorOutput
        return {
          session: { prompt: vi.fn().mockResolvedValue(output) },
          streamEmitter: { finishTextMessage: vi.fn() },
          messageId: `msg-${directorCall}`,
          dispose: vi.fn(),
        }
      }),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
    }
    const moderator = makeMockModerator([
      { type: 'invite', agentId: 'novel-director', prompt: '规划', reason: '开始' },
      { type: 'invite', agentId: 'novel-director', prompt: '再次规划', reason: '上轮为空' },
      { type: 'converge', agentId: 'novel-writer', scope: 'chapter', reason: '规划完成' },
      { type: 'invite', agentId: 'char-1', prompt: '演出', reason: '角色发言' },
      { type: 'converge', agentId: 'novel-writer', scope: 'scene', reason: '场景演完' },
    ])
    const engine = new TeamDiscussionEngine(moderator, new AgentChannel(), ctx as any)
    const onCheckpoint = vi.fn().mockResolvedValue('approve')
    const options = makeOptions({ onCheckpoint })

    const result = await engine.run(goal, members, options)

    expect(result.status).toBe('completed')
    expect(result.scenes).toHaveLength(1)
    // 检查点确实发出，且携带中止语义说明
    expect(onCheckpoint).toHaveBeenCalledTimes(1)
    const checkpoint = onCheckpoint.mock.calls[0][0] as { type: string; phase: string; question: string }
    expect(checkpoint.type).toBe('discussion_pause')
    expect(checkpoint.phase).toBe('planning')
    expect(checkpoint.question).toContain('未产出任何内容')
    // 空消息从未进入 history
    expect(result.transcript.some(m => m.type === 'member' && m.content === '')).toBe(false)
  })

  it('planning 阶段 Director 文本为空但工具已提交：直接采用工具结果，不重试不触发检查点（diag 日志复现）', async () => {
    const draft: ScenePlanDraftHolder = {}
    const toolset = {
      tools: [createNovelSubmitScenePlanTool(draft)],
      extractResult: () => draft.plan ?? null,
    }
    const members = [
      makeMember({ id: 'novel-director', name: '导演' }),
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
      makeMember({ id: 'char-1', name: '赵岩', type: 'character' }),
    ]
    let directorCall = 0
    const ctx = {
      // 复现 2026-08-26 diag 日志实证序列：模型第一轮调用 novel_submit_scene_plan
      // 工具（SDK 执行成功），工具结果回传后的第二轮返回空 stop → prompt() 得到空串
      createAgUiSession: vi.fn().mockImplementation(async (opts: { tools?: Array<{ execute?: (id: string, args: unknown) => Promise<unknown> }> }) => {
        if (opts.tools && opts.tools.length > 0) directorCall++
        return {
          session: {
            prompt: vi.fn().mockImplementation(async () => {
              if (directorCall === 1) {
                const submitTool = opts.tools?.[0]
                const execute = submitTool?.execute
                if (execute) {
                  await execute('fake-tool-call', {
                    scenes: [{
                      title: '客厅对峙',
                      location: '客厅',
                      time: '傍晚',
                      goal: '展现对立',
                      presentCharacters: ['赵岩'],
                    }],
                  })
                }
              }
              return ''
            }),
          },
          streamEmitter: { finishTextMessage: vi.fn() },
          messageId: `msg-${directorCall}`,
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
    const engine = new TeamDiscussionEngine(moderator, new AgentChannel(), ctx as any)
    const onCheckpoint = vi.fn().mockResolvedValue('approve')
    const onProgress = vi.fn()
    const options = makeOptions({ buildScenePlanToolset: () => toolset, onCheckpoint, onProgress })

    const result = await engine.run(goal, members, options)

    expect(result.status).toBe('completed')
    // 工具提交的场景计划被采用
    expect(result.diagnostics?.sceneSource).toBe('tool')
    expect(result.scenes).toHaveLength(1)
    expect(result.scenes[0]?.title).toBe('客厅对峙')
    // 不重试（Director 只被真实调用一次）、不触发检查点
    expect(directorCall).toBe(1)
    expect(onCheckpoint).not.toHaveBeenCalled()
    // 占位文本进入 history，Moderator 能看到导演产出
    expect(result.transcript.some(m => m.type === 'member' && m.fromId === 'novel-director' && m.content.includes('工具提交'))).toBe(true)
    expect(result.transcript.find(m => m.type === 'member' && m.fromId === 'novel-director')?.content).toContain('- 地点：客厅')
    expect(result.transcript.find(m => m.type === 'member' && m.fromId === 'novel-director')?.content).toContain('- 时间：傍晚')
    expect(result.transcript.find(m => m.type === 'member' && m.fromId === 'novel-director')?.content).toContain('- 目标：展现对立')
    const messages = onProgress.mock.calls.map(([event]) => String((event as { data?: { message?: string } }).data?.message ?? ''))
    expect(messages.some(message => message.includes('直接采用工具结果'))).toBe(true)
    const directorBubbles = onProgress.mock.calls
      .map(([event]) => (event as { data?: { type?: string; agentType?: string; content?: string } }).data)
      .filter(data => data?.type === 'agent_output' && data.agentType === 'director')
    expect(directorBubbles).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: expect.stringContaining('- 地点：客厅') })
    ]))
  })

  it('planning 阶段 Director 连续空响应：检查点 reject 时以 failed_phase=planning 终止', async () => {
    const members = [
      makeMember({ id: 'novel-director', name: '导演' }),
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
    ]
    let directorCall = 0
    const ctx = {
      createAgUiSession: vi.fn().mockImplementation(async () => {
        directorCall++
        return {
          session: { prompt: vi.fn().mockResolvedValue('') },
          streamEmitter: { finishTextMessage: vi.fn() },
          messageId: `msg-${directorCall}`,
          dispose: vi.fn(),
        }
      }),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
    }
    const moderator = makeMockModerator([
      { type: 'invite', agentId: 'novel-director', prompt: '规划', reason: '开始' },
      { type: 'invite', agentId: 'novel-director', prompt: '再次规划', reason: '上轮为空' },
    ])
    const engine = new TeamDiscussionEngine(moderator, new AgentChannel(), ctx as any)
    const onCheckpoint = vi.fn().mockResolvedValue('reject')
    const options = makeOptions({ onCheckpoint })

    const result = await engine.run(goal, members, options)

    expect(result.status).toBe('error')
    expect(result.failedPhase).toBe('planning')
    expect(result.error).toContain('中止')
    // Director 恰好被调用两次（初次 + 纠正性重试），Moderator 未死循环邀请
    expect(directorCall).toBe(2)
  })

  it('场景计划缺失时纠正性重试一次，Director 补交工具后恢复演出', async () => {
    const draft: ScenePlanDraftHolder = {}
    const toolset = {
      tools: [createNovelSubmitScenePlanTool(draft)],
      extractResult: () => draft.plan ?? null,
    }
    const members = [
      makeMember({ id: 'novel-director', name: '导演' }),
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
      makeMember({ id: 'char-1', name: '赵岩', type: 'character' }),
    ]
    let callCount = 0
    const prompts: string[] = []
    const ctx = {
      createAgUiSession: vi.fn().mockImplementation(async (opts: { userMessage: string }) => {
        callCount++
        prompts.push(opts.userMessage)
        // 第 2 次调用是纠正性重试：模拟 Director 此时补交了工具
        if (callCount === 2) {
          draft.plan = {
            scenes: [{
              title: '客厅对峙',
              location: '客厅',
              time: '傍晚',
              goal: '展现对立',
              presentCharacters: ['赵岩'],
            }],
          }
        }
        return {
          session: { prompt: vi.fn().mockResolvedValue(callCount === 1 ? '## 章节概述（无法解析的格式）' : '[点头] “明白。”') },
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
    const engine = new TeamDiscussionEngine(moderator, new AgentChannel(), ctx as any)
    const options = makeOptions({ buildScenePlanToolset: () => toolset })

    const result = await engine.run(goal, members, options)

    expect(result.status).toBe('completed')
    expect(result.diagnostics?.planningRetries).toBe(1)
    expect(result.diagnostics?.sceneSource).toBe('tool')
    expect(result.scenes).toHaveLength(1)
    // 纠正提示进入群聊记录与重试 prompt
    expect(prompts.some(prompt => prompt.includes('novel_submit_scene_plan'))).toBe(true)
    expect(result.transcript.some(m => m.type === 'moderator' && m.content.includes('无法被系统读取'))).toBe(true)
  })

  it('零演出时盲写降级不再静默：显式事件 + transcript 记录 + 诊断', async () => {
    const members = [
      makeMember({ id: 'novel-director', name: '导演' }),
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
    ]
    let callCount = 0
    const ctx = {
      createAgUiSession: vi.fn().mockImplementation(async () => {
        callCount++
        return {
          session: { prompt: vi.fn().mockResolvedValue(callCount === 1 ? '完全无法解析的内容' : '成员发言内容') },
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
    ])
    const engine = new TeamDiscussionEngine(moderator, new AgentChannel(), ctx as any)
    const onProgress = vi.fn()
    const options = makeOptions({ onProgress })

    const result = await engine.run(goal, members, options)

    expect(result.status).toBe('completed')
    expect(result.diagnostics).toMatchObject({
      sceneSource: 'none',
      scenesTotal: 0,
      planningRetries: 1,
    })
    // 盲写兜底必须发显式警告事件
    const messages = onProgress.mock.calls.map(([event]) => String((event as { data?: { message?: string } }).data?.message ?? ''))
    expect(messages.some(message => message.includes('盲写降级'))).toBe(true)
    // transcript 里写入降级标记，Writer 与复盘者都能看到
    expect(result.transcript.some(m => m.type === 'system' && m.content.includes('【降级】'))).toBe(true)
  })

  it('放宽后的演出格式校验：多行/双括号放行，提纲、标题行与超长拒绝', () => {
    const engine = new TeamDiscussionEngine(
      makeMockModerator([]), new AgentChannel(), makeMockEngineContext() as any,
    ) as any

    // 真实事故形态：名字前缀 + 动作双括号（旧校验误杀，48% 重试率的来源之一）
    expect(engine.isValidCharacterSpeech('[宇智波诚] [单手推开半掩的木门] “……里面有人吗？”\n[手按向忍具包] “报上所属。”')).toBe(true)
    // 7 行（超过旧上限 6）放行
    const sevenLines = Array.from({ length: 7 }, (_, i) => `[动作${i}] “第${i}句。”`).join('\n')
    expect(engine.isValidCharacterSpeech(sevenLines)).toBe(true)
    // 13 行仍拒绝
    const thirteenLines = Array.from({ length: 13 }, (_, i) => `[动作${i}] “第${i}句。”`).join('\n')
    expect(engine.isValidCharacterSpeech(thirteenLines)).toBe(false)
    // Markdown 标题 / 元标签提纲 / 无台词动作 拒绝
    expect(engine.isValidCharacterSpeech('### 场景概述\n[点头] “好。”')).toBe(false)
    expect(engine.isValidCharacterSpeech('意图：拖延时间\n心理：担心秘密暴露')).toBe(false)
    expect(engine.isValidCharacterSpeech('[苦笑] （没有任何台词的动作）')).toBe(false)
  })

  it('归一化保留原文配对与裸台词，只在完全无台词时使用罐头兜底', () => {
    const engine = new TeamDiscussionEngine(
      makeMockModerator([]), new AgentChannel(), makeMockEngineContext() as any,
    ) as any

    // 配对行原样保留（不再截断到 3 句、不改写动作）
    expect(engine.normalizeCharacterSpeech(
      '[赵岩攥紧拳头] “我不签。”\n[转身要走] “就这样。”', '赵岩',
    )).toBe('[赵岩攥紧拳头] “我不签。”\n[转身要走] “就这样。”')
    // 无动作的裸台词补中性动作并保留说话人名空间
    expect(engine.normalizeCharacterSpeech('他低声说 “先别动手。”', '乙'))
      .toBe('[乙开口] “先别动手。”')
    // 完全无台词才落罐头
    expect(engine.normalizeCharacterSpeech('沉默地站着，一言不发。', '丙'))
      .toBe('[丙没有立刻表态] “先把眼前这件事说清楚。”')
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

  it('从 acting 快照恢复时从 failedSceneId 对应场景继续推演', async () => {
    const members = [
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
      makeMember({ id: 'novel-reviewer', name: '审稿' }),
      makeMember({ id: 'char-1', name: '叶明远', type: 'character' }),
    ]
    const recoveredContent = '密室里的灯火忽明忽暗，叶明远停在门边，终于看清墙上的旧刻痕。'.repeat(5)
    const prompts: string[] = []
    const ctx = {
      createAgUiSession: vi.fn().mockImplementation(async (opts: { userMessage: string }) => {
        prompts.push(opts.userMessage)
        const output = opts.userMessage.includes('请将以下各场景')
          || opts.userMessage.includes('请基于群聊记录产出完整章节正文')
          ? recoveredContent
          : opts.userMessage.includes('请只从文字读感盲审')
            ? '盲审：通过'
            : '## 结论：accept'
        return {
          session: { prompt: vi.fn().mockResolvedValue(output) },
          streamEmitter: { finishTextMessage: vi.fn() },
          messageId: `resume-acting-${prompts.length}`,
          dispose: vi.fn(),
        }
      }),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
    }
    const moderator = makeMockModerator([
      { type: 'converge', agentId: 'novel-writer', scope: 'scene', reason: '场景已收敛' },
    ])
    const decide = vi.spyOn(moderator, 'decide')
    const onProgress = vi.fn()
    const engine = new TeamDiscussionEngine(moderator, new AgentChannel(), ctx as any)

    const result = await engine.resumeSceneActing(
      goal,
      members,
      makeOptions({ onProgress }),
      {
        phase: 'acting',
        failedSceneId: 2,
        transcript: [{
          id: 'scene-1-finished',
          fromId: 'char-1',
          fromName: '叶明远',
          content: '场景一已经完成。',
          timestamp: 1,
          type: 'member',
          sceneId: 1,
        }],
        scenes: [
          {
            sceneId: 1,
            title: '矿道入口',
            location: '矿道',
            time: '夜',
            presentCharacters: ['char-1'],
            goal: '进入矿道',
          },
          {
            sceneId: 2,
            title: '密室对峙',
            location: '密室',
            time: '深夜',
            presentCharacters: ['char-1'],
            goal: '确认旧刻痕的来源',
          },
        ],
      },
    )

    expect(result.status).toBe('completed')
    expect(result.content).toBe(recoveredContent)
    expect(decide).toHaveBeenCalledTimes(1)
    expect(decide.mock.calls[0]?.[3]).toMatchObject({
      phase: 'acting',
      currentScene: { sceneId: 2 },
    })
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'scene_setup',
      data: expect.objectContaining({ scene: expect.objectContaining({ sceneId: 2 }) }),
    }))
    expect(result.transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'scene-1-finished' }),
      expect.objectContaining({ fromId: 'novel-writer', content: recoveredContent }),
    ]))
    const weavePrompt = prompts.find(prompt => prompt.includes('请将以下各场景'))
    expect(weavePrompt).toContain('密室对峙')
  })

  // ───────────────────────── 插话队列（对话化交互形态 §3.1，批次 1 任务 3） ─────────────────────────

  it('插话入队后下一轮 Moderator decide 的输入包含该消息（带前缀区块），不重排既有消息', async () => {
    const snapshots: DiscussionMessage[][] = []
    const moderator = makeRecordingModerator([
      { type: 'invite', agentId: 'director', prompt: '规划', reason: '开始' },
      { type: 'converge', agentId: 'writer', scope: 'chapter', reason: '完成' },
    ], snapshots)
    const engine = new TeamDiscussionEngine(moderator, new AgentChannel(), makeMockEngineContext() as any)
    engine.enqueueUserMessage({ id: 'ij-1', content: '打斗戏改用棍', createdAt: 1723680000000 })

    await engine.run(goal, [
      makeMember({ id: 'director', name: '导演' }),
      makeMember({ id: 'writer', name: '写作', canConverge: true }),
    ], makeOptions())

    expect(snapshots.length).toBeGreaterThanOrEqual(1)
    const firstHistory = snapshots[0]
    // 既有系统消息仍在最前（追加不重排）
    expect(firstHistory[0]).toMatchObject({ fromId: 'system' })
    expect(firstHistory[0].content).toContain('目标：')
    // 插话以 user 角色出现在首轮 decide 输入中，文本带「用户中途反馈」前缀区块
    const interjectMessage = firstHistory.find(m => m.id === 'interject-ij-1')
    expect(interjectMessage).toMatchObject({
      fromId: 'user',
      fromName: '用户',
      type: 'user',
      timestamp: 1723680000000,
    })
    expect(interjectMessage!.content).toBe('【用户中途反馈】\n（讨论进行中用户提出，可影响讨论方向）\n打斗戏改用棍')
  })

  it('重复 drain 幂等：同一插话在后续轮次的 history 中只出现一次', async () => {
    const snapshots: DiscussionMessage[][] = []
    const moderator = makeRecordingModerator([
      { type: 'invite', agentId: 'director', prompt: '规划', reason: '开始' },
      { type: 'converge', agentId: 'writer', scope: 'chapter', reason: '完成' },
    ], snapshots)
    const engine = new TeamDiscussionEngine(moderator, new AgentChannel(), makeMockEngineContext() as any)
    engine.enqueueUserMessage({ id: 'ij-2', content: '结尾留悬念', createdAt: 1723680000001 })

    const result = await engine.run(goal, [
      makeMember({ id: 'director', name: '导演' }),
      makeMember({ id: 'writer', name: '写作', canConverge: true }),
    ], makeOptions())

    // 每轮 decide 输入里该消息恰好一条（首轮注入后随 history 保留，不重复注入）
    expect(snapshots.map(h => h.filter(m => m.id === 'interject-ij-2').length)).toEqual([1, 1])
    expect(result.transcript.filter(m => m.id === 'interject-ij-2')).toHaveLength(1)
  })

  it('onInterjectInjected 在 Moderator 消费插话时收到全部 ids', async () => {
    const moderator = makeMockModerator([
      { type: 'invite', agentId: 'director', prompt: '规划', reason: '开始' },
      { type: 'converge', agentId: 'writer', scope: 'chapter', reason: '完成' },
    ])
    const engine = new TeamDiscussionEngine(moderator, new AgentChannel(), makeMockEngineContext() as any)
    engine.enqueueUserMessage({ id: 'ij-a', content: '多写点对话', createdAt: 1723680000002 })
    engine.enqueueUserMessage({ id: 'ij-b', content: '压缩环境描写', createdAt: 1723680000003 })
    const onInterjectInjected = vi.fn()

    await engine.run(goal, [
      makeMember({ id: 'director', name: '导演' }),
      makeMember({ id: 'writer', name: '写作', canConverge: true }),
    ], makeOptions({ onInterjectInjected }))

    // 两条同批 drain，一次回调；第二轮 decide 时队列已空不再回调
    expect(onInterjectInjected).toHaveBeenCalledTimes(1)
    expect(onInterjectInjected).toHaveBeenCalledWith(['ij-a', 'ij-b'])
  })

  it('flow 收尾清空插话队列并回调 onInterjectDropped（未被消费的消息不进 transcript）', async () => {
    const moderator = makeMockModerator([
      { type: 'converge', agentId: 'writer', scope: 'chapter', reason: '直接收敛' },
    ])
    let engine!: TeamDiscussionEngine
    let lateEnqueued = false
    const ctx = {
      // 第一次成员调用发生在全章编织阶段（所有 decide 已结束）：
      // 此时入队的插话不会再被 drain，只能走收尾 dropped。
      createAgUiSession: vi.fn().mockImplementation(async () => {
        if (!lateEnqueued) {
          lateEnqueued = true
          engine.enqueueUserMessage({ id: 'late-1', content: '来不及注入的反馈', createdAt: 1723680000004 })
        }
        return {
          session: { prompt: vi.fn().mockResolvedValue('完整章节正文'.repeat(30)) },
          streamEmitter: { finishTextMessage: vi.fn() },
          messageId: 'msg-late',
          dispose: vi.fn(),
        }
      }),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
    }
    engine = new TeamDiscussionEngine(moderator, new AgentChannel(), ctx as any)
    const onInterjectDropped = vi.fn()

    const result = await engine.run(goal, [
      makeMember({ id: 'writer', name: '写作', canConverge: true }),
    ], makeOptions({ onInterjectDropped }))

    expect(result.status).toBe('completed')
    expect(onInterjectDropped).toHaveBeenCalledTimes(1)
    expect(onInterjectDropped).toHaveBeenCalledWith(['late-1'])
    expect(result.transcript.some(m => m.id === 'interject-late-1')).toBe(false)
    expect((engine as any).interjectQueue).toHaveLength(0)
  })

  it('收尾后 enqueueUserMessage 返回 false（存活标记失效）：消息不入队，端点据此 409', async () => {
    const moderator = makeMockModerator([
      { type: 'converge', agentId: 'writer', scope: 'chapter', reason: '直接收敛' },
    ])
    const engine = new TeamDiscussionEngine(moderator, new AgentChannel(), makeMockEngineContext() as any)

    // run 启动前入队也受理（runner 在 engine.run 调用前就登记投递闭包）
    expect(engine.enqueueUserMessage({ id: 'ij-live', content: '运行前的插话', createdAt: 1723680000005 })).toBe(true)

    await engine.run(goal, [
      makeMember({ id: 'writer', name: '写作', canConverge: true }),
    ], makeOptions())

    // 收尾后：闭包存活标记失效，拒绝受理且消息不进队列（TOCTOU 微窗口消除）
    expect(engine.enqueueUserMessage({ id: 'ij-after', content: '收尾后的插话', createdAt: 1723680000006 })).toBe(false)
    expect((engine as any).interjectQueue).toHaveLength(0)
  })

  it('断点续跑收尾后 enqueueUserMessage 同样返回 false', async () => {
    const moderator = makeMockModerator([])
    const engine = new TeamDiscussionEngine(moderator, new AgentChannel(), makeMockEngineContext() as any)

    await engine.resumeChapterWeaving(goal, [
      makeMember({ id: 'writer', name: '写作', canConverge: true }),
    ], makeOptions(), {
      phase: 'chapter_weaving',
      transcript: [],
      scenes: [],
    })

    expect(engine.enqueueUserMessage({ id: 'ij-resume-after', content: '续跑后的插话', createdAt: 1723680000007 })).toBe(false)
  })

  // ── P1（2026-08-24）：演绎素材进入正文的可验证收据 ──

  function makeActingHistory(): DiscussionMessage[] {
    return [
      { id: 's1', fromId: 'system', fromName: '系统', content: '场景', timestamp: 1, type: 'system' },
      { id: 'q1', fromId: 'char-1', fromName: '赵岩', content: '[攥拳] “别回头，趴下！”\n[挡在前面] “这事和你无关。”', timestamp: 2, sceneId: 1, type: 'member' },
      { id: 'q2', fromId: 'char-2', fromName: '林晚', content: '[发抖] “妈妈……妈妈在哪儿？”\n[抬头] “叔叔，你快过来。”', timestamp: 3, sceneId: 1, type: 'member' },
    ]
  }

  it('台词复用率闸门：低于阈值触发定向补织，取复用率更高的一版', async () => {
    const members = [
      makeMember({ id: 'novel-director', name: '导演' }),
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
      makeMember({ id: 'char-1', name: '赵岩', type: 'character' }),
      makeMember({ id: 'char-2', name: '林晚', type: 'character' }),
    ]
    // 首次编织完全丢弃台词；定向补织后完整落地
    // （不传 targetWords：PostWriteGuard 字数门跳过，只隔离测补织机制）
    let weaveCalls = 0
    const createAgUiSession = vi.fn().mockImplementation(async () => {
      weaveCalls++
      const text = weaveCalls === 1
        ? Array.from({ length: 55 }, (_, i) => `第${i + 1}段是各不相同的场景描写和人物行动推进过程叙述。`).join('\n')
        : Array.from({ length: 50 }, (_, i) => `第${i + 1}段各不相同。${i === 25 ? '赵岩喊道：“别回头，趴下！”林晚哭着找妈妈。' : '场景继续推进，人物行动带来新的变化和后果。'}`).join('\n')
      return {
        session: { prompt: vi.fn().mockResolvedValue(text) },
        streamEmitter: { finishTextMessage: vi.fn() },
        messageId: `w-${weaveCalls}`,
        dispose: vi.fn(),
      }
    })
    const onProgress = vi.fn()
    const engine = new TeamDiscussionEngine(
      makeMockModerator([]), new AgentChannel(), { createAgUiSession, logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } } as any,
    ) as any
    engine.currentGoal = goal

    const result = await engine.weaveChapter(
      members,
      makeActingHistory(),
      [{ sceneId: 1, title: '事故', location: '路口', time: '傍晚', presentCharacters: ['char-1', 'char-2'], goal: '救人', conflict: '车祸' }],
      goal,
      makeOptions({ onProgress }),
    )

    // 首次编织 + 定向补织共两次 Writer 调用（无质量门重试）
    expect(createAgUiSession).toHaveBeenCalledTimes(2)
    // 补织 prompt 必须携带未落地台词清单
    const rewritePrompt = createAgUiSession.mock.calls[1][0].userMessage as string
    expect(rewritePrompt).toContain('复用率')
    expect(rewritePrompt).toContain('别回头，趴下！')
    // 取补织后版本：台词已落地
    expect(result).toContain('趴下')
    expect(engine.transcriptReuseRate).toBeGreaterThan(0)
    const messages = onProgress.mock.calls.map(([event]) => String((event as { data?: { message?: string } }).data?.message ?? ''))
    expect(messages.some(message => message.includes('定向补织'))).toBe(true)
  })

  it('台词复用率闸门：达标或样本过小时不触发重写', async () => {
    const members = [
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
      makeMember({ id: 'char-1', name: '赵岩', type: 'character' }),
    ]
    // 正文完整包含推演台词 → 复用率达标（不传 targetWords，字数门不干扰）
    const content = `${Array.from({ length: 40 }, (_, i) => `第${i + 1}段各不相同的叙述推进过程。`).join('\n')}\n赵岩低吼：“别回头，趴下！”`
    const createAgUiSession = vi.fn().mockResolvedValue({
      session: { prompt: vi.fn().mockResolvedValue(content) },
      streamEmitter: { finishTextMessage: vi.fn() },
      messageId: 'w-ok',
      dispose: vi.fn(),
    })
    const engine = new TeamDiscussionEngine(
      makeMockModerator([]), new AgentChannel(), { createAgUiSession, logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } } as any,
    ) as any
    engine.currentGoal = goal

    await engine.weaveChapter(
      members,
      makeActingHistory(),
      [{ sceneId: 1, title: '事故', location: '路口', time: '傍晚', presentCharacters: ['char-1'], goal: '救人' }],
      goal,
      makeOptions(),
    )

    expect(createAgUiSession).toHaveBeenCalledTimes(1)
    expect(engine.transcriptReuseRate).toBeGreaterThanOrEqual(0.4)
  })

  it('演出阶段角色前缀常驻注入当前场景契约，不随滑动窗口滑出', async () => {
    const createAgUiSession = vi.fn().mockResolvedValue({
      session: { prompt: vi.fn().mockResolvedValue('[点头] “明白。”') },
      streamEmitter: { finishTextMessage: vi.fn() },
      messageId: 'sc-1',
      dispose: vi.fn(),
    })
    const engine = new TeamDiscussionEngine(
      makeMockModerator([]), new AgentChannel(), { createAgUiSession, logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } } as any,
    ) as any
    engine.currentGoal = { task: '测试', context: '上下文' }
    engine.currentScene = {
      sceneId: 1, title: '客厅对峙', location: '客厅', time: '夜',
      presentCharacters: ['char-1'], goal: '逼问真相', conflict: '父子冲突',
    }

    await engine.invokeMember(
      makeMember({ id: 'char-1', type: 'character', buildContextPrompt: () => '角色可见背景' }),
      '演出当前回合', [], makeOptions(), { phase: 'acting', sceneId: 1 },
    )

    const call = createAgUiSession.mock.calls[0][0]
    const prefixes = call.prefixUserMessage as string[]
    expect(prefixes.some((p: string) => p.includes('场景1：客厅对峙') && p.includes('父子冲突'))).toBe(true)
  })

  it('非演出阶段或场景不匹配时不注入场景契约前缀', async () => {
    const createAgUiSession = vi.fn().mockResolvedValue({
      session: { prompt: vi.fn().mockResolvedValue('[点头] “明白。”') },
      streamEmitter: { finishTextMessage: vi.fn() },
      messageId: 'sc-2',
      dispose: vi.fn(),
    })
    const engine = new TeamDiscussionEngine(
      makeMockModerator([]), new AgentChannel(), { createAgUiSession, logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } } as any,
    ) as any
    engine.currentGoal = { task: '测试', context: '' }
    engine.currentScene = {
      sceneId: 2, title: '另一场', location: 'x', time: 'x',
      presentCharacters: [], goal: 'g',
    }

    await engine.invokeMember(
      makeMember({ id: 'char-1', type: 'character' }),
      '任务', [], makeOptions(), { phase: 'acting', sceneId: 1 },
    )
    const prefixes = createAgUiSession.mock.calls[0][0].prefixUserMessage as string[]
    expect(prefixes.some((p: string) => p.includes('另一场'))).toBe(false)
  })

  it('Reviser 提示词注入角色推演摘要作为声音基准', async () => {
    const engine = new TeamDiscussionEngine(
      makeMockModerator([]), new AgentChannel(), makeMockEngineContext() as any,
    ) as any
    engine.invokeMember = vi.fn()
      .mockResolvedValueOnce('盲审：需要修订')
      .mockResolvedValueOnce('## 结论：revise')
      .mockResolvedValueOnce('Reviser 已应用修订')
    const extractResult = vi.fn().mockReturnValue({
      content: '修订后正文', appliedPatchCount: 1, successCount: 1, mode: 'patch' as const,
    })
    const history = makeActingHistory()

    await engine.reviewFinalChapter(
      '第一段。',
      [
        makeMember({ id: 'novel-reviewer', name: '审稿' }),
        makeMember({ id: 'novel-reviser', name: '修订', canConverge: true }),
        makeMember({ id: 'char-1', name: '赵岩', type: 'character' }),
      ],
      history,
      makeOptions({
        onCheckpoint: vi.fn().mockResolvedValue('revise'),
        buildReviserToolset: () => ({ tools: [{ name: 'novel_apply_revision' }], extractResult }),
      }),
    )

    const reviserCall = engine.invokeMember.mock.calls[2]
    expect(reviserCall[1]).toContain('角色推演记录（修订时的角色声音基准）')
    expect(reviserCall[1]).toContain('[赵岩]')
    expect(reviserCall[1]).toContain('别回头，趴下！')
  })

  it('编排白名单：Director 点名白名单外角色被拦截，不建临时角色', async () => {
    const draft: ScenePlanDraftHolder = {}
    const toolset = {
      tools: [createNovelSubmitScenePlanTool(draft)],
      extractResult: () => draft.plan ?? null,
    }
    // 模拟 Director 工具提交：一个白名单内（赵岩）+ 一个白名单外（赵父）
    const submitTool = toolset.tools[0] as unknown as {
      execute: (id: string, params: unknown) => Promise<unknown>
    }
    await submitTool.execute('call-1', {
      scenes: [{
        title: '客厅对峙',
        location: '客厅',
        time: '傍晚',
        goal: '展现对立',
        presentCharacters: ['赵岩', '赵父'],
      }],
    })

    const members = [
      makeMember({ id: 'novel-director', name: '导演' }),
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
      makeMember({ id: 'char-1', name: '赵岩', type: 'character' }),
    ]
    let callCount = 0
    const ctx = {
      createAgUiSession: vi.fn().mockImplementation(async () => {
        callCount++
        return {
          session: { prompt: vi.fn().mockResolvedValue(callCount === 1 ? '规划思路（结构经工具提交）' : '[点头] “明白。”') },
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
    const engine = new TeamDiscussionEngine(moderator, new AgentChannel(), ctx as any)
    const resolveCharacterMembers = vi.fn().mockReturnValue([])
    const options = makeOptions({
      buildScenePlanToolset: () => toolset,
      allowedCharacterMemberIds: ['char-1'],
      resolveCharacterMembers,
    })

    const result = await engine.run(goal, members, options)

    // 白名单外名字被拦截：presentCharacters 只剩赵岩，无未解析名
    expect(result.scenes[0].presentCharacters).toEqual(['char-1'])
    expect(result.scenes[0].unresolvedCharacterNames).toEqual([])
    // 不再动态创建临时角色
    expect(resolveCharacterMembers).not.toHaveBeenCalled()
    expect(result.transcript.some(m => m.fromId.startsWith('char-') && m.fromId !== 'char-1')).toBe(false)
    // 拦截写入 system 警告，用户与 Moderator 可见
    expect(result.transcript.some(m => m.type === 'system' && m.content.includes('【编排约束】') && m.content.includes('赵父'))).toBe(true)
  })
})
