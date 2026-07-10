# 群聊共创模式设计

> 日期：2026-07-10 | 状态：待审查 | 作者：AI 辅助设计

---

## 一、背景与目标

### 1.1 现状

当前 novel 创作流程（[novel-orchestrator.ts](../../../apps/agent-server/src/plugins/novel-plugin/core/novel-orchestrator.ts)）是一条硬编码流水线：

```
Director → [检查点1] → Writer → Reviewer → [检查点2] → revise/rewrite/approve → Memory
```

虽然有 Writer 推回 Director、rewrite 递归等反馈环，但整体顺序、各 Agent 出现时机、结果传递路径都是代码里定死的。所有角色行为是否符合人设，全靠 Writer 一个 LLM 想象，容易 OOC（Out of Character）。

已有基建：
- [agent-channel.ts](../../../apps/agent-server/src/core/agent/agent-channel.ts)：频道广播 + 私信，目前 Novel 流程未使用
- [MULTI_AGENT_DESIGN.md](../../MULTI_AGENT_DESIGN.md)：定义了 `ExecutionStrategy`，其中 `coordinated`（动态协调）被标注"后续迭代再实现"
- `createAgUiSession` 工厂：标准 AG-UI Session 创建，支持流式推送
- `ConfirmationManager`：检查点统一管理（超时/pending/事件）
- `novel-store`：角色卡（含 personality/currentState/currentGoal/secret/arcStage 等字段）

### 1.2 目标

新增一种并行的创作模式——**群聊共创**，与现有 workflow 模式并存，用户可选择：

- **通用群聊引擎**：不依赖 novel 业务，提供"目标驱动的 Agent 群聊自组织"能力
- **顺序自举**：目标给定（如"写完第3章"），谁先谁后、谁接谁的话由 Moderator 涌现决策，最后由收敛 Agent 产出成品
- **角色共创**：群聊成员不限于工种 Agent（Director/Writer/...），还可包含角色 Agent——以角色第一人称演台词+动作，与 Writer 共创正文
- **检查点涌现**：不再由流程代码在固定位置暂停，而是 Moderator 判断"需要用户拍板"时主动挂起
- **小说首发**：通用引擎的首个落地场景是 novel 创作群聊

### 1.3 非目标

- **不修改现有 workflow 模式**：`NovelOrchestrator.createChapterWithFlow` 一行不改，两条路完全独立
- **不做任务自举**：目标（写完第 N 章）由外部给定，群聊不自创任务
- **不做输出涌现**：最终成品由收敛 Agent 产出，不是从对话记录自动长出
- **不替代 Team 抽象**：`MULTI_AGENT_DESIGN.md` 中的 `coordinated` 策略仍按原计划后续迭代，本设计是独立的并行通道

---

## 二、架构总览

### 2.1 模块边界

```
apps/agent-server/src/
├── core/agent/
│   ├── team-discussion-engine.ts     ← 新增：通用群聊引擎（不依赖 novel）
│   ├── moderator.ts                  ← 新增：主持人 LLM 决策器
│   ├── discussion-types.ts           ← 新增：群聊类型定义
│   └── chapter-finalizer.ts          ← 新增：收尾工具类（workflow + discussion 共用）
├── plugins/novel-plugin/core/
│   ├── novel-discussion-runner.ts    ← 新增：novel 适配器
│   ├── novel-orchestrator.ts         ← 不改
│   └── prompts/
│       ├── role-writer-discussion.md ← 新增：群聊模式 Writer 专用 prompt
│       └── role-character-actor.md   ← 新增：角色 Agent 通用 prompt 模板
└── routes/
    └── novel-routes.ts               ← 改：create chapter 接口加 mode 参数

apps/desktop/src/renderer/src/
├── components/novel/
│   └── novel-toolbar.tsx             ← 改：创作按钮加 mode 切换
└── components/settings/
    └── agent-page.tsx                ← 改：加 Moderator 模型配置
```

### 2.2 与现有系统的关系

```
                    ┌─────────────────────────────────┐
                    │   novel-routes.ts               │
                    │   POST /chapters/:n/create      │
                    │   body: { mode: 'workflow' |     │
                    │           'discussion' }         │
                    └────────────┬────────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │                         │
            mode='workflow'            mode='discussion'
                    │                         │
                    ▼                         ▼
        ┌───────────────────┐     ┌───────────────────────┐
        │ NovelOrchestrator │     │ NovelDiscussionRunner │
        │ .createChapter    │     │ .run                  │
        │ WithFlow          │     │                       │
        └───────┬───────────┘     └───────────┬───────────┘
                │                             │
                │          ┌──────────────────┘
                │          │
                ▼          ▼
        ┌──────────────────────────┐
        │   ChapterFinalizer       │ ← 新增：两边共用的收尾逻辑
        │   (落库/Memory/标题/提要) │
        └──────────────────────────┘
                       │
                       ▼
              CreationResult（结构一致，前端无感知）
```

`TeamDiscussionEngine` 是通用的，不知道"小说"是什么。它只懂：目标、成员、消息、收敛。`NovelDiscussionRunner` 负责把 novel 的 Agent 角色翻译成群聊成员，把"写完第 N 章"翻译成群聊目标。

---

## 三、核心类型定义

### 3.1 群聊成员

```typescript
// discussion-types.ts

/** 群聊成员类型 */
export type DiscussionMemberType = 'role' | 'character'

/** 群聊成员 */
export interface DiscussionMember {
  /** 成员 ID（工种用 agentId，角色用 characterId） */
  id: string
  /** 成员类型 */
  type: DiscussionMemberType
  /** 展示名（如"导演"/"赵岩"） */
  name: string
  /** 专长/性格概要（供 Moderator 决策参考） */
  expertise: string
  /** 是否能收敛产出成品（仅 Writer/Reviser 为 true） */
  canConverge: boolean
  /** 角色 Agent：出现在哪些场景（sceneId 序号），工种 Agent 不填 */
  scenePresence?: number[]
  /** 角色 Agent：人设快照（性格/状态/目标/秘密/弧线阶段） */
  characterProfile?: {
    personality: string
    currentState: string
    currentGoal: string
    secret: string
    arcStage: string
    participatingConflicts: string[]
  }
  /** 构建该成员 system prompt 的工厂函数 */
  buildSystemPrompt: () => string
}
```

