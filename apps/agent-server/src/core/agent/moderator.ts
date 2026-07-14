/**
 * Moderator：群聊主持人 LLM 决策器
 *
 * 每轮看群聊历史 + 目标，结构化输出下一步决策。
 * 用最便宜的小模型跑，单次几百 token。
 * LLM 不可用时降级为规则协调（按成员顺序轮流，3 轮后强制 converge）。
 */

import type { FastifyBaseLogger } from 'fastify'
import type { PluginSessionHandle } from '../plugin/plugin-types.js'
import type {
  DiscussionGoal,
  DiscussionMessage,
  DiscussionMember,
  ModeratorDecision,
  ModeratorState,
} from './discussion-types.js'
import { DISCUSSION_LIMITS } from './discussion-types.js'

/** Moderator 创建会话的上下文 */
export interface ModeratorContext {
  createSession(options: {
    systemPrompt: string
    userMessage: string
    timeoutMs: number
    model?: { provider: string; modelId: string }
  }): Promise<PluginSessionHandle>
  logger: FastifyBaseLogger
}

export class Moderator {
  constructor(
    private context: ModeratorContext,
    private model?: { provider: string; modelId: string },
  ) {}

  async decide(
    goal: DiscussionGoal,
    history: DiscussionMessage[],
    members: DiscussionMember[],
    state: ModeratorState,
  ): Promise<ModeratorDecision> {
    const systemPrompt = this.buildSystemPrompt(members, state)
    const userMessage = this.buildUserPrompt(goal, history, state)

    try {
      const result = await this.callLlm(systemPrompt, userMessage)
      return this.enforceDecision(this.parseDecision(result), members, state)
    } catch (err) {
      this.context.logger.warn(
        { err, phase: state.phase, round: state.round, reason: err instanceof Error ? err.message : String(err) },
        'Moderator LLM 调用失败，尝试重试',
      )
      try {
        const retryResult = await this.callLlm(systemPrompt, userMessage)
        return this.enforceDecision(this.parseDecision(retryResult), members, state)
      } catch (retryErr) {
        this.context.logger.error(
          {
            err: retryErr,
            phase: state.phase,
            round: state.round,
            reason: retryErr instanceof Error ? retryErr.message : String(retryErr),
            model: this.model,
          },
          'Moderator LLM 重试仍失败，降级为规则协调（顺序点名）。请检查 moderatorModel 配置或默认模型是否可用。',
        )
        return this.fallbackDecide(members, state)
      }
    }
  }

  private async callLlm(systemPrompt: string, userMessage: string): Promise<string> {
    const session = await this.context.createSession({
      systemPrompt,
      userMessage,
      timeoutMs: 15_000,
      model: this.model,
    })
    try {
      return await session.prompt()
    } finally {
      session.dispose()
    }
  }

