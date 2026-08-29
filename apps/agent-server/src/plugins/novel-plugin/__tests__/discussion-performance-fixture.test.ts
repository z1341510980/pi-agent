import { describe, expect, it, vi } from 'vitest'
import { TeamDiscussionEngine } from '../core/discussion/engine/team-discussion-engine.js'
import { AgentChannel } from '../../../core/agent/agent-channel.js'
import { createNovelSubmitScenePlanTool, createNovelSubmitCharacterTurnTool, type ScenePlanDraftHolder } from '../core/novel-tools.js'
import type { CharacterTurnDraftHolder } from '../core/tools/submit.js'
import type { DiscussionGoal, DiscussionMember, DiscussionOptions } from '../core/discussion/engine/discussion-types.js'

/**
 * 性能 fixture（spec T7 验收 #9）：
 * 固定 5 场景 × 2 节点的计划，断言逻辑调用账目受控——
 * - planning 直呼 Director：Moderator 逻辑调用恒 0（类型面已删除，plannerInvocations=1）
 * - 每节点一次角色调用，无格式纠正重试
 * - 全 run 成员逻辑调用 ≤ 40（旧 Moderator 路径仅 planning 就可能白付 50 次）
 * 墙钟（totalDurationMs）透出供人工对照基线；单测环境无稳定基线，不作硬断言。
 */

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

function validTurn(publicText: string) {
  return {
    publicText,
    innerThought: '内心判断',
    conflictReading: '阻力判断',
    responsePlan: '应对方案',
    consequence: '造成了具体后果',
    progress: 'advance' as const,
    mentionNames: [],
  }
}

describe('discussion performance fixture（5 场景 ≤ 40 次逻辑调用）', () => {
  it('5 场景 × 2 节点的 run 调用账目受控且零格式纠正', async () => {
    const goal: DiscussionGoal = { task: '测试任务', context: '上下文' }
    // 5 场景，每场 2 个节点，赵岩/林晚交替
    const scenePlan = {
      scenes: Array.from({ length: 5 }, (_, sceneIndex) => ({
        title: `场景${sceneIndex + 1}：对峙升级`,
        location: '旧宅门口',
        time: '夜里',
        conflict: '是否开门',
        goal: '推进冲突',
        emotion: '紧张',
        presentCharacters: ['赵岩', '林晚'],
        actionBeats: [
          {
            beatId: `s${sceneIndex + 1}-a1`, actor: '赵岩',
            pressure: '压力', action: '行动', choice: '选择',
            consequence: '后果', exitCondition: '出口',
          },
          {
            beatId: `s${sceneIndex + 1}-a2`, actor: '林晚',
            pressure: '压力', action: '行动', choice: '选择',
            consequence: '后果', exitCondition: '出口',
          },
        ],
      })),
    }
    const sceneDraft: ScenePlanDraftHolder = {}
    const scenePlanToolset = {
      tools: [createNovelSubmitScenePlanTool(sceneDraft, { requireActionBeats: true })],
      extractResult: () => sceneDraft.plan ?? null,
    }
    const createAgUiSession = vi.fn().mockImplementation(async (opts: {
      tools?: Array<{ name?: string; execute?: (id: string, args: unknown) => Promise<unknown> }>
    }) => {
      const tools = opts.tools ?? []
      const planTool = tools.find(tool => tool.name === 'novel_submit_scene_plan')
      const turnTool = tools.find(tool => tool.name === 'novel_submit_character_turn')
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            if (planTool?.execute) {
              await planTool.execute('plan', scenePlan)
              // 工具主路径空终答（gpt-5.6-luna 实证行为）
              return ''
            }
            if (turnTool?.execute) {
              await turnTool.execute('turn', validTurn('[角色] “台词。”'))
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
      makeMember({ id: 'novel-reviewer', name: '审稿' }),
      makeMember({ id: 'char-zhao', type: 'character', name: '赵岩' }),
      makeMember({ id: 'char-lin', type: 'character', name: '林晚' }),
    ]
    const engine = new TeamDiscussionEngine(new AgentChannel(), {
      createAgUiSession,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
    } as any)
    const options: DiscussionOptions = {
      emit: vi.fn(),
      onCheckpoint: vi.fn().mockResolvedValue('approve'),
      onProgress: vi.fn(),
      allowLegacyActing: false,
      buildScenePlanToolset: () => scenePlanToolset,
      buildCharacterTurnToolset: ({ actionBeatId }) => {
        const draft: CharacterTurnDraftHolder = {}
        return {
          tools: [createNovelSubmitCharacterTurnTool(draft, actionBeatId)],
          extractResult: () => draft.turn ?? null,
        }
      },
    }

    const result = await engine.run(goal, members, options)

    expect(result.status).toBe('completed')
    const d = result.diagnostics!
    // planning 直呼：Director 恰好一次，无 Moderator、无格式纠正
    expect(d.plannerInvocations).toBe(1)
    expect(d.totalModeratorInvocations).toBe(0)
    expect(d.formatCorrections).toBe(0)
    // 10 个节点全部完成，每节点一次角色调用
    expect(d.completedActionBeats).toBe(10)
    expect(d.incompleteActionBeats).toBe(0)
    expect(d.autonomousCharacterTurns).toBe(10)
    expect(d.scenesTotal).toBe(5)
    expect(d.scenesWithActing).toBe(5)
    // 逻辑调用账目：诊断快照在 Phase 2.5（编织闸门）生成，
    // 此处 totalMemberInvocations = 1 planning + 10 acting = 11（编织/审稿不计入）。
    // 旧 Moderator 路径仅 planning 就可能白付最多 50 次 LLM 往返，11 ≤ 40 达标。
    expect(d.totalMemberInvocations).toBe(11)
    // 墙钟透出（对照基线为人工/CI 侧工作，测试内只验证可观测）
    expect(d.totalDurationMs).toBeGreaterThanOrEqual(0)
  })
})
