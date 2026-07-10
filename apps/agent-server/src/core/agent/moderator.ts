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
      return this.parseDecision(result)
    } catch (err) {
      this.context.logger.warn({ err }, 'Moderator 调用失败，尝试重试')
      try {
        const retryResult = await this.callLlm(systemPrompt, userMessage)
        return this.parseDecision(retryResult)
      } catch (retryErr) {
        this.context.logger.warn({ err: retryErr }, 'Moderator 重试失败，降级为规则协调')
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

    return `你是一个群聊主持人。你的职责是推动一群 Agent 协作完成目标。

## 当前状态
- 阶段：${state.phase}
- 已用轮数：${state.round}
- 当前场景：${state.currentScene ? state.currentScene.title : '无（规划阶段）'}

## 成员列表
${memberList}

## 决策规则
1. 目标未达成且有人该说话 → invite（点名 agentId + 给具体任务 prompt）
2. 出现需要用户拍板的分歧 → pause（明确问什么 + 可选选项）
3. 讨论已充分，可以产出成品 → converge（点名收敛者 + scope: scene|chapter）
4. 刚有人发言，想看群体反应 → observe（最多连续 ${DISCUSSION_LIMITS.MAX_OBSERVE_ROUNDS} 次）
5. 当前场景演完，进入下一个 → next_scene

## 收敛规则
- 只有 canConverge=true 的成员能被 converge
- 规划阶段：Director 完成场景拆分后 converge(scope=chapter) 进入场景循环
- 演出阶段：场景内角色充分演出后 converge(scope=scene) 让 Writer 整理该场景
- 全章阶段：所有场景演完后 converge(scope=chapter) 让 Writer 合并完整正文

## 输出格式
输出 JSON，不要其他内容：
\`\`\`json
{
  "type": "invite" | "pause" | "converge" | "next_scene" | "observe",
  "agentId": "成员ID（invite/converge 时必填）",
  "prompt": "给该成员的具体任务（invite 时必填）",
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
    if (state.round >= 3) {
      const converger = members.find(m => m.canConverge)
      if (converger) {
        return {
          type: 'converge',
          agentId: converger.id,
          scope: state.phase === 'planning' ? 'chapter' : 'scene',
          reason: '降级模式：轮数达上限，强制收敛',
        }
      }
    }
    const next = members[state.round % members.length]
    return {
      type: 'invite',
      agentId: next.id,
      prompt: '请基于当前群聊记录继续推进任务。',
      reason: '降级模式：按顺序轮流发言',
    }
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
    return parsed as ModeratorDecision
  }
}