### 3.2 群聊目标与上下文

```typescript
/** 群聊目标 */
export interface DiscussionGoal {
  /** 高层任务描述（如"创作第3章"） */
  task: string
  /** 章节上下文（SEMI 层 shared 前缀，跨成员复用 prompt cache） */
  context: string
  /** 章节约束（冲突目标/悬念钩子/节奏约束等） */
  constraints?: unknown
}

/** 场景定义（Director 拆场后产出） */
export interface SceneDefinition {
  /** 场景序号 */
  sceneId: number
  /** 场景标题 */
  title: string
  /** 地点 */
  location: string
  /** 时间 */
  time: string
  /** 在场角色 ID 列表 */
  presentCharacters: string[]
  /** 本场景冲突 */
  conflict?: string
  /** 本场景目标 */
  goal: string
}
```

### 3.3 群聊消息

```typescript
/** 群聊消息 */
export interface DiscussionMessage {
  /** 消息 ID */
  id: string
  /** 发送者 ID（'system' | 'moderator' | member.id） */
  fromId: string
  /** 发送者展示名 */
  fromName: string
  /** 消息内容 */
  content: string
  /** 时间戳 */
  timestamp: number
  /** 当前场景序号（Phase 2 场景循环时填充） */
  sceneId?: number
  /** 消息类型 */
  type: 'system' | 'moderator' | 'member' | 'user' | 'error'
}
```

### 3.4 Moderator 决策

```typescript
/** Moderator 决策类型 */
export type ModeratorDecision =
  | { type: 'invite'; agentId: string; prompt: string; reason: string }
  | { type: 'pause'; question: string; options?: string[]; reason: string }
  | { type: 'converge'; agentId: string; scope: 'scene' | 'chapter'; reason: string }
  | { type: 'next_scene'; reason: string }
  | { type: 'observe'; reason: string }
```

### 3.5 运行选项与结果

```typescript
/** 群聊运行选项 */
export interface DiscussionOptions {
  /** AG-UI 事件发射器 */
  emit: AgUiEventSink
  /** 检查点回调（Moderator pause 时触发） */
  onCheckpoint: (checkpoint: DiscussionCheckpoint) => Promise<'approve' | 'reject' | 'revise' | string>
  /** 进度回调 */
  onProgress: (event: DiscussionFlowEvent) => void
  /** 取消信号 */
  signal?: AbortSignal
  /** Moderator 使用的模型配置 */
  moderatorModel?: { provider: string; modelId: string }
}

/** 群聊检查点 */
export interface DiscussionCheckpoint {
  type: 'discussion_pause'
  phase: string
  question: string
  options?: string[]
  context?: string
}

/** 群聊流程事件 */
export interface DiscussionFlowEvent {
  type: 'phase_change' | 'agent_start' | 'scene_change' | 'pause' | 'completed' | 'error' | 'cancelled' | 'data_changed'
  phase: DiscussionPhase
  data: unknown
  timestamp: number
}

/** 群聊阶段 */
export type DiscussionPhase =
  | 'planning'      // Director 规划
  | 'scene_setup'   // 场景初始化
  | 'acting'        // 角色演出
  | 'scene_weaving' // 场景整理（Writer 编织单场景）
  | 'chapter_weaving' // 全章编织（Writer 合并各场景）
  | 'reviewing'     // 审稿
  | 'memory'        // 记忆提取
  | 'completed'
  | 'error'
  | 'cancelled'

/** 群聊运行结果 */
export interface DiscussionResult {
  status: 'completed' | 'cancelled' | 'error'
  /** 最终章节正文 */
  content?: string
  /** 完整群聊记录（供审计/回放） */
  transcript: DiscussionMessage[]
  /** 场景定义列表 */
  scenes: SceneDefinition[]
  /** 状态变更（与 workflow 模式一致） */
  stateChanges?: Array<{ type: string; description: string }>
  error?: string
}
```

---

## 四、核心组件详细设计

### 4.1 TeamDiscussionEngine（通用群聊引擎）

**职责**：驱动群聊循环，不依赖任何业务领域。