  private buildSystemPrompt(members: DiscussionMember[], state: ModeratorState): string {
    const memberList = members.map(m => {
      const profile = m.type === 'character' && m.characterProfile
        ? `（性格：${m.characterProfile.personality}，当前状态：${m.characterProfile.currentState}，目标：${m.characterProfile.currentGoal}）`
        : ''
      const converge = m.canConverge ? ' [可收敛]' : ''
      return `- ${m.id}（${m.name}）${m.type === 'character' ? '角色' : '工种'}${profile}${converge}`
    }).join('\n')

    if (state.phase === 'free_chat') {
      return `你是章节自由聊天的主持人。请从成员列表中选择最适合回答用户问题的一位成员。

## 成员列表
${memberList}

## 规则
1. 只返回 invite 决策
2. agentId 必须来自成员列表
3. prompt 要复述用户问题并明确回答重点

## 输出格式
输出 JSON，不要其他内容：
{"type":"invite","agentId":"成员ID","prompt":"回答任务","reason":"选择理由"}`
    }

    // 解析当前场景在场角色名（presentCharacters 是成员 ID 列表）
    const presentCharacterNames = state.currentScene?.presentCharacters
      ?.map(id => members.find(m => m.id === id)?.name)
      .filter((name): name is string => !!name) ?? []
    const presentText = presentCharacterNames.length > 0
      ? presentCharacterNames.join('、')
      : '未指定'

    const sceneInfo = state.currentScene
      ? `标题：${state.currentScene.title}
地点：${state.currentScene.location}
时间：${state.currentScene.time}
冲突：${state.currentScene.conflict ?? '无'}
目标：${state.currentScene.goal}
情绪走向：${state.currentScene.emotion ?? '未指定'}
在场角色：${presentText}`
      : '无（规划阶段）'

    return `你是一个群聊主持人，负责推动一群 Agent 协作完成小说章节创作。

## 当前状态
- 阶段：${state.phase}
- 已用轮数：${state.round}
- 剩余场景数：${state.scenesRemaining ?? 0}
- 当前场景：
${sceneInfo}

## 成员列表
${memberList}

## 阶段决策指引

### 规划阶段（planning）
1. 第 0 轮：点名 Director（agentId: novel-director）完成场景拆分。prompt 示例："请完成本章的场景拆分规划，输出完整的章节任务。"
2. Director 输出场景拆分后：converge(scope=chapter) 进入场景循环
3. 不要在规划阶段点名角色或 Writer

### 演出阶段（acting）
1. **只点名当前场景的"在场角色"发言**，不要点不在场角色或 Writer
2. 让在场角色围绕场景"冲突"对戏，推动"目标"达成，承载"情绪走向"
3. 给角色的 prompt 要具体：告诉角色当前情境、对手是谁、本回合要做什么。示例："赵岩，你父亲刚指责你办事不力，按你的性格你会怎么回应？"
4. 角色交替发言：A 发言后让 B 响应，B 发言后让 A 或 C 响应，形成对戏
5. 角色充分对戏后（通常 2-4 轮），converge(scope=scene) 结束当前场景
6. 场景内所有角色都发言至少 1 次后，才考虑 converge

### 场景切换
- 当前场景 converge 后，下一轮会自动进入下一个场景的 setup
- 不要手动 next_scene 除非确定当前场景无需角色演出（如纯过渡场景）

### 收敛规则
- 只有 canConverge=true 的成员能被 converge（Writer 或 Reviser）
- 规划阶段：Director 完成场景拆分后 converge(scope=chapter, agentId=novel-writer)
- 演出阶段：场景内角色充分对戏后 converge(scope=scene, agentId=novel-writer)
- 全章阶段：所有场景演完后 converge(scope=chapter, agentId=novel-writer) 让 Writer 一次性编织全章

## 通用决策规则
1. 目标未达成且有人该说话 → invite（点名 agentId + 给具体任务 prompt）
2. 出现需要用户拍板的分歧 → pause（明确问什么 + 可选选项）
3. 讨论已充分，可以产出成品 → converge（点名收敛者 + scope: scene|chapter）
4. 刚有人发言，想看群体反应 → observe（最多连续 ${DISCUSSION_LIMITS.MAX_OBSERVE_ROUNDS} 次）
5. 当前场景演完，进入下一个 → next_scene

## 重要约束
- **演出阶段只点名在场角色**：不在 presentCharacters 列表里的角色不应被邀请发言
- **给具体的 prompt**：不要说"请继续推进"，要说"XX，你刚听到 YY 说 ZZZ，按你的性格你会怎么做？"
- **推动对戏**：让角色之间产生互动，而不是各自独白
- **不要越权**：你不写正文，不替角色发言，只协调谁该说话

## 输出格式
输出 JSON，不要其他内容：
\`\`\`json
{
  "type": "invite" | "pause" | "converge" | "next_scene" | "observe",
  "agentId": "成员ID（invite/converge 时必填）",
  "prompt": "给该成员的具体任务（invite 时必填，要具体）",
  "scope": "scene|chapter（converge 时必填）",
  "question": "问用户的问题（pause 时必填）",
  "options": ["选项A", "选项B"]（pause 时可选）,
  "reason": "决策理由（必填，一句话）"
}
\`\`\``
  }

  private buildUserPrompt(goal: DiscussionGoal, history: DiscussionMessage[], state: ModeratorState): string {
    const recentHistory = history.slice(-15)
    const transcript = recentHistory.map(m => `[${m.fromName}] ${m.content}`).join('\n\n')
    return `## 目标\n${goal.task}\n\n## 群聊记录（最近${recentHistory.length}条）\n${transcript}\n\n## 请决策下一步`
  }

