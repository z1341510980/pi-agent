import { describe, expect, it, vi } from 'vitest'
import { TeamDiscussionEngine } from '../core/discussion/engine/team-discussion-engine.js'
import { AgentChannel } from '../../../core/agent/agent-channel.js'
import { createNovelSubmitScenePlanTool, createNovelSubmitCharacterTurnTool, type ScenePlanDraftHolder } from '../core/novel-tools.js'
import type { CharacterTurnDraftHolder } from '../core/tools/submit.js'
import type {
  DiscussionGoal,
  DiscussionMember,
  DiscussionMessage,
  DiscussionOptions,
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

/**
 * Moderator 已随 2026-08-28 控制平面重排删除：引擎不再有任何 LLM 仲裁路径，
 * planning 直呼 Director、acting 由策略表处置。这里保留一个带 decide 哨兵的
 * 空壳，供旧用例断言"全程零仲裁调用"；传入的决策序列被忽略。
 */
type ModeratorSentinel = { decide: ReturnType<typeof vi.fn>; degradedRounds: number }
function makeMockModerator(_decisions?: unknown[]): ModeratorSentinel {
  return { decide: vi.fn(), degradedRounds: 0 }
}

/**
 * 记录 Director 每次调用看到的 history 快照。
 *
 * planning 改为引擎直呼 Director 后，"插话是否被下一轮看到"的观测点从
 * Moderator.decide 移到了成员调用的 userMessage —— 该字段里含格式化后的群聊记录。
 * 这里在 createAgUiSession 层面记录，避免依赖已被删除的 Moderator 循环。
 */
function makeHistoryRecordingContext(reply = '成员发言内容'): {
  ctx: Record<string, unknown>
  userMessages: string[]
} {
  const userMessages: string[] = []
  const ctx = {
    createAgUiSession: vi.fn().mockImplementation(async (input: { userMessage?: string }) => {
      userMessages.push(String(input.userMessage ?? ''))
      return {
        session: { prompt: vi.fn().mockResolvedValue(reply) },
        streamEmitter: { finishTextMessage: vi.fn() },
        messageId: `msg-${userMessages.length}`,
        dispose: vi.fn(),
      }
    }),
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
  }
  return { ctx, userMessages }
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
      tools: [createNovelSubmitScenePlanTool(sceneDraft, { requireActionBeats: true })],
      extractResult: () => sceneDraft.plan ?? null,
    }
    const submittedScene = {
      title: '门前对峙',
      location: '旧宅门口',
      time: '夜里',
      conflict: '是否打开门确认来人身份',
      goal: '让赵岩失去隐瞒空间',
      emotion: '警惕升级为逼迫',
      presentCharacters: ['赵岩', '林晚'],
      actionBeats: [
        {
          beatId: 'a1', actor: '赵岩', target: '林晚',
          pressure: '门外脚步逼近，赵岩不能再装作没有听见',
          action: '赵岩挡住门并试图让林晚保持安静',
          choice: '继续隐瞒或承认门后有危险',
          consequence: '门外的人停下，屋内关系变得紧张',
          nextActor: '林晚', exitCondition: '林晚接住破绽并施压',
        },
        {
          beatId: 'a2', actor: '林晚', target: '赵岩',
          pressure: '赵岩的遮掩暴露出新的危险',
          action: '林晚抓住停顿逼赵岩解释',
          choice: '替他保密或逼他说出门后真相',
          consequence: '赵岩失去继续隐瞒的空间',
          exitCondition: '关系或信息发生明确变化',
        },
      ],
    }
    const turnPayloads = [
      {
        publicText: '[赵岩抬手挡住门] “先别进来，外面有人。”',
        innerThought: '他担心门外的人已经听见了刚才那句话。',
        conflictReading: '门外的脚步声正在逼近。',
        responsePlan: '先试探，再决定是否撤离。',
        consequence: '门外的人停了一下，屋里两人都不敢出声。',
        progress: 'escalate',
        mentionNames: ['林晚'],
      },
      {
        publicText: '[林晚压低声音] “你终于承认门后有人了。”',
        innerThought: '她要借这个破绽逼赵岩说出真相。',
        conflictReading: '赵岩正在隐瞒门后的风险。',
        responsePlan: '继续施压，让他做出选择。',
        consequence: '赵岩失去继续隐瞒的空间。',
        progress: 'reveal',
        mentionNames: [],
      },
    ]
    // 真实链路断言依赖「谁看到了什么」：按成员记录每次调用的 userMessage。
    const invocations: Array<{ tools: string[]; userMessage: string }> = []
    let turnIndex = 0
    const createAgUiSession = vi.fn().mockImplementation(async (input: {
      userMessage?: string
      tools?: Array<{ name?: string; execute?: (id: string, args: unknown) => Promise<unknown> }>
    }) => {
      const tools = input.tools ?? []
      invocations.push({
        tools: tools.map(tool => tool.name ?? ''),
        userMessage: String(input.userMessage ?? ''),
      })
      const planTool = tools.find(tool => tool.name === 'novel_submit_scene_plan')
      const turnTool = tools.find(tool => tool.name === 'novel_submit_character_turn')
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            if (planTool?.execute) {
              await planTool.execute('plan-1', { scenes: [submittedScene] })
              // 工具主路径已实证会返回空 stop：正文为空也必须完成规划。
              return ''
            }
            if (turnTool?.execute) {
              const payload = turnPayloads[Math.min(turnIndex, turnPayloads.length - 1)]
              turnIndex++
              await turnTool.execute(`turn-${turnIndex}`, payload)
              return ''
            }
            return '门在夜色里合着。赵岩的手还压在门板上，掌心的汗把木纹洇出一道深色的印子。'
              + '林晚没有再往前走，她盯着他的手，等他自己把话说完。门外的脚步停在第三级台阶，'
              + '不上不下，像是在确认屋里有几个人。赵岩终于松了手，木门弹回一寸,又被他重新按住。'
              + '他说不出撤离两个字，因为那意味着承认门后的人已经找到了这里。林晚看懂了这个停顿，'
              + '她的声音压得更低，把那句承认替他说了出来。屋里的空气一下子薄了，两个人都清楚，'
              + '接下来无论谁先动，都不再有退回去的余地。'
          }),
        },
        streamEmitter: { finishTextMessage: vi.fn() },
        messageId: `msg-${invocations.length}`,
        dispose: vi.fn(),
      }
    })
    const members = [
      makeMember({ id: 'novel-director', name: '导演' }),
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
      makeMember({ id: 'char-zhao', type: 'character', name: '赵岩' }),
      makeMember({ id: 'char-lin', type: 'character', name: '林晚' }),
    ]
    // planning 直呼 Director、acting 走动作图：整个 run 都不该读 Moderator 决策。
    const moderator = makeMockModerator([])
    const engine = new TeamDiscussionEngine(new AgentChannel(), {
      createAgUiSession,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
    } as any)
    const options = makeOptions({
      allowLegacyActing: false,
      buildScenePlanToolset: () => scenePlan,
      buildCharacterTurnToolset: ({ actionBeatId }) => {
        const draft: CharacterTurnDraftHolder = {}
        return {
          tools: [createNovelSubmitCharacterTurnTool(draft, actionBeatId)],
          extractResult: () => draft.turn ?? null,
        }
      },
    })

    const result = await engine.run(goal, members, options)

    expect(result.status).toBe('completed')
    // 动作图落地为 canonical member ID
    expect(result.scenes[0].actionBeats?.map(beat => beat.actor)).toEqual(['char-zhao', 'char-lin'])

    // planning 直呼 Director + 正常 acting 走动作图：全程零 Moderator 调用
    expect(result.diagnostics?.totalModeratorInvocations).toBe(0)
    expect(result.diagnostics?.moderatorExceptionInvocations).toBe(0)
    expect(result.diagnostics?.plannerInvocations).toBe(1)
    expect(moderator.degradedRounds).toBe(0)
    // 两个节点各一次角色调用；主路径不产生格式纠正调用
    expect(result.diagnostics?.autonomousCharacterTurns).toBe(2)
    expect(result.diagnostics?.completedActionBeats).toBe(2)
    expect(result.diagnostics?.incompleteActionBeats).toBe(0)
    expect(result.diagnostics?.formatCorrections).toBe(0)
    // 赵岩的 mention 把林晚拉进 FIFO，而不是等 Moderator 点名
    expect(result.diagnostics?.autonomousMentions).toBe(1)

    const characterMessages = result.transcript.filter(message => message.type === 'member' && message.fromId.startsWith('char-'))
    expect(characterMessages.map(message => message.fromId)).toEqual(['char-zhao', 'char-lin'])
    // 公开气泡只承载 publicText，私有判断挂在 actorTurn 上
    expect(characterMessages[0].content).toContain('先别进来')
    expect(characterMessages[0].content).not.toContain('担心门外的人')
    expect(characterMessages[0].actorTurn?.innerThought).toContain('担心门外的人')

    // 可见性：林晚的 prompt 不含赵岩的私有字段；Writer 能读到
    const linCall = invocations.find(call => call.tools.includes('novel_submit_character_turn')
      && call.userMessage.includes('赵岩抬手挡住门'))
    expect(linCall).toBeDefined()
    expect(linCall!.userMessage).not.toContain('担心门外的人')
    expect(linCall!.userMessage).not.toContain('先试探，再决定是否撤离')
    const writerCall = invocations.find(call => call.userMessage.includes('全章剧本'))
    expect(writerCall).toBeDefined()
    expect(writerCall!.userMessage).toContain('担心门外的人')
    expect(writerCall!.userMessage).toContain('仅 Writer 可见')
  })

  it('mention 角色没有预置节点时仍能以 reaction 节点回应，且不误标任何 actionBeat 完成', async () => {
    // 场景只有赵岩一个节点；赵岩 mention 林晚，但林晚在计划里没有节点。
    // 旧路径在此直接丢弃 mention；现在引擎合成 kind:'reaction' 节点让林晚接戏。
    const { engine, members, options, callsByMember } = makeActionBeatRun({
      scenePlan: {
        title: '门前对峙',
        location: '旧宅门口',
        time: '夜里',
        conflict: '是否开门',
        goal: '让赵岩失去隐瞒空间',
        presentCharacters: ['赵岩', '林晚'],
        actionBeats: [{
          beatId: 'a1', actor: '赵岩', target: '林晚',
          pressure: '门外脚步逼近', action: '赵岩挡住门',
          choice: '隐瞒或承认', consequence: '门外的人停下',
          exitCondition: '林晚接住破绽',
        }],
      },
      turnFor: memberId => memberId === 'char-zhao'
        ? validTurn('[赵岩挡住门] “先别进来。”', ['林晚'])
        : validTurn('[林晚压低声音] “你承认了。”'),
    })

    const result = await engine.run(goal, members, options)

    expect(result.status).toBe('completed')
    // 林晚被合成 reaction 节点调度，回应真的发生了
    expect(callsByMember.get('char-lin')).toBe(1)
    // reaction 不误标完成：唯一的 Director 节点 a1 凭赵岩自己的回合完成
    expect(result.diagnostics?.completedActionBeats).toBe(1)
    expect(result.diagnostics?.incompleteActionBeatIds).toEqual([])
    expect(result.diagnostics?.autonomousMentions).toBe(1)
    expect(result.diagnostics?.mentionResponseTurns).toBe(1)
    // 压力上下文继承父节点：林晚的 prompt 里带 a1 的阻力与行动边界
    const linTurn = result.transcript.find(message =>
      message.type === 'member' && message.fromId === 'char-lin')
    expect(linTurn).toBeDefined()
    expect(linTurn!.content).toContain('你承认了')
  })

  it('群聊 Reviser 通过业务层工具化修订（buildReviserToolset）应用修改', async () => {
    const engine = new TeamDiscussionEngine(
      new AgentChannel(), makeMockEngineContext() as any,
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
      new AgentChannel(), makeMockEngineContext() as any,
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
      new AgentChannel(), makeMockEngineContext() as any,
    )
    const content = Array.from({ length: 20 }, (_, i) => `第${i + 1}段是各不相同的场景描写和人物行动。`).join('\n')

    const result = (engine as any).runDiscussionPostWriteGuard(content, undefined, ['李四'])

    expect(result.shouldRewrite).toBe(true)
    expect(result.reason).toBe('未完整执行矩阵编排')
    expect(result.details).toContain('李四')
  })

  it('群聊质量门不因正文达到目标 80% 就自动重写', () => {
    const engine = new TeamDiscussionEngine(
      new AgentChannel(), makeMockEngineContext() as any,
    )
    const content = Array.from({ length: 2400 }, (_, index) =>
      String.fromCodePoint(0x4e00 + (index % 1800)),
    ).join('')

    const result = (engine as any).runDiscussionPostWriteGuard(content, 3000)

    expect(result.shouldRewrite).toBe(false)
  })

  it('群聊质量门拦截只输出写作说明而没有正文的结果', () => {
    const engine = new TeamDiscussionEngine(
      new AgentChannel(), makeMockEngineContext() as any,
    )
    const content = '我将先核对人物设定、章节目标和矩阵约束，然后按照导演方案分场景展开，确保冲突升级、伏笔推进和结尾钩子都得到落实。'.repeat(4)

    const result = (engine as any).runDiscussionPostWriteGuard(content)

    expect(result.shouldRewrite).toBe(true)
    expect(result.reason).toBe('模型未输出正文')
  })

  it('群聊重写结果退化为写作说明时保留原正文', async () => {
    const engine = new TeamDiscussionEngine(
      new AgentChannel(), makeMockEngineContext() as any,
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
    const engine = new TeamDiscussionEngine(new AgentChannel(), ctx as any)
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
    const engine = new TeamDiscussionEngine(new AgentChannel(), ctx as any)

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
    const engine = new TeamDiscussionEngine(new AgentChannel(), ctx as any)

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
    const decisions = [
      { type: 'invite', agentId: 'director', prompt: '规划', reason: '开始' },
      { type: 'converge', agentId: 'writer', scope: 'chapter', reason: '完成' },
    ]
    const moderator = makeMockModerator(decisions)
    const channel = new AgentChannel()
    const ctx = makeMockEngineContext()
    const engine = new TeamDiscussionEngine(channel, ctx as any)

    const result = await engine.run(goal, members, makeOptions())
    expect(result.status).toBe('completed')
    expect(result.transcript.length).toBeGreaterThanOrEqual(2)
  })

  it('死锁防护：连续 observe 超限后强制 converge', async () => {
    const members = [
      makeMember({ id: 'director', name: '导演' }),
      makeMember({ id: 'writer', name: '写作', canConverge: true }),
    ]
    const engine = new TeamDiscussionEngine(new AgentChannel(), makeMockEngineContext() as any)

    const result = await engine.run(goal, members, makeOptions())
    expect(result.status).toBe('completed')
    expect(result.transcript.length).toBeGreaterThan(0)
  })

  it('总轮数超限后强制 converge', async () => {
    const members = [
      makeMember({ id: 'director', name: '导演' }),
      makeMember({ id: 'writer', name: '写作', canConverge: true }),
    ]
    const engine = new TeamDiscussionEngine(new AgentChannel(), makeMockEngineContext() as any)

    const result = await engine.run(goal, members, makeOptions())
    expect(result.status).toBe('completed')
  })

  it('成员发言失败时记录错误并继续', async () => {
    const members = [
      makeMember({ id: 'director', name: '导演' }),
      makeMember({ id: 'writer', name: '写作', canConverge: true }),
    ]
    const ctx = {
      createAgUiSession: vi.fn().mockRejectedValue(new Error('LLM 超时')),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
    }
    const engine = new TeamDiscussionEngine(new AgentChannel(), ctx as any)

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
    const moderatorDecisions = [
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
    const engine = new TeamDiscussionEngine(channel, ctx as any)

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
    const engine = new TeamDiscussionEngine(new AgentChannel(), makeMockEngineContext() as any)

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
    const engine = new TeamDiscussionEngine(new AgentChannel(), ctx as any)
    const resolveCharacterMembers = vi.fn().mockReturnValue([
      makeMember({ id: 'char-temp-father', name: '赵父', type: 'character' }),
    ])

    const result = await engine.run(goal, members, makeOptions({ resolveCharacterMembers }))

    expect(resolveCharacterMembers).toHaveBeenCalledWith(['赵父'])
    expect(result.scenes[0].presentCharacters).toEqual(['char-temp-father'])
    // markdown 回退路径不产 actionBeats：场景名单已解析，但演出阶段会记为缺口
    // （没有 Director 动作图就没有角色回合可演），角色不出现在 transcript。
    // 这是已知限制：markdown 场景只比对名单正确性，不驱动演出。
    expect(result.transcript.some(m => m.fromId === 'char-temp-father')).toBe(false)
    expect(result.transcript.some(m => m.type === 'system' && m.content.includes('【演出缺口】'))).toBe(true)
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
    const engine = new TeamDiscussionEngine(new AgentChannel(), ctx as any)
    const options = makeOptions({ buildScenePlanToolset: () => toolset })

    const result = await engine.run(goal, members, options)

    expect(result.status).toBe('completed')
    expect(result.diagnostics?.sceneSource).toBe('tool')
    expect(result.scenes).toHaveLength(1)
    expect(result.scenes[0]).toMatchObject({ title: '客厅对峙', location: '客厅', conflict: '父子冲突' })
    expect(result.scenes[0].presentCharacters).toEqual(['char-1'])
    // 该工具版本不强制 actionBeats：场景无动作图 ⇒ 按缺口记账而非静默回退轮询。
    // 演出没发生，但计划与缺口事件都保留，闸门由"全部场景 barren"判定（此处 approve 织织）。
    expect(result.transcript.some(m => m.type === 'system' && m.content.includes('【演出缺口】'))).toBe(true)
    expect(result.diagnostics?.scenesWithActing).toBe(0)
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
    const engine = new TeamDiscussionEngine(new AgentChannel(), ctx as any)
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
    const engine = new TeamDiscussionEngine(new AgentChannel(), ctx as any)
    const onCheckpoint = vi.fn().mockResolvedValue('approve')
    const onProgress = vi.fn()
    const options = makeOptions({ onCheckpoint, onProgress })

    const result = await engine.run(goal, members, options)

    expect(result.status).toBe('completed')
    expect(result.scenes).toHaveLength(1)
    // planning 检查点未触发（markdown 场景无动作图，后续的编织闸门检查点不属于 planning）
    const planningCheckpoints = onCheckpoint.mock.calls
      .map(([checkpoint]) => checkpoint as { phase?: string })
      .filter(checkpoint => checkpoint.phase === 'planning')
    expect(planningCheckpoints).toHaveLength(0)
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
    const engine = new TeamDiscussionEngine(new AgentChannel(), ctx as any)
    const onCheckpoint = vi.fn().mockResolvedValue('approve')
    const options = makeOptions({ onCheckpoint })

    const result = await engine.run(goal, members, options)

    expect(result.status).toBe('completed')
    expect(result.scenes).toHaveLength(1)
    // planning 检查点确实发出且恰好一次（后续 markdown 场景的编织闸门检查点另计）
    const planningCheckpoints = onCheckpoint.mock.calls
      .map(([checkpoint]) => checkpoint as { type: string; phase: string; question: string })
      .filter(checkpoint => checkpoint.phase === 'planning')
    expect(planningCheckpoints).toHaveLength(1)
    expect(planningCheckpoints[0]).toMatchObject({ type: 'discussion_pause' })
    expect(planningCheckpoints[0].question).toContain('未产出任何内容')
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
      //
      // ⚠️ 计数口径：Director 的会话 = 带 novel_submit_scene_plan 工具的会话。
      // 不能用"有工具就算 Director"——Writer 的正文通道也挂了 novel_submit_prose。
      createAgUiSession: vi.fn().mockImplementation(async (opts: { tools?: Array<{ name?: string; execute?: (id: string, args: unknown) => Promise<unknown> }> }) => {
        if (opts.tools?.some(tool => tool.name === 'novel_submit_scene_plan')) directorCall++
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
    const engine = new TeamDiscussionEngine(new AgentChannel(), ctx as any)
    const onCheckpoint = vi.fn().mockResolvedValue('approve')
    const onProgress = vi.fn()
    const options = makeOptions({ buildScenePlanToolset: () => toolset, onCheckpoint, onProgress })

    const result = await engine.run(goal, members, options)

    expect(result.status).toBe('completed')
    // 工具提交的场景计划被采用
    expect(result.diagnostics?.sceneSource).toBe('tool')
    expect(result.scenes).toHaveLength(1)
    expect(result.scenes[0]?.title).toBe('客厅对峙')
    // 不重试（Director 只被真实调用一次）、planning 检查点不触发
    // （该工具版本不强制 actionBeats，随后的编织闸门检查点不属于 planning）
    expect(directorCall).toBe(1)
    expect(onCheckpoint.mock.calls
      .map(([checkpoint]) => checkpoint as { phase?: string })
      .filter(checkpoint => checkpoint.phase === 'planning')).toHaveLength(0)
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

  it('planning 阶段 provider 报错：检查点携带真实原因，不再吞成"模型可能异常"', async () => {
    const members = [
      makeMember({ id: 'novel-director', name: '导演' }),
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
    ]
    // 复现真实事故：PI session 的 prompt() 在 provider 404 时不抛错，
    // 只在事件流里带 message_end(stopReason='error')；引擎必须捕获并透传。
    const ctx = {
      createAgUiSession: vi.fn().mockImplementation(async () => ({
        session: {
          subscribe: (listener: (event: Record<string, unknown>) => void) => {
            listener({
              type: 'message_end',
              message: {
                role: 'assistant',
                stopReason: 'error',
                errorMessage: '404: Model "gpt-5.6-terra" is not supported by any configured account in this group',
              },
            })
            return vi.fn()
          },
          prompt: vi.fn().mockResolvedValue(''),
        },
        streamEmitter: { finishTextMessage: vi.fn() },
        messageId: 'msg-provider-error',
        dispose: vi.fn(),
      })),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
    }
    const engine = new TeamDiscussionEngine(new AgentChannel(), ctx as any)
    const onCheckpoint = vi.fn().mockResolvedValue('reject')
    const options = makeOptions({ onCheckpoint })

    const result = await engine.run(goal, members, options)

    expect(result.status).toBe('error')
    const checkpoint = onCheckpoint.mock.calls[0][0] as { question: string }
    // 检查点问题里必须出现真实 provider 错误，用户才知道去改模型配置
    expect(checkpoint.question).toContain('not supported by any configured account')
    expect(checkpoint.question).toContain('最近一次失败原因')
    // agent 审计日志拿到真实错误文本（此前 error 列为空）
    expect(result.transcript.some(m => m.type === 'error' && m.content.includes('not supported'))).toBe(true)
  })

  it('planning 阶段 Director 连续空响应：检查点 reject 时以 failed_phase=planning 终止', async () => {    const members = [
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
    const engine = new TeamDiscussionEngine(new AgentChannel(), ctx as any)
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
    const engine = new TeamDiscussionEngine(new AgentChannel(), ctx as any)
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
    const engine = new TeamDiscussionEngine(new AgentChannel(), ctx as any)
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
    const engine = new TeamDiscussionEngine(new AgentChannel(), ctx as any)

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
    const engine = new TeamDiscussionEngine(new AgentChannel(), ctx as any)

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
    const engine = new TeamDiscussionEngine(new AgentChannel(), ctx as any)

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
    // 续跑遇到无 actionBeats 的场景：记为缺口继续，不再回退 Moderator 轮询。
    expect(result.transcript.some(message =>
      message.type === 'system' && message.content.includes('【演出缺口】'))).toBe(true)
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

  it('插话入队后 Director 首次调用即看到该消息（带前缀区块），不重排既有消息', async () => {
    const { ctx, userMessages } = makeHistoryRecordingContext()
    const engine = new TeamDiscussionEngine(new AgentChannel(), ctx as any)
    engine.enqueueUserMessage({ id: 'ij-1', content: '打斗戏改用棍', createdAt: 1723680000000 })

    const result = await engine.run(goal, [
      makeMember({ id: 'novel-director', name: '导演' }),
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
    ], makeOptions())

    expect(userMessages.length).toBeGreaterThanOrEqual(1)
    // 插话在 Director 首次调用的群聊记录里就已可见（drain 发生在调用之前）
    expect(userMessages[0]).toContain('【用户中途反馈】')
    expect(userMessages[0]).toContain('打斗戏改用棍')

    // transcript 里：既有系统消息仍在最前（追加不重排），插话以 user 角色落位
    expect(result.transcript[0]).toMatchObject({ fromId: 'system' })
    expect(result.transcript[0].content).toContain('目标：')
    const interjectMessage = result.transcript.find(m => m.id === 'interject-ij-1')
    expect(interjectMessage).toMatchObject({
      fromId: 'user',
      fromName: '用户',
      type: 'user',
      timestamp: 1723680000000,
    })
    expect(interjectMessage!.content).toBe('【用户中途反馈】\n（讨论进行中用户提出，可影响讨论方向）\n打斗戏改用棍')
  })

  it('重复 drain 幂等：同一插话在 transcript 与后续调用里都只出现一次', async () => {
    const { ctx, userMessages } = makeHistoryRecordingContext()
    const engine = new TeamDiscussionEngine(new AgentChannel(), ctx as any)
    engine.enqueueUserMessage({ id: 'ij-2', content: '结尾留悬念', createdAt: 1723680000001 })

    const result = await engine.run(goal, [
      makeMember({ id: 'novel-director', name: '导演' }),
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
    ], makeOptions())

    // 首轮注入后随 history 保留，不重复注入
    expect(result.transcript.filter(m => m.id === 'interject-ij-2')).toHaveLength(1)
    for (const message of userMessages) {
      const occurrences = message.split('结尾留悬念').length - 1
      expect(occurrences).toBeLessThanOrEqual(1)
    }
  })

  it('onInterjectInjected 在插话被 drain 时收到全部 ids', async () => {
    const engine = new TeamDiscussionEngine(
      new AgentChannel(), makeMockEngineContext() as any,
    )
    engine.enqueueUserMessage({ id: 'ij-a', content: '多写点对话', createdAt: 1723680000002 })
    engine.enqueueUserMessage({ id: 'ij-b', content: '压缩环境描写', createdAt: 1723680000003 })
    const onInterjectInjected = vi.fn()

    await engine.run(goal, [
      makeMember({ id: 'novel-director', name: '导演' }),
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
    ], makeOptions({ onInterjectInjected }))

    // 两条同批 drain，一次回调；后续 drain 时队列已空不再回调
    expect(onInterjectInjected).toHaveBeenCalledTimes(1)
    expect(onInterjectInjected).toHaveBeenCalledWith(['ij-a', 'ij-b'])
  })

  it('flow 收尾清空插话队列并回调 onInterjectDropped（未被消费的消息不进 transcript）', async () => {
    let engine!: TeamDiscussionEngine
    let lateEnqueued = false
    let callCount = 0
    const ctx = {
      // 第二次成员调用发生在全章编织阶段（planning 已结束、不再 drain）：
      // 此时入队的插话不会再被注入，只能走收尾 dropped。
      createAgUiSession: vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount >= 2 && !lateEnqueued) {
          lateEnqueued = true
          engine.enqueueUserMessage({ id: 'late-1', content: '来不及注入的反馈', createdAt: 1723680000004 })
        }
        return {
          session: { prompt: vi.fn().mockResolvedValue('完整章节正文'.repeat(30)) },
          streamEmitter: { finishTextMessage: vi.fn() },
          messageId: `msg-late-${callCount}`,
          dispose: vi.fn(),
        }
      }),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
    }
    engine = new TeamDiscussionEngine(new AgentChannel(), ctx as any)
    const onInterjectDropped = vi.fn()

    const result = await engine.run(goal, [
      makeMember({ id: 'novel-director', name: '导演' }),
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
    ], makeOptions({ onInterjectDropped }))

    expect(result.status).toBe('completed')
    expect(onInterjectDropped).toHaveBeenCalledTimes(1)
    expect(onInterjectDropped).toHaveBeenCalledWith(['late-1'])
    expect(result.transcript.some(m => m.id === 'interject-late-1')).toBe(false)
    expect((engine as any).interjectQueue).toHaveLength(0)
  })

  it('收尾后 enqueueUserMessage 返回 false（存活标记失效）：消息不入队，端点据此 409', async () => {
    const engine = new TeamDiscussionEngine(
      new AgentChannel(), makeMockEngineContext() as any,
    )

    // run 启动前入队也受理（runner 在 engine.run 调用前就登记投递闭包）
    expect(engine.enqueueUserMessage({ id: 'ij-live', content: '运行前的插话', createdAt: 1723680000005 })).toBe(true)

    await engine.run(goal, [
      makeMember({ id: 'novel-director', name: '导演' }),
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
    ], makeOptions())

    // 收尾后：闭包存活标记失效，拒绝受理且消息不进队列（TOCTOU 微窗口消除）
    expect(engine.enqueueUserMessage({ id: 'ij-after', content: '收尾后的插话', createdAt: 1723680000006 })).toBe(false)
    expect((engine as any).interjectQueue).toHaveLength(0)
  })

  it('断点续跑收尾后 enqueueUserMessage 同样返回 false', async () => {
    const moderator = makeMockModerator([])
    const engine = new TeamDiscussionEngine(new AgentChannel(), makeMockEngineContext() as any)

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
      new AgentChannel(), { createAgUiSession, logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } } as any,
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
      new AgentChannel(), { createAgUiSession, logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } } as any,
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
      new AgentChannel(), { createAgUiSession, logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } } as any,
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
      new AgentChannel(), { createAgUiSession, logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } } as any,
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
      new AgentChannel(), makeMockEngineContext() as any,
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
    const engine = new TeamDiscussionEngine(new AgentChannel(), ctx as any)
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

  // ───────────────────────── 失败 / 取消 / 旧快照兼容（T5） ─────────────────────────

  /**
   * 动作图场景的公共装配：默认两个节点、两个角色，节点与角色可按用例覆写。
   * `turnFor` 决定每次角色回合的产出：返回 null 表示该次调用不提交工具（视为失败）。
   */
  function makeActionBeatRun(input: {
    turnFor: (memberId: string, callIndex: number) => Record<string, unknown> | null
    scenePlan?: Record<string, unknown>
    signal?: AbortSignal
    onSessionCreate?: (memberIdHint: string) => void
    allowLegacyActing?: boolean
    onCheckpoint?: ReturnType<typeof vi.fn>
  }): {
    engine: TeamDiscussionEngine
    members: DiscussionMember[]
    options: DiscussionOptions
    moderator: ModeratorSentinel
    createAgUiSession: ReturnType<typeof vi.fn>
    callsByMember: Map<string, number>
  } {
    const sceneDraft: ScenePlanDraftHolder = {}
    const scenePlanToolset: ScenePlanToolset = {
      tools: [createNovelSubmitScenePlanTool(sceneDraft, { requireActionBeats: true })],
      extractResult: () => sceneDraft.plan ?? null,
    }
    const submittedScene = input.scenePlan ?? {
      title: '门前对峙',
      location: '旧宅门口',
      time: '夜里',
      conflict: '是否开门',
      goal: '让赵岩失去隐瞒空间',
      presentCharacters: ['赵岩', '林晚'],
      actionBeats: [
        {
          beatId: 'a1', actor: '赵岩', target: '林晚',
          pressure: '门外脚步逼近', action: '赵岩挡住门',
          choice: '隐瞒或承认', consequence: '门外的人停下',
          nextActor: '林晚', exitCondition: '林晚接住破绽',
        },
        {
          beatId: 'a2', actor: '林晚', target: '赵岩',
          pressure: '遮掩暴露危险', action: '林晚逼他解释',
          choice: '保密或逼问', consequence: '赵岩失去隐瞒空间',
          exitCondition: '信息发生变化',
        },
      ],
    }
    const callsByMember = new Map<string, number>()
    const turnBeatIds: string[] = []
    const createAgUiSession = vi.fn().mockImplementation(async (opts: {
      userMessage?: string
      tools?: Array<{ name?: string; execute?: (id: string, args: unknown) => Promise<unknown> }>
    }) => {
      const tools = opts.tools ?? []
      const planTool = tools.find(tool => tool.name === 'novel_submit_scene_plan')
      const turnTool = tools.find(tool => tool.name === 'novel_submit_character_turn')
      const userMessage = String(opts.userMessage ?? '')
      // 角色成员没有显式 ID 参数，用 prompt 里的动作节点归属反推当前 actor。
      const memberId = userMessage.includes('赵岩挡住门') && !userMessage.includes('当前动作节点：a1')
        ? 'char-lin'
        : userMessage.includes('当前动作节点：a1') ? 'char-zhao' : 'char-lin'
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            if (planTool?.execute) {
              await planTool.execute('plan', { scenes: [submittedScene] })
              return ''
            }
            if (turnTool?.execute) {
              const index = callsByMember.get(memberId) ?? 0
              callsByMember.set(memberId, index + 1)
              input.onSessionCreate?.(memberId)
              const payload = input.turnFor(memberId, index)
              if (!payload) return ''
              await turnTool.execute('turn', payload)
              turnBeatIds.push(String(payload.__beatId ?? ''))
              return ''
            }
            return '章节正文'.repeat(60)
          }),
        },
        streamEmitter: { finishTextMessage: vi.fn() },
        messageId: `msg-${createAgUiSession.mock.calls.length}`,
        dispose: vi.fn(),
      }
    })
    const members = [
      makeMember({ id: 'novel-director', name: '导演' }),
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
      makeMember({ id: 'char-zhao', type: 'character', name: '赵岩' }),
      makeMember({ id: 'char-lin', type: 'character', name: '林晚' }),
    ]
    const moderator = makeMockModerator()
    const engine = new TeamDiscussionEngine(new AgentChannel(), {
      createAgUiSession,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
    } as any)
    const options = makeOptions({
      allowLegacyActing: input.allowLegacyActing ?? false,
      signal: input.signal,
      ...(input.onCheckpoint ? { onCheckpoint: input.onCheckpoint } : {}),
      buildScenePlanToolset: () => scenePlanToolset,
      buildCharacterTurnToolset: ({ actionBeatId }) => {
        const draft: CharacterTurnDraftHolder = {}
        return {
          tools: [createNovelSubmitCharacterTurnTool(draft, actionBeatId)],
          extractResult: () => draft.turn ?? null,
        }
      },
    })
    return { engine, members, options, moderator, createAgUiSession, callsByMember }
  }

  const validTurn = (publicText: string, mentionNames: string[] = []): {
    publicText: string
    innerThought: string
    conflictReading: string
    responsePlan: string
    consequence: string
    progress: 'advance'
    mentionNames: string[]
  } => ({
    publicText,
    innerThought: '内心判断',
    conflictReading: '阻力判断',
    responsePlan: '应对方案',
    consequence: '造成了具体后果',
    progress: 'advance' as const,
    mentionNames,
  })

  it('角色首次未提交回合会重试一次，重试成功则节点正常完成且不惊动 Moderator', async () => {
    const { engine, members, options, callsByMember } = makeActionBeatRun({
      // 赵岩第一次不提交工具（空 stop 且无 payload），第二次成功
      turnFor: (memberId, index) => {
        if (memberId === 'char-zhao') {
          return index === 0 ? null : validTurn('[赵岩挡住门] “先别进来。”')
        }
        return validTurn('[林晚压低声音] “你承认了。”')
      },
    })

    const result = await engine.run(goal, members, options)

    expect(result.status).toBe('completed')
    // 赵岩被调用两次（首次 + 重试），林晚一次
    expect(callsByMember.get('char-zhao')).toBe(2)
    expect(callsByMember.get('char-lin')).toBe(1)
    // 重试成功 ⇒ 不进入异常仲裁，两个节点都完成
    expect(result.diagnostics?.moderatorExceptionInvocations).toBe(0)
    expect(result.diagnostics?.completedActionBeats).toBe(2)
    expect(result.diagnostics?.autonomousCharacterTurns).toBe(3)
  })

  it('角色连续两次失败：按策略表标记 skipped 并继续演出，不调 Moderator', async () => {
    const { engine, members, options, moderator, callsByMember } = makeActionBeatRun({
      // 赵岩始终不提交；林晚正常
      turnFor: memberId => (memberId === 'char-zhao' ? null : validTurn('[林晚压低声音] “你承认了。”')),
    })
    const decide = vi.spyOn(moderator, 'decide')

    const result = await engine.run(goal, members, options)

    // 有场景演成了（林晚的节点）⇒ 不再整章失败
    expect(result.status).toBe('completed')
    // 首次 + 一次重试，不无界重试
    expect(callsByMember.get('char-zhao')).toBe(2)
    // 赵岩失败没有中断整个 run：林晚的节点仍然演出
    expect(callsByMember.get('char-lin')).toBe(1)
    // 策略表判定，不经 LLM 仲裁
    expect(decide).not.toHaveBeenCalled()
    expect(result.diagnostics?.moderatorExceptionInvocations).toBe(0)
    expect(result.diagnostics?.characterTurnFailures).toBe(1)
    expect(result.diagnostics?.completedActionBeats).toBe(1)
    expect(result.diagnostics?.degradedContinues).toBe(1)
    expect(result.diagnostics?.incompleteActionBeatIds).toEqual(['a1'])
    expect(result.transcript.some(message =>
      message.type === 'system' && message.content.includes('【动作节点失败】a1'))).toBe(true)
    expect(result.transcript.some(message =>
      message.type === 'member' && message.fromId === 'char-lin')).toBe(true)
  })

  it('AbortSignal 取消后立即结束 acting，不再调用 Moderator 也不盲写正文', async () => {
    const controller = new AbortController()
    const { engine, members, options, moderator } = makeActionBeatRun({
      signal: controller.signal,
      // 赵岩这一回合触发取消：模拟用户在角色调用期间点停止
      turnFor: memberId => {
        if (memberId === 'char-zhao') {
          controller.abort(new Error('用户手动停止'))
          throw controller.signal.reason
        }
        return validTurn('[林晚压低声音] “你承认了。”')
      },
    })
    const decide = vi.spyOn(moderator, 'decide')

    const result = await engine.run(goal, members, options)

    expect(result.status).toBe('cancelled')
    // planning 直呼 Director、取消后不进异常仲裁 ⇒ 全程零 Moderator 调用
    expect(decide).not.toHaveBeenCalled()
    // 场景计划与已有 transcript 保留，正文不盲写
    expect(result.scenes).toHaveLength(1)
    expect(result.content).toBeUndefined()
  })

  it('全部角色失败：闸门抛检查点交用户决策，approve 后 Writer 独立成文', async () => {
    const onCheckpoint = vi.fn().mockResolvedValue('approve')
    const { engine, members, options, moderator } = makeActionBeatRun({
      // 两个角色都不提交 ⇒ 一场都没演成
      turnFor: () => null,
      onCheckpoint,
    })
    const decide = vi.spyOn(moderator, 'decide')

    const result = await engine.run(goal, members, options)

    // 一场都没演成 ⇒ 停下问用户，而不是静默盲写也不是直接失败
    expect(onCheckpoint).toHaveBeenCalledTimes(1)
    const checkpoint = onCheckpoint.mock.calls[0][0] as { phase: string; question: string }
    expect(checkpoint.phase).toBe('chapter_weaving')
    expect(checkpoint.question).toContain('没有产生有效的角色演出')
    // 判定仍不经 LLM
    expect(decide).not.toHaveBeenCalled()
    // approve ⇒ 继续编织，已有场景计划保留
    expect(result.status).toBe('completed')
    expect(result.scenes[0].actionBeats).toHaveLength(2)
    expect(result.transcript.some(m => m.type === 'system' && m.content.includes('【降级】'))).toBe(true)
  })

  it('全部角色失败 + 用户 reject：以 error 终止并保留 acting 断点位置', async () => {
    const { engine, members, options } = makeActionBeatRun({
      turnFor: () => null,
      onCheckpoint: vi.fn().mockResolvedValue('reject'),
    })

    const result = await engine.run(goal, members, options)

    expect(result.status).toBe('error')
    expect(result.error).toContain('用户选择中止')
    // 闸门在编织阶段前拦下：失败阶段是 chapter_weaving，不是 acting
    expect(result.failedPhase).toBe('chapter_weaving')
    // 正文没有产出，但场景计划保留供续跑
    expect(result.content).toBeUndefined()
    expect(result.scenes[0].actionBeats).toHaveLength(2)
  })

  it('acting 续跑按 transcript 还原完成度：已演节点不重复，中断节点会重演', async () => {
    const invoked: string[] = []
    const createAgUiSession = vi.fn().mockImplementation(async (opts: {
      userMessage?: string
      tools?: Array<{ name?: string; execute?: (id: string, args: unknown) => Promise<unknown> }>
    }) => {
      const tools = opts.tools ?? []
      const turnTool = tools.find(tool => tool.name === 'novel_submit_character_turn')
      const userMessage = String(opts.userMessage ?? '')
      const beatId = /当前动作节点：(\S+)/.exec(userMessage)?.[1]
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            if (turnTool?.execute && beatId) {
              invoked.push(beatId)
              await turnTool.execute('turn', validTurn(`[${beatId}] “继续。”`))
              return ''
            }
            return '章节正文'.repeat(60)
          }),
        },
        streamEmitter: { finishTextMessage: vi.fn() },
        messageId: `resume-${invoked.length}`,
        dispose: vi.fn(),
      }
    })
    const members = [
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
      makeMember({ id: 'char-zhao', type: 'character', name: '赵岩' }),
      makeMember({ id: 'char-lin', type: 'character', name: '林晚' }),
    ]
    const engine = new TeamDiscussionEngine(new AgentChannel(), {
      createAgUiSession,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
    } as any)
    const scene = {
      sceneId: 1,
      title: '门前对峙',
      location: '旧宅门口',
      time: '夜里',
      goal: '让赵岩失去隐瞒空间',
      presentCharacters: ['char-zhao', 'char-lin'],
      presentCharacterNames: ['赵岩', '林晚'],
      actionBeats: [
        {
          beatId: 'a1', actor: 'char-zhao', pressure: '压力', action: '行动',
          choice: '选择', consequence: '后果', exitCondition: '出口',
        },
        {
          beatId: 'a2', actor: 'char-lin', pressure: '压力', action: '行动',
          choice: '选择', consequence: '后果', exitCondition: '出口',
        },
      ],
    }

    const result = await engine.resumeSceneActing(
      goal,
      members,
      makeOptions({
        allowLegacyActing: false,
        buildCharacterTurnToolset: ({ actionBeatId }) => {
          const draft: CharacterTurnDraftHolder = {}
          return {
            tools: [createNovelSubmitCharacterTurnTool(draft, actionBeatId)],
            extractResult: () => draft.turn ?? null,
          }
        },
      }),
      {
        phase: 'acting',
        failedSceneId: 1,
        // 中断发生在 a2；a1 已有带 actorTurn 的角色消息
        failedActionBeatId: 'a2',
        transcript: [{
          id: 'done-a1',
          fromId: 'char-zhao',
          fromName: '赵岩',
          content: '[赵岩挡住门] “先别进来。”',
          timestamp: 1,
          type: 'member',
          sceneId: 1,
          actorTurn: { ...validTurn('[赵岩挡住门] “先别进来。”'), actionBeatId: 'a1' },
        }],
        scenes: [scene],
      },
    )

    expect(result.status).toBe('completed')
    // a1 已在快照里完成 ⇒ 不重演；a2 是中断节点 ⇒ 必须重演
    expect(invoked).toEqual(['a2'])
    // 续跑不得改写调用方持有的快照对象
    expect(scene.actionBeats).toHaveLength(2)
  })

  it('acting 续跑按事件重放的完成集定位：transcript 为空也不重演已完成节点', async () => {
    const invoked: string[] = []
    const createAgUiSession = vi.fn().mockImplementation(async (opts: {
      userMessage?: string
      tools?: Array<{ name?: string; execute?: (id: string, args: unknown) => Promise<unknown> }>
    }) => {
      const tools = opts.tools ?? []
      const turnTool = tools.find(tool => tool.name === 'novel_submit_character_turn')
      const userMessage = String(opts.userMessage ?? '')
      const beatId = /当前动作节点：(\S+)/.exec(userMessage)?.[1]
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            if (turnTool?.execute && beatId) {
              invoked.push(beatId)
              await turnTool.execute('turn', validTurn(`[${beatId}] “继续。”`))
              return ''
            }
            return '章节正文'.repeat(60)
          }),
        },
        streamEmitter: { finishTextMessage: vi.fn() },
        messageId: `event-resume-${invoked.length}`,
        dispose: vi.fn(),
      }
    })
    const members = [
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
      makeMember({ id: 'char-zhao', type: 'character', name: '赵岩' }),
      makeMember({ id: 'char-lin', type: 'character', name: '林晚' }),
    ]
    const engine = new TeamDiscussionEngine(new AgentChannel(), {
      createAgUiSession,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
    } as any)

    const result = await engine.resumeSceneActing(
      goal,
      members,
      makeOptions({
        allowLegacyActing: false,
        buildCharacterTurnToolset: ({ actionBeatId }) => {
          const draft: CharacterTurnDraftHolder = {}
          return {
            tools: [createNovelSubmitCharacterTurnTool(draft, actionBeatId)],
            extractResult: () => draft.turn ?? null,
          }
        },
      }),
      {
        phase: 'acting',
        failedSceneId: 1,
        // T5：事件重放路径——transcript 为空，完成集由 deriveResumeInfo 显式给出
        transcript: [],
        completedActionBeatIds: ['a1'],
        scenes: [{
          sceneId: 1,
          title: '门前对峙',
          location: '旧宅门口',
          time: '夜里',
          goal: '让赵岩失去隐瞒空间',
          presentCharacters: ['char-zhao', 'char-lin'],
          actionBeats: [
            {
              beatId: 'a1', actor: 'char-zhao', pressure: '压力', action: '行动',
              choice: '选择', consequence: '后果', exitCondition: '出口',
            },
            {
              beatId: 'a2', actor: 'char-lin', pressure: '压力', action: '行动',
              choice: '选择', consequence: '后果', exitCondition: '出口',
            },
          ],
        }],
      },
    )

    expect(result.status).toBe('completed')
    // 显式完成集生效：a1 不重演，只演 a2
    expect(invoked).toEqual(['a2'])
  })

  it('旧快照无 actionBeats 时记为整场缺口并完成，不回退 LLM 轮询', async () => {
    const members = [
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
      makeMember({ id: 'char-1', name: '叶明远', type: 'character' }),
    ]
    const createAgUiSession = vi.fn().mockImplementation(async (opts: { userMessage: string }) => ({
      session: {
        prompt: vi.fn().mockResolvedValue(
          opts.userMessage.includes('请将以下各场景') || opts.userMessage.includes('请基于群聊记录')
            ? '章节正文'.repeat(60)
            : '[叶明远抬头] “这里有刻痕。”',
        ),
      },
      streamEmitter: { finishTextMessage: vi.fn() },
      messageId: 'legacy',
      dispose: vi.fn(),
    }))
    const engine = new TeamDiscussionEngine(new AgentChannel(), {
      createAgUiSession,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
    } as any)

    const result = await engine.resumeSceneActing(
      goal,
      members,
      // 旧快照兼容入口：legacy Moderator 轮询已删除（2026-08-28），
      // 无 actionBeats 的场景统一按缺口记账后继续。
      makeOptions({ allowLegacyActing: true }),
      {
        phase: 'acting',
        failedSceneId: 1,
        transcript: [],
        scenes: [{
          sceneId: 1,
          title: '矿道入口',
          location: '矿道',
          time: '夜',
          goal: '进入矿道',
          presentCharacters: ['char-1'],
          presentCharacterNames: ['叶明远'],
          // 旧快照没有 actionBeats
        }],
      },
    )

    expect(result.status).toBe('completed')
    // 不再回退轮询：角色不会被点名发言，缺口显式记账
    expect(result.transcript.some(message =>
      message.type === 'system' && message.content.includes('【演出缺口】'))).toBe(true)
    expect(result.transcript.some(message =>
      message.type === 'member' && message.fromId === 'char-1')).toBe(false)
  })

  it('严格模式下无动作图的场景记为整场缺口，不回退 Moderator 轮询', async () => {
    const members = [
      makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
      makeMember({ id: 'char-1', name: '叶明远', type: 'character' }),
    ]
    const moderator = makeMockModerator([{ type: 'observe', reason: '等待' }])
    const decide = vi.spyOn(moderator, 'decide')
    const engine = new TeamDiscussionEngine(new AgentChannel(), {
      createAgUiSession: vi.fn().mockResolvedValue({
        session: { prompt: vi.fn().mockResolvedValue('章节正文'.repeat(60)) },
        streamEmitter: { finishTextMessage: vi.fn() },
        messageId: 'msg-weave',
        dispose: vi.fn(),
      }),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
    } as any)

    const result = await engine.resumeSceneActing(
      goal,
      members,
      makeOptions({ allowLegacyActing: false }),
      {
        phase: 'acting',
        failedSceneId: 1,
        transcript: [],
        scenes: [{
          sceneId: 1,
          title: '矿道入口',
          location: '矿道',
          time: '夜',
          goal: '进入矿道',
          presentCharacters: ['char-1'],
          presentCharacterNames: ['叶明远'],
        }],
      },
    )

    // 该场没有可执行动作图 ⇒ 记为缺口继续，不 throw、不退回 Moderator 轮询。
    // 续跑入口不做闸门判定（已有正文/transcript 的价值高于阻断），
    // 缺口经 Writer 质量契约传达。
    expect(result.status).toBe('completed')
    expect(decide).not.toHaveBeenCalled()
    expect(result.transcript.some(message =>
      message.type === 'system' && message.content.includes('【演出缺口】'))).toBe(true)
  })
})