```typescript
// team-discussion-engine.ts

export class TeamDiscussionEngine {
  constructor(
    private moderator: Moderator,
    private channel: AgentChannel,
    private context: EngineContext,
  ) {}

  /**
   * 运行群聊
   * @param goal 群聊目标
   * @param members 成员列表
   * @param options 运行选项
   */
  async run(
    goal: DiscussionGoal,
    members: DiscussionMember[],
    options: DiscussionOptions,
  ): Promise<DiscussionResult> {
    const history: DiscussionMessage[] = []
    const runId = `discuss-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const channelName = `${runId}`

    // 订阅所有成员到群聊频道
    for (const member of members) {
      this.channel.subscribe(channelName, member.id)
    }

    // 注入初始系统消息
    history.push(this.systemMessage(`目标：${goal.task}\n\n## 章节上下文\n${goal.context}`))

    let scenes: SceneDefinition[] = []
    let currentSceneIndex = -1
    let sceneContents: string[] = []  // 各场景编织后的正文片段
    let finalContent = ''
    let rounds = 0
    let noProgressRounds = 0

    try {
      // ── Phase 1：Director 规划 ──
      // Moderator 决定让 Director 先发言，Director 输出叙事任务 + 场景拆分
      // （由 Moderator 自然驱动，引擎本身不硬编码"先叫 Director"，
      //   但初始 history 只有目标，Moderator 看到"无人规划"会自然点 Director）
      let planningDone = false
      while (!planningDone && rounds < MAX_ROUNDS) {
        const decision = await this.moderator.decide(goal, history, members, {
          phase: 'planning',
          round: rounds,
          scenesDefined: scenes.length > 0,
        })

        const handled = await this.handleDecision(decision, history, members, options, channelName, {
          phase: 'planning',
          sceneId: undefined,
        })
        rounds++

        if (decision.type === 'converge' && decision.scope === 'chapter') {
          // Director 规划完成，解析场景
          const directorMsg = history.find(m => m.fromId === decision.agentId && m.type === 'member')
          if (directorMsg) {
            scenes = this.parseScenes(directorMsg.content)
          }
          planningDone = true
        }
        if (decision.type === 'pause') {
          // 用户回复后继续
        }
      }

      // ── Phase 2：场景循环 ──
      for (let i = 0; i < scenes.length; i++) {
        currentSceneIndex = i
        const scene = scenes[i]
        rounds = 0
        noProgressRounds = 0

        // 注入场景上下文
        history.push(this.systemMessage(this.buildSceneContext(scene)))
        options.onProgress({ type: 'scene_change', phase: 'scene_setup', data: { scene }, timestamp: Date.now() })

        // 激活该场景在场的角色
        const activeMembers = this.filterMembersByScene(members, scene)

        // 场景内循环
        let sceneDone = false
        while (!sceneDone && rounds < MAX_ROUNDS_PER_SCENE) {
          const decision = await this.moderator.decide(goal, history, activeMembers, {
            phase: 'acting',
            round: rounds,
            currentScene: scene,
            scenesRemaining: scenes.length - i - 1,
          })

          const handled = await this.handleDecision(decision, history, activeMembers, options, channelName, {
            phase: 'acting',
            sceneId: scene.sceneId,
          })
          rounds++

          if (decision.type === 'converge' && decision.scope === 'scene') {
            // 该场景演完，让 Writer 整理
            const sceneContent = await this.weaveScene(decision.agentId, history, scene, members, options)
            sceneContents.push(sceneContent)
            sceneDone = true
          }
          if (decision.type === 'next_scene') {
            sceneDone = true
          }
          if (decision.type === 'observe') {
            noProgressRounds++
            if (noProgressRounds >= MAX_OBSERVE_ROUNDS) {
              // 强制收敛该场景
              const writer = members.find(m => m.canConverge)
              if (writer) {
                const sceneContent = await this.weaveScene(writer.id, history, scene, members, options)
                sceneContents.push(sceneContent)
                sceneDone = true
              }
            }
          }
        }
      }

      // ── Phase 3：全章编织 ──
      // Writer 把各场景片段合并成完整章节正文
      finalContent = await this.weaveChapter(members, sceneContents, scenes, goal, options)

      // Reviewer 审稿（可选触发场景重演）
      const reviewResult = await this.runReview(finalContent, history, members, options)

      // ── Phase 4：收尾由 NovelDiscussionRunner 调用 ChapterFinalizer ──

      return {
        status: 'completed',
        content: reviewResult.content,
        transcript: history,
        scenes,
        stateChanges: reviewResult.stateChanges,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { status: 'error', error: message, transcript: history, scenes }
    } finally {
      for (const member of members) {
        this.channel.unsubscribe(channelName, member.id)
      }
    }
  }

  /** 处理 Moderator 决策 */
  private async handleDecision(
    decision: ModeratorDecision,
    history: DiscussionMessage[],
    members: DiscussionMember[],
    options: DiscussionOptions,
    channelName: string,
    ctx: { phase: DiscussionPhase; sceneId?: number },
  ): Promise<void> {
    switch (decision.type) {
      case 'invite': {
        const member = members.find(m => m.id === decision.agentId)
        if (!member) {
          history.push(this.errorMessage(`Moderator 点名了不存在的成员: ${decision.agentId}`))
          return
        }
        // 调用成员发言
        const content = await this.invokeMember(member, decision.prompt, history, options, ctx)
        const msg: DiscussionMessage = {
          id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          fromId: member.id,
          fromName: member.name,
          content,
          timestamp: Date.now(),
          sceneId: ctx.sceneId,
          type: 'member',
        }
        history.push(msg)
        this.channel.broadcast(channelName, member.id, msg)
        break
      }
      case 'pause': {
        options.onProgress({ type: 'pause', phase: ctx.phase, data: { question: decision.question }, timestamp: Date.now() })
        const userReply = await options.onCheckpoint({
          type: 'discussion_pause',
          phase: ctx.phase,
          question: decision.question,
          options: decision.options,
        })
        history.push({
          id: `user-${Date.now()}`,
          fromId: 'user',
          fromName: '用户',
          content: typeof userReply === 'string' ? userReply : String(userReply),
          timestamp: Date.now(),
          sceneId: ctx.sceneId,
          type: 'user',
        })
        break
      }
      case 'converge':
      case 'next_scene':
      case 'observe':
        // 这些由调用方循环处理
        break
    }
  }

  /** 调用成员发言（通过 createAgUiSession 工厂） */
  private async invokeMember(
    member: DiscussionMember,
    prompt: string,
    history: DiscussionMessage[],
    options: DiscussionOptions,
    ctx: { phase: DiscussionPhase; sceneId?: number },
  ): Promise<string> {
    const systemPrompt = member.buildSystemPrompt()
    // 群聊记录摘要注入 userMessage
    const transcriptSummary = this.formatTranscriptForMember(history, member.id)
    const userMessage = `${prompt}\n\n---\n\n## 群聊记录\n\n${transcriptSummary}`

    const agUiSession = await this.context.createAgUiSession({
      systemPrompt,
      prefixUserMessage: [], // 群聊模式不用 SEMI 层缓存（成员动态变化）
      userMessage,
      tools: [],
      signal: options.signal,
      temperature: member.type === 'character' ? 0.8 : 0.7,
      timeoutMs: runtimePerformance.llm.timeoutMs,
      emit: options.emit,
      emitRaw: false,
      onFirstText: () => {
        options.onProgress({
          type: 'agent_start',
          phase: ctx.phase,
          data: { agentName: member.name, message: `${member.name} 开始发言...` },
          timestamp: Date.now(),
        })
      },
    })

    try {
      const result = await agUiSession.session.prompt()
      agUiSession.streamEmitter.finishTextMessage()
      return result
    } finally {
      agUiSession.dispose()
    }
  }
}
```

**关键常量**：
```typescript
const MAX_ROUNDS = 20              // 总轮数上限
const MAX_ROUNDS_PER_SCENE = 10    // 单场景轮数上限
const MAX_OBSERVE_ROUNDS = 3       // 连续空转上限
const MAX_PUSHBACK_PER_SCENE = 2   // 单场景角色 pushback 上限
```

### 4.2 Moderator（主持人 LLM 决策器）

**职责**：每轮看群聊历史 + 目标，结构化输出下一步决策。

```typescript
// moderator.ts

