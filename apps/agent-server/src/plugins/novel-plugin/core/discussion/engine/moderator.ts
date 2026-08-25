/**
 * Moderator：群聊主持人 LLM 决策器
 *
 * 每轮看群聊历史 + 目标，结构化输出下一步决策。
 * 用最便宜的小模型跑，单次几百 token。
 * LLM 不可用时降级为规则协调（按成员顺序轮流，3 轮后强制 converge）。
 */

import type { FastifyBaseLogger } from 'fastify'
import type { PluginSessionHandle } from '../../../../../core/plugin/plugin-types.js'
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
    signal?: AbortSignal
  }): Promise<PluginSessionHandle>
  logger: FastifyBaseLogger
}

/**
 * Moderator 单次 LLM 调用超时（2026-08-24 二次调整：45s → 90s，可经设置覆盖）。
 *
 * 实测同 Provider 下 minimax-m2.7 的单次调用延迟普遍在 70–150s（含思考）：
 * Director 一次规划 120s、Writer 一次成文 100s。45s×2 的预算对该模型必然
 * 双次超时 → 每轮降级。默认提到 90s；可用讨论设置 moderatorTimeoutMs 覆盖。
 * 注意重试仍是两次：对这类模型宁可慢，也不要整场退化为规则协调。
 */
const MODERATOR_TIMEOUT_MS = 90_000

export class Moderator {
  constructor(
    private context: ModeratorContext,
    private model?: { provider: string; modelId: string },
    /**
     * 运行时限制（2026-08-24 演绎链路修复）：降级协调的强制收敛轮数此前硬编码为 3，
     * 与引擎的 maxRoundsPerScene 完全脱钩——用户把单场景轮数调到 10，一旦降级仍每场
     * 3 轮封顶。现在由调用方注入，缺省回落 DISCUSSION_LIMITS。
     */
    private limits?: { maxRoundsPerScene?: number; timeoutMs?: number },
  ) {}

  /** 最近一次失败的原因摘要（超时/Provider 报错/解析失败），供 UI 警告透出 */
  get lastErrorReason(): string {
    return this.lastFailureReason
  }
  private lastFailureReason = ''

  async decide(
    goal: DiscussionGoal,
    history: DiscussionMessage[],
    members: DiscussionMember[],
    state: ModeratorState,
    signal?: AbortSignal,
  ): Promise<ModeratorDecision> {
    const systemPrompt = this.buildSystemPrompt(members, state)
    const userMessage = this.buildUserPrompt(goal, history, state)
    const spokenIds = this.collectSpokenMemberIds(history, state)
    const lastSpeech = this.collectLastSpeech(history)

    // 首次尝试：正常 prompt。
    // 若失败原因是"输出无法解析"（思考型模型常见：整段散文没有 JSON），
    // 第二次改用纠正性重试——明确告知上一次没有 JSON、第一个字符必须是 {，
    // 比原样重发同一段 prompt 的成功率高一截。
    let firstAttemptFailedWithParseError = false

    try {
      const result = await this.callLlm(systemPrompt, userMessage, signal)
      return this.enforceDecision(this.parseDecision(result), members, state, spokenIds)
    } catch (err) {
      if (signal?.aborted) throw err
      this.lastFailureReason = err instanceof Error ? err.message : String(err)
      firstAttemptFailedWithParseError = this.lastFailureReason.includes('JSON')
      this.context.logger.warn(
        { err, phase: state.phase, round: state.round, reason: this.lastFailureReason },
        'Moderator LLM 调用失败，尝试重试',
      )
      try {
        const retryUserMessage = firstAttemptFailedWithParseError
          ? `${userMessage}\n\n---\n\n## 重试要求（上一次的回复没有输出可解析的 JSON）\n\n现在只输出一个 JSON 对象：第一个字符必须是 {，最后一个字符必须是 }。不要输出任何解释、思考过程或 markdown 代码块。\n格式示例：\n{"type":"invite","agentId":"成员ID","prompt":"给该成员的任务","reason":"一句话理由"}`
          : userMessage
        const retryResult = await this.callLlm(systemPrompt, retryUserMessage, signal)
        return this.enforceDecision(this.parseDecision(retryResult), members, state, spokenIds)
      } catch (retryErr) {
        if (signal?.aborted) throw retryErr
        this.degradedCount++
        this.lastFailureReason = retryErr instanceof Error ? retryErr.message : String(retryErr)
        this.context.logger.error(
          {
            err: retryErr,
            phase: state.phase,
            round: state.round,
            reason: this.lastFailureReason,
            model: this.model,
          },
          'Moderator LLM 重试仍失败，降级为规则协调（未发言者优先 + 场景契约点名）。请检查 moderatorModel 配置或默认模型是否可用。',
        )
        return this.fallbackDecide(members, state, spokenIds, lastSpeech)
      }
    }
  }