  /** 降级决策：Moderator LLM 不可用时按规则协调 */
  private fallbackDecide(members: DiscussionMember[], state: ModeratorState): ModeratorDecision {
    if (members.length === 0) {
      return { type: 'observe', reason: '降级模式：无可用成员' }
    }
    const speakers = state.phase === 'acting'
      ? members.filter(m => m.type === 'character')
      : state.phase === 'planning'
        ? members.filter(m => m.type === 'role' && (m.id === 'novel-director' || m.id.includes('director')))
        : members
    const converger = members.find(m => m.canConverge)

    // 规划阶段：第 0 轮优先点名 Director（让 Director 先拆场），后续轮让角色发言
    // 演出阶段：按角色顺序发言
    // 超过 3 轮强制收敛
    if (state.phase !== 'free_chat' && state.round >= 3 && converger) {
      return {
        type: 'converge',
        agentId: converger.id,
        scope: state.phase === 'planning' ? 'chapter' : 'scene',
        reason: '降级模式：轮数达上限，强制收敛',
      }
    }

    if (speakers.length === 0) {
      // 没有非收敛成员（异常情况），直接收敛
      if (converger) {
        return {
          type: 'converge',
          agentId: converger.id,
          scope: state.phase === 'planning' ? 'chapter' : 'scene',
          reason: '降级模式：无非收敛成员，直接收敛',
        }
      }
      return { type: 'observe', reason: '降级模式：无可收敛成员' }
    }

    // 规划阶段始终只点名 Director，避免其他成员覆盖场景规划结果
    if (state.phase === 'planning') {
      const director = speakers.find(m => m.type === 'role' && (m.id === 'novel-director' || m.id.includes('director')))
      if (director) {
        return {
          type: 'invite',
          agentId: director.id,
          prompt: '请完成本章的场景拆分规划。按你的 role 输出格式提供完整的章节任务，包括场景拆分。',
          reason: '降级模式：规划阶段优先让 Director 拆场',
        }
      }
    }

    // 其余轮次：按 speakers 顺序轮流
    const next = speakers[state.round % speakers.length]
    return {
      type: 'invite',
      agentId: next.id,
      prompt: state.phase === 'planning'
        ? '请基于当前群聊记录继续推进规划任务。'
        : `请基于当前群聊记录演出场景"${state.currentScene?.title ?? ''}"中你的部分。`,
      reason: '降级模式：按顺序轮流发言',
    }
  }

  /** 对 LLM 决策施加代码级阶段边界，避免仅依赖 prompt 约束。 */
  private enforceDecision(
    decision: ModeratorDecision,
    members: DiscussionMember[],
    state: ModeratorState,
  ): ModeratorDecision {
    if (decision.type === 'invite') {
      const selected = members.find(member => member.id === decision.agentId)
      if (state.phase === 'planning') {
        const director = members.find(member =>
          member.type === 'role' && (member.id === 'novel-director' || member.id.includes('director')),
        )
        if (!selected || selected.id !== director?.id) {
          return director
            ? {
                type: 'invite',
                agentId: director.id,
                prompt: '请完成本章场景拆分规划。',
                reason: '规划阶段只允许 Director 发言',
              }
            : this.fallbackDecide(members, state)
        }
      }
      if (state.phase === 'acting' && selected?.type !== 'character') {
        return this.fallbackDecide(members, state)
      }
      if (state.phase === 'free_chat' && !selected) {
        return this.fallbackDecide(members, state)
      }
    }

    if (decision.type === 'converge') {
      const converger = members.find(member => member.id === decision.agentId && member.canConverge)
      if (!converger) return this.fallbackDecide(members, state)
    }

    return decision
  }

  /** 解析 Moderator 输出为决策（容错 markdown 包裹） */
  private parseDecision(raw: string): ModeratorDecision {
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      throw new Error('Moderator 输出无法解析为 JSON')
    }
    const parsed = JSON.parse(jsonMatch[0])
    if (!['invite', 'pause', 'converge', 'next_scene', 'observe'].includes(parsed.type)) {
      throw new Error(`Moderator 输出 type 非法: ${parsed.type}`)
    }
    // 校验各类型必填字段，缺失时抛错触发重试/降级
    switch (parsed.type) {
      case 'invite':
        if (typeof parsed.agentId !== 'string' || !parsed.agentId) {
          throw new Error('Moderator invite 决策缺少 agentId')
        }
        if (typeof parsed.prompt !== 'string' || !parsed.prompt) {
          throw new Error('Moderator invite 决策缺少 prompt')
        }
        break
      case 'pause':
        if (typeof parsed.question !== 'string' || !parsed.question) {
          throw new Error('Moderator pause 决策缺少 question')
        }
        break
      case 'converge':
        if (typeof parsed.agentId !== 'string' || !parsed.agentId) {
          throw new Error('Moderator converge 决策缺少 agentId')
        }
        if (parsed.scope !== 'scene' && parsed.scope !== 'chapter') {
          throw new Error(`Moderator converge 决策 scope 非法: ${parsed.scope}`)
        }
        break
      case 'next_scene':
      case 'observe':
        // 无额外必填字段
        break
    }
    return parsed as ModeratorDecision
  }
}