export class Moderator {
  constructor(
    private context: ModeratorContext,
    private model?: { provider: string; modelId: string },
  ) {}

  /**
   * 决策
   * @param goal 群聊目标
   * @param history 群聊历史
   * @param members 当前可用成员
   * @param state 引擎状态（阶段/轮数/场景等）
   */
  async decide(
    goal: DiscussionGoal,
    history: DiscussionMessage[],
    members: DiscussionMember[],
    state: ModeratorState,
  ): Promise<ModeratorDecision> {
    const systemPrompt = this.buildSystemPrompt(members, state)
    const userMessage = this.buildUserPrompt(goal, history, state)

    // 用配置的 Moderator 模型（默认用最便宜的小模型）
    const session = await this.context.createSession({
      systemPrompt,
      userMessage,
      timeoutMs: 15_000,
      model: this.model,
    })

    try {
      const result = await session.prompt()
      return this.parseDecision(result)
    } catch (err) {
      // Moderator 调用失败：重试 1 次，仍失败则降级为规则协调
      this.context.logger.warn({ err }, 'Moderator 调用失败，尝试重试')
      try {
        const retry = await this.context.createSession({
          systemPrompt,
          userMessage,
          timeoutMs: 15_000,
          model: this.model,
        })
        const result = await retry.prompt()
        retry.dispose()
        return this.parseDecision(result)
      } catch {
        this.context.logger.warn({ err }, 'Moderator 重试失败，降级为规则协调')
        return this.fallbackDecide(members, state)
      }
    } finally {
      session.dispose()
    }
  }

  /** Moderator system prompt */
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
4. 刚有人发言，想看群体反应 → observe（最多连续 ${MAX_OBSERVE_ROUNDS} 次）
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

  /** 降级决策（Moderator LLM 不可用时的规则协调） */
  private fallbackDecide(members: DiscussionMember[], state: ModeratorState): ModeratorDecision {
    // 规则：按成员顺序轮流发言，3 轮后强制 converge
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

  /** 解析 Moderator 输出为决策 */
  private parseDecision(raw: string): ModeratorDecision {
    // 提取 JSON（容错：LLM 可能包裹 markdown 代码块）
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      throw new Error('Moderator 输出无法解析为 JSON')
    }
    const parsed = JSON.parse(jsonMatch[0])
    // 校验必要字段
    if (!['invite', 'pause', 'converge', 'next_scene', 'observe'].includes(parsed.type)) {
      throw new Error(`Moderator 输出 type 非法: ${parsed.type}`)
    }
    return parsed as ModeratorDecision
  }
}
```

### 4.3 ChapterFinalizer（收尾工具类）

**职责**：抽取自 `NovelOrchestrator` 的收尾私有方法，workflow 和 discussion 两边共用。

```typescript
// chapter-finalizer.ts

export class ChapterFinalizer {
  constructor(
    private store: NovelStore,
    private memoryStore: NovelMemoryStore,
    private memoryGenerator?: NovelMemoryGenerator,
    private promptBuilder: NovelPromptBuilder,
    private context: PluginContext,
  ) {}

  /**
   * 章节收尾：落库 + Memory + 标题/提要 + 状态快照
   * 从 NovelOrchestrator 抽取，workflow 和 discussion 共用
   */
  async finalize(params: {
    projectId: string
    chapterNumber: number
    content: string
    options: { emit: AgUiEventSink; onProgress: (event: CreationFlowEvent | DiscussionFlowEvent) => void; signal?: AbortSignal }
    arrangedEntities?: ArrangedEntity
    directorTask?: NarrativeTask
  }): Promise<void> {
    const { projectId, chapterNumber, content, options } = params

    // 1. 清洗思考前缀
    const cleanedContent = this.stripThinkingPrelude(content)

    // 2. 落库
    const chapter = this.store.getChapter(projectId, chapterNumber)
    if (chapter) {
      this.store.updateChapter(chapter.id, {
        content: cleanedContent,
        status: 'review',
        wordCount: cleanedContent.length,
        timeOffset: params.directorTask?.timeOffset ?? null,
        chapterEndingHook: params.directorTask?.chapterEndingHook ?? null,
      })
    }

    // 3. Memory 提取
    const beforeState = this.captureEntityState(projectId)
    const memoryResult = await this.runMemory(projectId, chapterNumber, cleanedContent, options)
    const memoryEvents = this.recordMemoryEvents(projectId, chapterNumber, chapter?.id ?? null, beforeState)
    this.syncChapterDimensions(projectId, chapterNumber, chapter?.id ?? null, params.arrangedEntities, beforeState)
    this.saveChapterSnapshot(projectId, chapterNumber)

    // 4. 标题 + 前情提要
    const [titleCandidates, recap] = await Promise.all([
      this.generateChapterTitles(projectId, chapterNumber, cleanedContent),
      this.generateChapterRecap(projectId, chapterNumber, cleanedContent),
    ])
    if (recap && chapter) {
      this.store.updateChapter(chapter.id, { recap })
    }

    // 5. 推送完成事件
    options.onProgress({
      type: 'data_changed',
      phase: 'completed',
      data: {
        message: '章节创作完成',
        titleCandidates,
        recap,
        memoryResult,
        memoryEvents: memoryEvents.map(e => ({ type: e.eventType, description: e.description })),
      },
      timestamp: Date.now(),
    } as DiscussionFlowEvent)
  }