  /**
   * 本次运行中 Moderator 降级轮数（双次尝试均失败才计一次轮）。
   * 引擎重置后读取，写入 diagnostics.moderatorDegradedRounds。
   */
  get degradedRounds(): number {
    return this.degradedCount
  }
  private degradedCount = 0

  /** 最近一条角色/成员发言（供降级点名构造具体刺激，避免裸模板导致刻板演出） */
  private collectLastSpeech(history: DiscussionMessage[]): { name: string; excerpt: string } | undefined {
    for (let i = history.length - 1; i >= 0; i--) {
      const message = history[i]
      if (message.type !== 'member') continue
      const excerpt = message.content.replace(/\s+/g, ' ').trim().slice(0, 60)
      if (!excerpt) continue
      return { name: message.fromName, excerpt }
    }
    return undefined
  }

  private async callLlm(systemPrompt: string, userMessage: string, signal?: AbortSignal): Promise<string> {
    const session = await this.context.createSession({
      systemPrompt,
      userMessage,
      timeoutMs: this.limits?.timeoutMs ?? MODERATOR_TIMEOUT_MS,
      model: this.model,
      signal,
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
2. 让在场角色围绕场景"冲突"做选择，目标是产生可供 Writer 使用的行动与台词，不是让角色复述剧情方案
3. prompt 只给刺激、对手、风险或必须面对的选择。示例："赵岩，你父亲刚指责你办事不力。你此刻最想保住什么，会怎样回应？"
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
- **不预写答案**：不得规定角色必须得出什么结论、提出哪套方案、证明什么事实、完成哪种情绪变化或说出哪句台词
- **不代替角色选择**：场景目标是边界，不是指定结果。角色可以失败、回避、误判、拒绝或提出意外但符合人设的行动
- **不新增信息**：prompt 只能引用当前场景和群聊中已经出现的事实，不能把作者真相或其他角色秘密塞给被点名角色
- **不要越权**：你不写正文，不替角色发言，只协调谁该说话

## 一次点名多个角色（仅演出阶段）
同一场景里，若多个角色**掌握的信息完全相同**（没有一方知道另一方不知道的事），
可以在 \`agentIds\` 里一次点名 2-4 人，让他们连续对戏。这能显著减少调用开销。

- 有信息差的角色**不要**放进同一个 \`agentIds\`：那会把秘密泄露给不该知道的角色
- 不确定是否有信息差时，宁可分开点名
- \`agentIds\` 的顺序就是出场顺序；\`agentId\` 填首个
- 单人发言时不要给 \`agentIds\`

## 输出格式
输出 JSON，不要其他内容：
\`\`\`json
{
  "type": "invite" | "pause" | "converge" | "next_scene" | "observe",
  "agentId": "成员ID（invite/converge 时必填）",
  "agentIds": ["成员ID1", "成员ID2"]（invite 且需多角色同场对戏时可选）,
  "prompt": "给该成员的具体任务（invite 时必填，要具体）",
  "scope": "scene|chapter（converge 时必填）",
  "question": "问用户的问题（pause 时必填）",
  "options": ["选项A", "选项B"]（pause 时可选）,
  "reason": "决策理由（必填，一句话）"
}
\`\`\``
  }

  private buildUserPrompt(goal: DiscussionGoal, history: DiscussionMessage[], _state: ModeratorState): string {
    const recentHistory = history.slice(-15)
    const transcript = recentHistory.map(m => `[${m.fromName}] ${m.content}`).join('\n\n')
    return `## 目标\n${goal.task}\n\n## 群聊记录（最近${recentHistory.length}条）\n${transcript}\n\n## 请决策下一步`
  }

  /** 收集当前场景（或全局，规划阶段）已发言成员 ID，供降级轮转"未发言者优先" */
  private collectSpokenMemberIds(history: DiscussionMessage[], state: ModeratorState): Set<string> {
    const sceneId = state.currentScene?.sceneId
    const spoken = new Set<string>()
    for (const message of history) {
      if (message.type !== 'member') continue
      // 演出阶段只统计本场景的发言；规划阶段无 currentScene，统计全部
      if (sceneId != null && message.sceneId != null && message.sceneId !== sceneId) continue
      spoken.add(message.fromId)
    }
    return spoken
  }

  /** 降级决策：Moderator LLM 不可用时按规则协调 */
  private fallbackDecide(
    members: DiscussionMember[],
    state: ModeratorState,
    spokenIds: Set<string> = new Set(),
    lastSpeech?: { name: string; excerpt: string },
  ): ModeratorDecision {
    if (members.length === 0) {
      return { type: 'observe', reason: '降级模式：无可用成员' }
    }
    const speakers = state.phase === 'acting'
      ? members.filter(m => m.type === 'character')
      : state.phase === 'planning'
        ? members.filter(m => m.type === 'role' && (m.id === 'novel-director' || m.id.includes('director')))
        : members
    const converger = members.find(m => m.canConverge)
    // 降级强制收敛轮数与引擎 maxRoundsPerScene 对齐（此前硬编码 3，导致降级时每场最多 3 轮）
    const forceConvergeRound = this.limits?.maxRoundsPerScene ?? DISCUSSION_LIMITS.MAX_ROUNDS_PER_SCENE

    // 规划阶段：优先点名 Director（让 Director 先拆场），超限强制收敛
    // 演出阶段：未发言者优先轮流发言，全员发言过一轮后再按序轮转
    // 超过 forceConvergeRound 强制收敛
    if (state.phase !== 'free_chat' && state.round >= forceConvergeRound && converger) {
      return {
        type: 'converge',
        agentId: converger.id,
        scope: state.phase === 'planning' ? 'chapter' : 'scene',
        reason: `降级模式：轮数达上限（${forceConvergeRound}），强制收敛`,
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

    // 未发言者优先：保证在场每个角色至少发言一次，避免顺序轮转漏人
    // （旧逻辑 round % speakers.length 在 ≥4 人同场时必有人零发言）
    const next = speakers.find(member => !spokenIds.has(member.id))
      ?? speakers[state.round % speakers.length]
    return {
      type: 'invite',
      agentId: next.id,
      prompt: state.phase === 'planning'
        ? '请基于当前群聊记录继续推进规划任务。'
        : this.buildFallbackActingPrompt(next, state.currentScene, lastSpeech),
      reason: '降级模式：未发言者优先轮流发言',
    }
  }

  /**
   * 降级演出的点名 prompt（2026-08-24 刻板演出修复）。
   *
   * 旧模板只有"请基于当前群聊记录演出场景X中你的部分"，没有任何刺激、对手和
   * 抉择——实测一次运行中 Moderator 全程降级，演员只能交差式挤出口号
   * （29 字符的"三件事：止血，找据点，摸规则。"）。现在即使降级，也用场景契约
   * + 最近对手台词构造具体刺激，与正常 Moderator 的点名质量对齐。
   */
  private buildFallbackActingPrompt(
    member: DiscussionMember,
    scene: ModeratorState['currentScene'],
    lastSpeech?: { name: string; excerpt: string },
  ): string {
    if (!scene) {
      return `请以 ${member.name} 的身份推进当前讨论。`
    }
    // 去掉字段尾部句号再拼接，避免"。。"；对手台词剥掉剧本标记后截断
    const conflict = (scene.conflict ?? '无').replace(/[。.]+\s*$/, '')
    const goal = (scene.goal || '').replace(/[。.]+\s*$/, '')
    const parts = [
      `${member.name}，现在轮到你。`,
      `场景「${scene.title}」：${scene.location}，${scene.time}。冲突：${conflict}。本场要完成的推进：${goal}。`,
    ]
    if (lastSpeech && lastSpeech.name !== member.name) {
      parts.push(`你刚听到 ${lastSpeech.name} 说："${this.sanitizeSpeechExcerpt(lastSpeech.excerpt)}"。按你的性格、目标和已知信息做出回应或行动。`)
    } else if (lastSpeech) {
      parts.push(`你刚说完："${this.sanitizeSpeechExcerpt(lastSpeech.excerpt)}"。场面在等你继续或收住这一拍。`)
    }
    parts.push('只演此刻一个动作单元（2-6 行剧本），给对手留下可接的话头；不要替其他角色发言，不要复述别人的话。')
    return parts.join('\n')
  }

  /** 台词摘要清洗：剥离剧本动作标记与引号、压平空白、按完整语义截断到 ~48 字 */
  private sanitizeSpeechExcerpt(raw: string): string {
    const cleaned = raw
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/[“”「」『』"]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (cleaned.length <= 48) return cleaned
    const cut = cleaned.slice(0, 48)
    const lastStop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('，'), cut.lastIndexOf('；'))
    return (lastStop > 12 ? cut.slice(0, lastStop + 1) : cut) + '……'
  }

  /** 对 LLM 决策施加代码级阶段边界，避免仅依赖 prompt 约束。 */
  private enforceDecision(
    decision: ModeratorDecision,
    members: DiscussionMember[],
    state: ModeratorState,
    spokenIds: Set<string> = new Set(),
  ): ModeratorDecision {
    if (decision.type === 'invite') {
      // 用局部常量持有窄化后的 invite 决策：下方对 agentIds 的修正会产生新对象，
      // 直接重新赋值 `decision` 会让 TS 丢掉这个分支的类型窄化。
      const invite = decision
      const selected = members.find(member => member.id === invite.agentId)
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
            : this.fallbackDecide(members, state, spokenIds)
        }
      }
      if (state.phase === 'acting' && selected?.type !== 'character') {
        return this.fallbackDecide(members, state, spokenIds)
      }
      if (state.phase === 'free_chat' && !selected) {
        return this.fallbackDecide(members, state, spokenIds)
      }
      // 多角色点名：剔除不存在或非角色的 id。
      // 规划/自由聊天阶段不允许多角色（那两个阶段本就只该有一个成员发言）。
      if (invite.agentIds) {
        if (state.phase !== 'acting') {
          return { ...invite, agentIds: undefined }
        }
        const valid = invite.agentIds.filter((id) =>
          members.some((m) => m.id === id && m.type === 'character'),
        )
        return { ...invite, agentIds: valid.length > 1 ? valid : undefined }
      }
      return invite
    }

    if (decision.type === 'converge') {
      // 规划阶段收敛必须是 chapter scope：引擎只在 scope==='chapter' 时退出 planning 循环。
      // 若 Moderator 返回 scene scope，旧逻辑会跑满 maxRounds 后 scenes=[] 落入盲写降级
      // （2026-08-24 演绎链路修复：代码级纠偏，不依赖 prompt）。
      if (state.phase === 'planning' && decision.scope !== 'chapter') {
        return { ...decision, scope: 'chapter', reason: `${decision.reason}（规划阶段收敛自动按 chapter 处理）` }
      }
      const converger = members.find(member => member.id === decision.agentId && member.canConverge)
      if (!converger) return this.fallbackDecide(members, state, spokenIds)
    }

    return decision
  }

  /** 解析 Moderator 输出为决策（容错 markdown 包裹与思考块） */
  private parseDecision(raw: string): ModeratorDecision {
    // 思考型模型（minimax-m2 等）会先输出 <think>…</think> 再给答案；
    // 思考里可能有大括号干扰提取，先剥掉。
    const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = this.tryParseDecision(jsonMatch[0])
      if (parsed) return parsed
    }
    // 贪婪匹配失败（思考含大括号导致跨对象拼接 / 前后杂文本）时，
    // 退化为平铺扫描：决策 JSON 是单层结构，逐个尝试 {...} 无嵌套片段
    for (const flat of cleaned.matchAll(/\{[^{}]*\}/g)) {
      const parsed = this.tryParseDecision(flat[0])
      if (parsed) return parsed
    }
    throw new Error('Moderator 输出无法解析为 JSON')
  }

  /** 尝试解析并校验一段候选 JSON；非法返回 undefined，字段问题抛错进重试 */
  private tryParseDecision(candidate: string): ModeratorDecision | undefined {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(candidate)
    } catch {
      return undefined
    }
    if (!['invite', 'pause', 'converge', 'next_scene', 'observe'].includes(parsed.type as string)) {
      return undefined
    }
    return this.validateDecisionFields(parsed as ModeratorDecision)
  }

  /** 校验各类型必填字段，缺失时抛错触发重试/降级（错误信息区分原因） */
  private validateDecisionFields(parsed: ModeratorDecision): ModeratorDecision {
    switch (parsed.type) {
      case 'invite':
        if (typeof parsed.agentId !== 'string' || !parsed.agentId) {
          throw new Error('Moderator invite 决策缺少 agentId')
        }
        if (typeof parsed.prompt !== 'string' || !parsed.prompt) {
          throw new Error('Moderator invite 决策缺少 prompt')
        }
        // 多角色点名（可选）：非法值直接丢弃而不抛错 —— 退回单角色仍是正确行为，
        // 为一个可选的优化字段触发重试/降级不值得。
        if (parsed.agentIds !== undefined) {
          if (Array.isArray(parsed.agentIds)) {
            const ids = parsed.agentIds.filter((id: unknown): id is string => typeof id === 'string' && !!id)
            // 去重并保证 agentId 在首位：引擎按此顺序决定演出顺序
            const unique = Array.from(new Set([parsed.agentId, ...ids]))
            parsed.agentIds = unique.length > 1 ? unique : undefined
          } else {
            parsed.agentIds = undefined
          }
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