  // 以下方法从 NovelOrchestrator 原样迁移：
  // - stripThinkingPrelude
  // - captureEntityState
  // - recordMemoryEvents
  // - applyHeuristicCausalLinks
  // - syncChapterDimensions
  // - saveChapterSnapshot
  // - generateChapterTitles
  // - generateChapterRecap
  // - parseIdList
  // - runMemoryAgent (包装 memoryGenerator)
}
```

**NovelOrchestrator 的改造**（最小改动）：
- 把上述 9 个私有方法迁移到 `ChapterFinalizer`
- `NovelOrchestrator` 持有 `ChapterFinalizer` 实例，原调用点改为 `this.finalizer.xxx()`
- 方法签名和行为不变，只是位置变了

### 4.4 NovelDiscussionRunner（novel 适配器）

**职责**：把 novel 的 Agent 角色翻译成群聊成员，构建目标，调用引擎，收尾。

```typescript
// novel-discussion-runner.ts

export class NovelDiscussionRunner {
  constructor(
    private store: NovelStore,
    private memoryStore: NovelMemoryStore,
    private sessionFactory: NovelSessionFactory,
    private promptBuilder: NovelPromptBuilder,
    private engine: NovelEngine,
    private context: PluginContext,
    private agentConfigStore: NovelAgentConfigStore,
    private memoryGenerator?: NovelMemoryGenerator,
    private moderatorModel?: { provider: string; modelId: string },
  ) {}

  async run(
    projectId: string,
    chapterNumber: number,
    options: DiscussionOptions,
  ): Promise<DiscussionResult> {
    // 1. 构建 SEMI 层 shared 上下文（复用 promptBuilder）
    const sharedContext = this.promptBuilder.buildChapterContextShared(
      projectId, chapterNumber,
      this.buildDefaultNarrativeTask(chapterNumber),
      this.engine.buildChapterConstraints(projectId, chapterNumber),
      undefined,
    )

    // 2. 构建目标
    const goal: DiscussionGoal = {
      task: `创作第 ${chapterNumber} 章正文`,
      context: sharedContext,
    }

    // 3. 构建成员列表
    const members = await this.buildMembers(projectId, chapterNumber)

    // 4. 构建引擎
    const channel = new AgentChannel(this.context.eventBus)
    const moderator = new Moderator(
      { createSession: this.context.createSession, logger: this.context.logger },
      this.moderatorModel,
    )
    const engine = new TeamDiscussionEngine(moderator, channel, this.context)

    // 5. 运行
    const result = await engine.run(goal, members, options)

    // 6. 收尾（如果成功）
    if (result.status === 'completed' && result.content) {
      const finalizer = new ChapterFinalizer(
        this.store, this.memoryStore, this.memoryGenerator, this.promptBuilder, this.context,
      )
      await finalizer.finalize({
        projectId, chapterNumber, content: result.content,
        options: {
          emit: options.emit,
          onProgress: options.onProgress,
          signal: options.signal,
        },
      })
    }

    return result
  }

  /** 构建群聊成员：5 个工种 Agent + 本章涉及的角色 Agent */
  private async buildMembers(projectId: string, chapterNumber: number): Promise<DiscussionMember[]> {
    const members: DiscussionMember[] = []

    // 工种 Agent（Director/Writer/Reviewer/Reviser，不含 Memory——收尾阶段单独跑）
    const roleAgents: NovelAgentType[] = ['director', 'writer', 'reviewer', 'reviser']
    for (const agentType of roleAgents) {
      const config = NOVEL_AGENT_CONFIGS[agentType]
      members.push({
        id: config.id,
        type: 'role',
        name: config.name,
        expertise: config.description,
        canConverge: agentType === 'writer' || agentType === 'reviser',
        buildSystemPrompt: () => this.promptBuilder.buildSystemPrompt(projectId, agentType),
      })
    }

    // 角色 Agent：读取本章编排涉及的角色 + 项目所有活跃角色
    const characters = this.store.listCharacters(projectId)
    for (const char of characters) {
      // 跳过已退场角色（arcStage === 'resolved' 且无当前目标）
      if (char.arcStage === 'resolved' && !char.currentGoal) continue

      members.push({
        id: `char-${char.id}`,
        type: 'character',
        name: char.name,
        expertise: char.personality ?? '未设定性格',
        canConverge: false,
        // scenePresence 由 Director 拆场后动态更新（初始为空，所有场景可出席）
        scenePresence: undefined,
        characterProfile: {
          personality: char.personality ?? '',
          currentState: char.currentState ?? '',
          currentGoal: char.currentGoal ?? '',
          secret: char.secret ?? '',
          arcStage: char.arcStage ?? '',
          participatingConflicts: this.parseIdList(char.participatingConflicts),
        },
        buildSystemPrompt: () => this.buildCharacterPrompt(char),
      })
    }

    return members
  }

  /** 构建 角色 Agent system prompt */
  private buildCharacterPrompt(char: NovelCharacter): string {
    return `你正在扮演小说角色「${char.name}」。

## 你的身份
${char.identity ?? char.description ?? ''}

## 你的性格
${char.personality ?? '未设定'}

## 你的当前状态
- 心理状态：${char.currentState ?? '未设定'}
- 当前目标：${char.currentGoal ?? '未设定'}
- 秘密：${char.secret ?? '无'}
- 弧线阶段：${char.arcStage ?? '未设定'}

## 你的行为规则
1. 始终以第一人称说话和行动
2. 严格遵循你的性格和当前心理状态——如果群聊里的情境让你"不会这么做"，明确说出你的异议
3. 你的输出是剧本格式：[动作描述] 然后 "台词"
4. 不要写小说叙述（环境描写/心理独白/节奏控制由 Writer 负责）
5. 如果有人提出让你做明显违反人设的事，标记 [PUSHBACK] 并说明原因
6. 绝不使用破折号"——"。转折用句号，补充用逗号，列举用顿号。

## 输出格式
[动作/表情/心理外化]
"你的台词"

示例：
[拍桌，怒目圆睁]
"你胡说！那批料的检验报告我亲眼看过，明明是合格的！"`
  }
}
```

### 4.5 角色剧本格式

**设计决策**：角色 Agent 输出纯剧本格式（动作 + 台词），不写叙述。

```
[拍桌，怒目圆睁]
"你胡说！那批料的检验报告我亲眼看过，明明是合格的！"
```

**理由**：
- 角色 Agent 的职责是"演"不是"写小说"，让它写叙事段落会视角混乱
- 剧本格式让角色只贡献"我说了什么、做了什么"
- Writer 负责叙事视角、环境描写、节奏控制——职责清晰，编织质量可控
- 剧本格式天然适合群聊记录，Writer 容易识别谁说了什么

### 4.6 场景拆分与解析

Director 在规划阶段输出场景拆分，格式约定：

```markdown
## 场景拆分

### 场景 1：赵家客厅对峙
- 地点：赵家客厅
- 时间：傍晚
- 在场角色：赵岩、赵父、李明
- 冲突：赵岩与赵父关于接班人选的冲突
- 目标：展现父子价值观对立，赵岩暗中决定离家

### 场景 2：选材车间
- 地点：工厂选材车间
- 时间：深夜
- 在场角色：赵岩、李明
- 冲突：赵岩发现质量问题
- 目标：赵岩决定举报，埋下伏笔
```

引擎解析这个格式为 `SceneDefinition[]`，然后在场景循环中只激活 `presentCharacters` 里的角色。

**ID 映射**：Director 拆场时输出的是角色名（如"赵岩"），但群聊成员的 `member.id` 是 `char-${characterId}` 格式。`parseScenes` 解析时需要用角色名到角色 ID 的映射表（由 `buildMembers` 时构建并传入引擎），把 `presentCharacters` 统一为 `member.id` 格式。匹配失败的角色跳过（不阻塞流程，记 warn 日志）。

---

## 五、Moderator 配置

### 5.1 设置页

[agent-page.tsx](../../../apps/desktop/src/renderer/src/components/settings/agent-page.tsx) 新增"群聊设置"区块：

```
群聊设置
├── Moderator 模型：[Provider 下拉] [Model 下拉]
├── 最大轮数：[20] （可调）
├── 单场景最大轮数：[10] （可调）
└── 角色 Agent 温度：[0.8] （可调）
```

配置存入现有 settings 存储（通过 `settings.route.ts` 的 `/api/settings` 接口），键名 `discussion.moderatorModel`、`discussion.maxRounds` 等。

### 5.2 默认值

- Moderator 模型：未配置时用项目 provider 配置里最便宜的模型（按 `cost-rates.ts` 的 input token 单价排序取最低）
- 最大轮数：20
- 单场景最大轮数：10
- 角色 Agent 温度：0.8
- 工种 Agent 温度：0.7（复用现有 `agentConfigStore` 的配置）

---

## 六、前端改动

### 6.1 创作按钮加 mode 切换

[novel-toolbar.tsx](../../../apps/desktop/src/renderer/src/components/novel/novel-toolbar.tsx) 的"开始创作"按钮旁加一个分段控件：

```
[编排模式 | 群聊模式]  [开始创作 ▶]
```

- 默认选中"编排模式"（workflow）
- 切换时本地 state 更新，点击"开始创作"时把 `mode` 参数传给 API
- 群聊模式时前端展示群聊记录流（复用现有 `message-stream.tsx` 的 SSE 订阅，按 `fromName` 区分发言者）

### 6.2 群聊记录展示

群聊模式下，SSE 事件流里会有多个 Agent 交替发言。前端需要：

- 按 `fromName` 显示发言者名（"导演"/"赵岩"/"系统"/"用户"）
- 角色 Agent 发言用不同气泡样式（如左侧带角色头像占位）
- Moderator 的 pause 事件弹出确认对话框（复用现有 `confirmation-dialog.tsx`）
- 场景切换时显示分隔条（"场景 1：赵家客厅对峙"）

---

## 七、完整数据流（一次群聊）

以"写完第 3 章"为例，群聊模式：

```
前端：POST /novel/:id/chapters/3/create  body: { mode: 'discussion' }
  ↓
NovelDiscussionRunner.run(projectId, 3, { emit, onCheckpoint, signal })
  ↓
  ① 准备阶段
     - 读取 4 个工种 Agent 配置 + 项目角色列表
     - 构建 DiscussionGoal: { task: '创作第3章', context: SEMI层shared }
     - 构建成员列表（工种 + 角色）
     - 初始化 AgentChannel + Moderator + Engine
  ↓
  ② Phase 1：Director 规划
     - Moderator.decide() → invite director
     - Director 发言：输出叙事任务 + 场景拆分（2 个场景）
     - Moderator.decide() → pause（"叙事方向需确认"）
       → onCheckpoint → 用户 approve
     - Moderator.decide() → converge(scope=chapter)
     - 引擎解析 Director 输出为 SceneDefinition[2]
  ↓
  ③ Phase 2：场景 1 演出
     - 注入场景上下文：赵家客厅/傍晚/赵岩+赵父+李明/父子冲突
     - 激活在场角色（赵岩/赵父/李明），其他成员休眠
     - Moderator.decide() → invite 赵岩 → 赵岩发言（剧本格式）
     - Moderator.decide() → invite 赵父 → 赵父发言
     - Moderator.decide() → invite 赵岩 → 赵岩 [PUSHBACK]（"我不会求饶"）
     - Moderator.decide() → invite 赵父 → 赵父 调整台词
     - Moderator.decide() → converge(writer, scope=scene)
     - Writer 整理场景 1 的群聊记录 → 正文片段 1
  ↓
  ④ Phase 2：场景 2 演出（同上流程）
     - Writer 整理场景 2 → 正文片段 2
  ↓
  ⑤ Phase 3：全章编织
     - Writer 合并片段 1 + 片段 2 → 完整章节正文
     - Reviewer 审稿 → 无问题 → approve
  ↓
  ⑥ Phase 4：收尾（ChapterFinalizer）
     - stripThinkingPrelude 清洗
     - updateChapter 落库
     - Memory 提取（memoryGenerator）
     - recordMemoryEvents + syncChapterDimensions + saveChapterSnapshot
     - generateChapterTitles + generateChapterRecap
  ↓
  ⑦ 返回 DiscussionResult
     { status: 'completed', content: '...', transcript: [...], scenes: [...] }
  ↓
前端：SSE 流式展示群聊记录 + 最终正文，落库后刷新画布
```

---

## 八、错误处理

| 异常场景 | 处理策略 |
|---------|---------|
| **成员发言超时** | 该轮跳过，history 记录"X 未响应"，Moderator 下轮重新决策（换人/重试） |
| **Moderator 调用失败** | 重试 1 次；仍失败降级为规则协调（按成员顺序轮流，3 轮后强制 converge） |
| **成员发言抛错** | 错误入 history（"director 发言失败：超时"），Moderator 下轮看到后决策 |
| **用户 pause 超时** | 走 ConfirmationManager 现有超时机制，默认 reject → 引擎返回 cancelled |
| **Moderator 输出非法 JSON** | parseDecision 抛错，触发 Moderator 重试逻辑 |
| **角色 pushback 超过 2 轮** | Moderator 介入：裁决方向 or pause 问用户 |
| **场景内角色发言轮数超 10** | Moderator 强制 converge(scene) → Writer 整理已有内容 |
| **场景重演超过 2 次** | 放弃重演，Reviewer 标注问题，最终正文带 issue 备注 |
| **角色 Agent OOC** | Reviewer 阶段检测，触发该场景重演 |
| **总轮数超 20** | 强制 converge(chapter) → Writer 用已有内容产出 |
| **总超时** | 复用 `runtimePerformance.llm.timeoutMs` × 10（群聊多轮，给充足预算） |

**降级策略**：Moderator 挂了不死等，切到"规则协调"模式——按成员数组顺序轮流发言，3 轮后强制收敛 Agent 产出。保证"群聊失败但还能出活"。

---

## 九、测试策略

### 9.1 Moderator 决策单测（`moderator.test.ts`）

- mock LLM 返回不同 JSON，验证 `decide()` 正确解析为各 decision 类型
- 验证输入构造：goal/history/members/budget 正确注入 prompt
- 验证 LLM 返回非法 JSON 时的容错（重试 → 降级）
- 验证 `fallbackDecide` 的规则协调逻辑
- 验证 `parseDecision` 的容错（markdown 代码块包裹、字段缺失）

### 9.2 引擎循环单测（`team-discussion-engine.test.ts`）

- mock moderator 返回预设 decision 序列，验证循环正确执行 invite/pause/converge
- **死锁守卫**：构造"moderator 一直返回 observe"的场景，验证 3 轮后强制 converge
- **pause 流程**：mock moderator 返回 pause，验证 onCheckpoint 被调用、用户回复后继续
- **成员发言失败**：mock 成员 session 抛错，验证错误入 history、循环继续
- **场景循环**：mock Director 输出 2 个场景，验证场景切换时成员过滤正确
- **总轮数上限**：mock moderator 一直返回 invite，验证 20 轮后强制 converge
- 复用现有 `concurrency-limiter.test.ts` 的测试模式

### 9.3 Novel 端到端测试（`novel-discussion-runner.test.ts`）

- mock createAgUiSession，模拟一次完整群聊（director 规划→角色演出→writer 收敛→reviewer 审稿）
- 验证最终落库的 chapter.content、agent_log 记录数、memory 事件
- 对比 workflow 模式产出结构一致（DiscussionResult / CreationResult 字段对齐）
- 验证角色 Agent 的 system prompt 正确注入人设字段
- 复用 `s2-confirmation-e2e.test.ts` 的 SSE 客户端 mock 模式

### 9.4 ChapterFinalizer 单测（`chapter-finalizer.test.ts`）

- 验证从 NovelOrchestrator 抽取后行为一致（落库/Memory/标题/提要）
- 对比抽取前后的 agent_log 记录，确保无回归

---

## 十、实施路线图

### Phase 1：通用引擎 + 基础设施（核心）

| 步骤 | 内容 | 依赖 |
|------|------|------|
| 1.1 | 定义 `discussion-types.ts` 全部类型 | 无 |
| 1.2 | 实现 `Moderator` 类（含 fallbackDecide + parseDecision） | 1.1 |
| 1.3 | 实现 `TeamDiscussionEngine` 核心循环 | 1.1, 1.2 |
| 1.4 | 单测：modulator + engine | 1.2, 1.3 |

### Phase 2：ChapterFinalizer 抽取

| 步骤 | 内容 | 依赖 |
|------|------|------|
| 2.1 | 创建 `ChapterFinalizer`，迁移 9 个私有方法 | 无 |
| 2.2 | `NovelOrchestrator` 改为持有 finalizer 实例，调用点替换 | 2.1 |
| 2.3 | 回归测试：workflow 模式行为不变 | 2.2 |

### Phase 3：Novel 适配器

| 步骤 | 内容 | 依赖 |
|------|------|------|
| 3.1 | 编写 `role-writer-discussion.md`（群聊模式 Writer prompt） | 无 |
| 3.2 | 编写 `role-character-actor.md`（角色 Agent prompt 模板） | 无 |
| 3.3 | 实现 `NovelDiscussionRunner`（成员构建 + 目标构建 + 收尾） | Phase 1, 2, 3.1, 3.2 |
| 3.4 | 端到端测试 | 3.3 |

### Phase 4：入口与配置

| 步骤 | 内容 | 依赖 |
|------|------|------|
| 4.1 | `novel-routes.ts` 加 `mode` 参数路由 | Phase 3 |
| 4.2 | 前端 `novel-toolbar.tsx` 加 mode 切换 | 4.1 |
| 4.3 | 前端群聊记录展示（SSE + 气泡区分发言者） | 4.2 |
| 4.4 | 设置页加 Moderator 模型配置 | 无 |

### Phase 5：打磨

| 步骤 | 内容 | 依赖 |
|------|------|------|
| 5.1 | 角色剧本格式解析 + Writer 编织逻辑优化 | Phase 3 |
| 5.2 | 场景重演机制（Reviewer 触发） | Phase 3 |
| 5.3 | agent_call_logs 标记 mode，方便对比两模式产出质量 | Phase 3 |

---

## 十一、关键设计决策

### 决策 1：新增并行通道，不修改现有 workflow

**选择**：在 `novel-routes.ts` 加 `mode` 参数，群聊走独立的 `NovelDiscussionRunner`，`NovelOrchestrator` 一行不改。

**理由**：零风险回退。群聊是实验性功能，万一效果不好或有问题，用户切回 workflow 即可，不影响生产。两条路完全独立，CreationResult / DiscussionResult 结构对齐，前端无感知。

### 决策 2：Moderator 集中决策（方案 A）

**选择**：每轮由 Moderator LLM 决策"下一条谁说话"，而非 Agent 自己 @ 交接或纯规则协调。

**理由**：
- 顺序自举最难的是**终止判定和死锁防护**，集中决策最可靠
- 检查点涌现自然落在 Moderator 身上（它最判断"这事儿得问人"）
- novel 是生产场景，质量要求高，可控性是刚需
- 代价是每轮多一次轻量 LLM 调用，用便宜模型可压成本

**否决方案 B（@mention 交接）**：最群聊但 Agent 可能忘记 @ 人（死锁）、总是 @ 自己（独霸）、没人收敛（无限循环），生产风险高。

**否决方案 C（混合规则兜底）**：工程复杂度最高，且规则调不好容易退化成"披着群聊皮的编排"。

### 决策 3：角色共创正文（剧本格式）

**选择**：角色 Agent 输出纯剧本格式（动作 + 台词），Writer 从群聊记录编织成叙事正文。

**理由**：
- 角色只贡献"我说了什么、做了什么"，不写叙述，职责清晰
- 剧本格式天然适合群聊记录，Writer 容易识别谁说了什么
- 让角色写叙事段落会视角混乱且质量不可控
- 共创模式让角色行为更符合人设，减少 OOC

### 决策 4：分场演出（Director 拆场）

**选择**：Director 在规划阶段输出场景拆分，每个场景只激活在场角色。

**理由**：
- 结构清晰可控，角色知道"现在该不该在场"
- 场景边界由 Director 预先划定，但场景内的演出顺序依然涌现
- 避免"整章一锅端"的混乱

### 决策 5：检查点涌现（Moderator 自主请求暂停）

**选择**：检查点不由流程代码在固定位置触发，而是 Moderator 判断"需要用户拍板"时主动 pause。

**理由**：
- 群聊的"自组织"精神要求检查点也是涌现的
- Moderator 拥有全局视角，最容易判断"这事儿得问人"
- 用户介入更精准——只在真正需要时暂停，不打断流畅的讨论

### 决策 6：ChapterFinalizer 抽取为工具类

**选择**：从 `NovelOrchestrator` 抽取 9 个收尾私有方法到独立的 `ChapterFinalizer`，workflow 和 discussion 两边共用。

**理由**：
- 两边落库逻辑零分歧，避免维护两份相似代码
- 抽取后 `NovelOrchestrator` 职责更单一（只管编排流程）
- 方法签名和行为不变，只是位置变了，回归风险低

### 决策 7：Moderator 模型用户可配

**选择**：在设置页加 Moderator 模型配置项，用户可选 provider + model。

**理由**：
- 不同用户对成本/质量权衡不同
- 国产小模型便宜但决策能力可能不如 GPT-4o-mini
- 让用户自己选最合适的平衡点

---

## 十二、风险与注意事项

1. **Moderator LLM 成本**：每轮多一次调用，10-15 轮群聊约 10-15 次额外调用。用便宜模型（GPT-4o-mini / 国产 mini 档）单次几百 token，成本可控。设置页可配，用户可按需调整。

2. **角色 Agent 数量膨胀**：大型小说角色多，全拉进群聊会导致 Moderator 决策空间过大、成本飙升。分场演出已缓解（每场只激活在场角色），但仍需在 `buildMembers` 里过滤退场角色。后续可加"只激活本章编排涉及角色"的配置。

3. **Writer 编织质量**：Writer 从群聊剧本记录编织叙事，对 LLM 能力要求高。需要在 `role-writer-discussion.md` 里明确编织规则（视角统一/环境描写/节奏控制/剧本格式转叙事）。首版可能质量不稳，需在 Phase 5 打磨。

4. **场景解析鲁棒性**：Director 输出的场景拆分格式可能不稳定（LLM 不一定严格按 markdown 格式）。`parseScenes` 需要容错解析，失败时降级为"整章一锅端"。

5. **Moderator 与成员的 prompt 一致性**：Moderator 看到的成员清单和实际成员的 system prompt 必须一致。如果角色人设更新但 Moderator 看到的是旧摘要，决策会失准。需确保 `buildMembers` 里 expertise/characterProfile 与 buildSystemPrompt 同源。

6. **群聊 transcript 体积**：20 轮群聊 + 多个角色发言，transcript 可能很长。成员发言时注入"群聊记录摘要"需要截断策略（如只看最近 10 条 + 当前场景所有消息）。

7. **与 Team 抽象的关系**：本设计是独立的并行通道，不与 `MULTI_AGENT_DESIGN.md` 的 Team 抽象冲突。未来 Team 的 `coordinated` 策略可复用 `TeamDiscussionEngine`，但那是后话。

8. **ConcurrencyLimiter 协调**：群聊模式下多个成员发言是串行的（Moderator 一次只点一个人），不会触发并发限制。但 Moderator 和成员发言是两次独立 LLM 调用，需确保不与 workflow 模式同时运行时冲突。现有 `maxConcurrent=5` 足够覆盖。
