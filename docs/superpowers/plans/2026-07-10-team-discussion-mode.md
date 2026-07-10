# 群聊共创模式实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 新增 novel 创作的"群聊共创"模式——通用群聊引擎 + Moderator LLM 调度 + 角色 Agent 以剧本格式共创正文，与现有 workflow 模式并行，用户可在前端选择。

**架构：** 新增 `TeamDiscussionEngine`（通用群聊引擎）+ `Moderator`（LLM 决策器）+ `ChapterFinalizer`（从 NovelOrchestrator 抽取的收尾工具类，两边共用）+ `NovelDiscussionRunner`（novel 适配器）。入口为新的 `/create-discussion` SSE 端点，与现有 `/create-flow` 完全独立。前端创作按钮加模式切换，设置页加 Moderator 模型配置。

**技术栈：** TypeScript, better-sqlite3, Fastify, React, TanStack Query, AG-UI SSE, Pi SDK

**规格文档：** [docs/superpowers/specs/2026-07-10-team-discussion-mode-design.md](../specs/2026-07-10-team-discussion-mode-design.md)

---

## 文件结构

### 创建
- `apps/agent-server/src/core/agent/discussion-types.ts` — 群聊类型定义（成员/目标/消息/决策/结果）
- `apps/agent-server/src/core/agent/moderator.ts` — Moderator LLM 决策器（结构化输出 + 降级规则协调）
- `apps/agent-server/src/core/agent/team-discussion-engine.ts` — 通用群聊引擎（循环驱动 + 场景管理 + 死锁防护）
- `apps/agent-server/src/core/agent/chapter-finalizer.ts` — 章节收尾工具类（从 NovelOrchestrator 抽取）
- `apps/agent-server/src/plugins/novel-plugin/core/novel-discussion-runner.ts` — novel 适配器（成员构建 + 目标构建 + 调引擎 + 调收尾）
- `apps/agent-server/src/plugins/novel-plugin/core/prompts/role-writer-discussion.md` — 群聊模式 Writer 专用 prompt
- `apps/agent-server/src/plugins/novel-plugin/core/prompts/role-character-actor.md` — 角色 Agent prompt 模板
- `apps/agent-server/src/core/agent/discussion-settings-store.ts` — 群聊设置存储（Moderator 模型 + 轮数上限等）

### 修改
- `apps/agent-server/src/plugins/novel-plugin/novel-migrations.ts` — 新增 060 迁移（discussion_settings 表）
- `apps/agent-server/src/plugins/novel-plugin/core/novel-orchestrator.ts` — 收尾方法迁移到 ChapterFinalizer，改为持有 finalizer 实例
- `apps/agent-server/src/plugins/novel-plugin/novel-services.ts` — 新增 discussionRunner + finalizer 初始化
- `apps/agent-server/src/plugins/novel-plugin/novel-routes.ts` — 新增 /create-discussion SSE 端点 + discussion 设置 API
- `apps/desktop/src/renderer/src/hooks/use-novel-creation-flow.ts` — 新增 startDiscussion 方法
- `apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx` — 创作按钮加模式切换
- `apps/desktop/src/renderer/src/components/settings/agent-page.tsx` — 加 Moderator 模型配置区块

### 测试
- `apps/agent-server/src/__tests__/moderator.test.ts` — Moderator 决策单测
- `apps/agent-server/src/__tests__/team-discussion-engine.test.ts` — 引擎循环单测
- `apps/agent-server/src/__tests__/chapter-finalizer.test.ts` — 收尾工具类单测
- `apps/agent-server/src/__tests__/novel-discussion-runner.test.ts` — novel 适配器端到端测试

---

## 任务 1：定义群聊类型

**文件：**
- 创建：`apps/agent-server/src/core/agent/discussion-types.ts`

- [ ] **步骤 1：创建 discussion-types.ts**

```typescript
/**
 * 群聊共创模式类型定义
 *
 * 通用类型，不依赖 novel 业务领域。
 * NovelDiscussionRunner 负责把 novel 概念翻译为这些类型。
 */

import type { AgUiEventSink } from '@repo/protocol/events'

/** 群聊成员类型 */
export type DiscussionMemberType = 'role' | 'character'

/** 群聊成员 */
export interface DiscussionMember {
  /** 成员 ID（工种用 agentId 如 'novel-director'，角色用 'char-{characterId}'） */
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
  /** 角色 Agent：人设快照 */
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

/** 群聊目标 */
export interface DiscussionGoal {
  /** 高层任务描述（如"创作第3章"） */
  task: string
  /** 上下文（SEMI 层 shared 前缀，跨成员复用 prompt cache） */
  context: string
  /** 约束（序列化对象，供 Moderator 参考） */
  constraints?: unknown
}

/** 场景定义（Director 拆场后产出） */
export interface SceneDefinition {
  sceneId: number
  title: string
  location: string
  time: string
  /** 在场角色成员 ID 列表（格式与 DiscussionMember.id 一致） */
  presentCharacters: string[]
  conflict?: string
  goal: string
}

/** 群聊消息 */
export interface DiscussionMessage {
  id: string
  /** 发送者 ID（'system' | 'moderator' | 'user' | member.id） */
  fromId: string
  fromName: string
  content: string
  timestamp: number
  /** 当前场景序号 */
  sceneId?: number
  type: 'system' | 'moderator' | 'member' | 'user' | 'error'
}

/** Moderator 决策类型 */
export type ModeratorDecision =
  | { type: 'invite'; agentId: string; prompt: string; reason: string }
  | { type: 'pause'; question: string; options?: string[]; reason: string }
  | { type: 'converge'; agentId: string; scope: 'scene' | 'chapter'; reason: string }
  | { type: 'next_scene'; reason: string }
  | { type: 'observe'; reason: string }

/** Moderator 看到的引擎状态 */
export interface ModeratorState {
  phase: DiscussionPhase
  round: number
  currentScene?: SceneDefinition
  scenesRemaining?: number
  scenesDefined: boolean
}

/** 群聊阶段 */
export type DiscussionPhase =
  | 'planning'
  | 'scene_setup'
  | 'acting'
  | 'scene_weaving'
  | 'chapter_weaving'
  | 'reviewing'
  | 'memory'
  | 'completed'
  | 'error'
  | 'cancelled'

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

/** 群聊运行选项 */
export interface DiscussionOptions {
  emit: AgUiEventSink
  onCheckpoint: (checkpoint: DiscussionCheckpoint) => Promise<'approve' | 'reject' | 'revise' | string>
  onProgress: (event: DiscussionFlowEvent) => void
  signal?: AbortSignal
  /** Moderator 使用的模型配置（未配置时用最便宜模型） */
  moderatorModel?: { provider: string; modelId: string }
}

/** 群聊运行结果 */
export interface DiscussionResult {
  status: 'completed' | 'cancelled' | 'error'
  content?: string
  transcript: DiscussionMessage[]
  scenes: SceneDefinition[]
  stateChanges?: Array<{ type: string; description: string }>
  error?: string
}

/** 群聊引擎常量 */
export const DISCUSSION_LIMITS = {
  MAX_ROUNDS: 20,
  MAX_ROUNDS_PER_SCENE: 10,
  MAX_OBSERVE_ROUNDS: 3,
  MAX_PUSHBACK_PER_SCENE: 2,
  MAX_SCENE_REPLAYS: 2,
} as const
```

- [ ] **步骤 2：Commit**

```bash
git add apps/agent-server/src/core/agent/discussion-types.ts
git commit -m "feat(discussion): 定义群聊共创模式类型"
```

---

## 任务 2：实现 Moderator 决策器

**文件：**
- 创建：`apps/agent-server/src/core/agent/moderator.ts`
- 测试：`apps/agent-server/src/__tests__/moderator.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `apps/agent-server/src/__tests__/moderator.test.ts`：

```typescript
import { describe, expect, it, vi } from 'vitest'
import { Moderator } from '../core/agent/moderator.js'
import type { DiscussionGoal, DiscussionMessage, DiscussionMember, ModeratorState } from '../core/agent/discussion-types.js'

/** 创建 mock 成员 */
function makeMember(overrides: Partial<DiscussionMember> = {}): DiscussionMember {
  return {
    id: 'test-agent',
    type: 'role',
    name: '测试Agent',
    expertise: '测试',
    canConverge: false,
    buildSystemPrompt: () => 'test prompt',
    ...overrides,
  }
}

/** 创建 mock 会话工厂 */
function makeMockContext(decision: string) {
  const mockSession = {
    prompt: vi.fn().mockResolvedValue(decision),
    dispose: vi.fn(),
  }
  return {
    createSession: vi.fn().mockResolvedValue(mockSession),
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    mockSession,
  }
}

describe('Moderator', () => {
  const goal: DiscussionGoal = { task: '创作第3章', context: '上下文' }
  const history: DiscussionMessage[] = []
  const members: DiscussionMember[] = [
    makeMember({ id: 'novel-director', name: '导演', canConverge: false }),
    makeMember({ id: 'novel-writer', name: '写作', canConverge: true }),
  ]
  const state: ModeratorState = { phase: 'planning', round: 0, scenesDefined: false }

  it('解析 invite 决策', async () => {
    const ctx = makeMockContext(JSON.stringify({
      type: 'invite',
      agentId: 'novel-director',
      prompt: '分析故事状态并规划叙事任务',
      reason: '需要先规划',
    }))
    const moderator = new Moderator(ctx as any)
    const decision = await moderator.decide(goal, history, members, state)
    expect(decision.type).toBe('invite')
    if (decision.type === 'invite') {
      expect(decision.agentId).toBe('novel-director')
      expect(decision.prompt).toContain('规划')
    }
  })

  it('解析 pause 决策', async () => {
    const ctx = makeMockContext(JSON.stringify({
      type: 'pause',
      question: '叙事方向选A还是B？',
      options: ['A', 'B'],
      reason: '需要用户拍板',
    }))
    const moderator = new Moderator(ctx as any)
    const decision = await moderator.decide(goal, history, members, state)
    expect(decision.type).toBe('pause')
    if (decision.type === 'pause') {
      expect(decision.question).toContain('A')
      expect(decision.options).toEqual(['A', 'B'])
    }
  })

  it('解析 converge 决策', async () => {
    const ctx = makeMockContext(JSON.stringify({
      type: 'converge',
      agentId: 'novel-writer',
      scope: 'chapter',
      reason: '讨论充分',
    }))
    const moderator = new Moderator(ctx as any)
    const decision = await moderator.decide(goal, history, members, state)
    expect(decision.type).toBe('converge')
    if (decision.type === 'converge') {
      expect(decision.agentId).toBe('novel-writer')
      expect(decision.scope).toBe('chapter')
    }
  })

  it('解析 next_scene 决策', async () => {
    const ctx = makeMockContext(JSON.stringify({
      type: 'next_scene',
      reason: '场景演完',
    }))
    const moderator = new Moderator(ctx as any)
    const decision = await moderator.decide(goal, history, members, state)
    expect(decision.type).toBe('next_scene')
  })

  it('解析 observe 决策', async () => {
    const ctx = makeMockContext(JSON.stringify({
      type: 'observe',
      reason: '等待反应',
    }))
    const moderator = new Moderator(ctx as any)
    const decision = await moderator.decide(goal, history, members, state)
    expect(decision.type).toBe('observe')
  })

  it('容错：LLM 输出被 markdown 代码块包裹', async () => {
    const ctx = makeMockContext('```json\n{"type":"observe","reason":"等待"}\n```')
    const moderator = new Moderator(ctx as any)
    const decision = await moderator.decide(goal, history, members, state)
    expect(decision.type).toBe('observe')
  })

  it('容错：LLM 输出非法 JSON 时重试，仍失败则降级', async () => {
    const mockSession = {
      prompt: vi.fn().mockResolvedValue('not json at all'),
      dispose: vi.fn(),
    }
    const ctx = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }
    const moderator = new Moderator(ctx as any)
    const decision = await moderator.decide(goal, history, members, state)
    // 降级为规则协调：round=0 → invite 第一个成员
    expect(decision.type).toBe('invite')
    expect(ctx.createSession).toHaveBeenCalledTimes(2) // 初次 + 重试
  })

  it('降级模式：round >= 3 时强制 converge', async () => {
    const mockSession = {
      prompt: vi.fn().mockResolvedValue('invalid'),
      dispose: vi.fn(),
    }
    const ctx = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }
    const moderator = new Moderator(ctx as any)
    const lateState: ModeratorState = { ...state, round: 3 }
    const decision = await moderator.decide(goal, history, members, lateState)
    expect(decision.type).toBe('converge')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd apps/agent-server && npx vitest run src/__tests__/moderator.test.ts`
预期：FAIL，报错 `Cannot find module '../core/agent/moderator.js'`

- [ ] **步骤 3：实现 Moderator**

创建 `apps/agent-server/src/core/agent/moderator.ts`：

```typescript
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
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd apps/agent-server && npx vitest run src/__tests__/moderator.test.ts`
预期：PASS（全部 8 个用例）

- [ ] **步骤 5：Commit**

```bash
git add apps/agent-server/src/core/agent/moderator.ts apps/agent-server/src/__tests__/moderator.test.ts
git commit -m "feat(discussion): 实现 Moderator LLM 决策器 + 降级规则协调"
```

---

## 任务 3：实现 TeamDiscussionEngine

**文件：**
- 创建：`apps/agent-server/src/core/agent/team-discussion-engine.ts`
- 测试：`apps/agent-server/src/__tests__/team-discussion-engine.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `apps/agent-server/src/__tests__/team-discussion-engine.test.ts`：

```typescript
import { describe, expect, it, vi } from 'vitest'
import { TeamDiscussionEngine } from '../core/agent/team-discussion-engine.js'
import { Moderator, type ModeratorContext } from '../core/agent/moderator.js'
import { AgentChannel } from '../core/agent/agent-channel.js'
import type {
  DiscussionGoal,
  DiscussionMember,
  DiscussionMessage,
  ModeratorDecision,
  DiscussionOptions,
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
    expect(result.transcript.length).toBeGreaterThanOrEqual(2) // 系统消息 + director 发言
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
    // 持续返回 observe，引擎应在 MAX_OBSERVE_ROUNDS(3) 后强制 converge
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
    // 引擎应因为 observe 超限触发强制 converge（或总轮数超限）
    expect(result.transcript.length).toBeGreaterThan(0)
  })

  it('总轮数超限后强制 converge', async () => {
    const members = [
      makeMember({ id: 'director', name: '导演' }),
      makeMember({ id: 'writer', name: '写作', canConverge: true }),
    ]
    // 持续返回 invite，不 converge，引擎应在 MAX_ROUNDS(20) 后强制 converge
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
    // 成员发言失败不阻塞流程，Moderator 下轮看到错误消息后继续决策
    expect(result.transcript.some(m => m.type === 'error')).toBe(true)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd apps/agent-server && npx vitest run src/__tests__/team-discussion-engine.test.ts`
预期：FAIL，报错 `Cannot find module '../core/agent/team-discussion-engine.js'`

- [ ] **步骤 3：实现 TeamDiscussionEngine**

创建 `apps/agent-server/src/core/agent/team-discussion-engine.ts`：

```typescript
/**
 * TeamDiscussionEngine：通用群聊引擎
 *
 * 驱动群聊循环：Moderator 决策 → 成员发言 → 消息入历史 → 下一轮。
 * 不依赖任何业务领域（不知道"小说"是什么）。
 *
 * 循环阶段：
 * 1. planning：Moderator 驱动规划，Director 输出场景拆分
 * 2. acting（场景循环）：每个场景内角色演出 → Writer 整理
 * 3. chapter_weaving：Writer 合并各场景片段
 * 4. reviewing：Reviewer 审稿
 *
 * 死锁防护：
 * - 总轮数 ≤ MAX_ROUNDS(20)
 * - 单场景轮数 ≤ MAX_ROUNDS_PER_SCENE(10)
 * - 连续 observe ≤ MAX_OBSERVE_ROUNDS(3)
 * - 任一超限 → 强制 converge
 */

import type { FastifyBaseLogger } from 'fastify'
import type { AgUiSessionHandle, PluginContext } from '../plugin/plugin-types.js'
import type { AgUiEventSink } from '@repo/protocol/events'
import { AgentChannel } from './agent-channel.js'
import { Moderator } from './moderator.js'
import type {
  DiscussionGoal,
  DiscussionMember,
  DiscussionMessage,
  DiscussionOptions,
  DiscussionResult,
  DiscussionFlowEvent,
  ModeratorState,
  ModeratorDecision,
  SceneDefinition,
  DiscussionPhase,
} from './discussion-types.js'
import { DISCUSSION_LIMITS } from './discussion-types.js'

/** 引擎上下文：提供 createAgUiSession 工厂 + 日志 */
export interface EngineContext {
  createAgUiSession(options: {
    systemPrompt: string
    prefixUserMessage?: string | string[]
    userMessage: string
    tools?: unknown[]
    signal?: AbortSignal
    temperature?: number
    timeoutMs?: number
    emit: AgUiEventSink
    emitRaw?: boolean
    onFirstText?: () => void
  }): Promise<AgUiSessionHandle>
  logger: FastifyBaseLogger
}

export class TeamDiscussionEngine {
  constructor(
    private moderator: Moderator,
    private channel: AgentChannel,
    private context: EngineContext,
  ) {}

  async run(
    goal: DiscussionGoal,
    members: DiscussionMember[],
    options: DiscussionOptions,
  ): Promise<DiscussionResult> {
    const history: DiscussionMessage[] = []
    const channelName = `discuss-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    // 订阅所有成员到群聊频道
    for (const member of members) {
      this.channel.subscribe(channelName, member.id)
    }

    // 注入初始系统消息
    history.push(this.systemMessage(`目标：${goal.task}\n\n## 上下文\n${goal.context}`))

    let scenes: SceneDefinition[] = []
    let sceneContents: string[] = []
    let finalContent = ''
    let rounds = 0
    let noProgressRounds = 0

    try {
      // ── Phase 1：规划 ──
      let planningDone = false
      while (!planningDone && rounds < DISCUSSION_LIMITS.MAX_ROUNDS) {
        const state: ModeratorState = {
          phase: 'planning',
          round: rounds,
          scenesDefined: scenes.length > 0,
        }
        const decision = await this.moderator.decide(goal, history, members, state)
        await this.handleDecision(decision, history, members, options, channelName, { phase: 'planning' })
        rounds++

        if (decision.type === 'converge' && decision.scope === 'chapter') {
          // 规划完成，尝试解析场景
          scenes = this.parseScenes(history, members)
          planningDone = true
        }
        if (decision.type === 'observe') {
          noProgressRounds++
          if (noProgressRounds >= DISCUSSION_LIMITS.MAX_OBSERVE_ROUNDS) {
            planningDone = true
            scenes = [] // 无场景，直接全章模式
          }
        } else {
          noProgressRounds = 0
        }
      }

      // ── Phase 2：场景循环（如有场景）──
      if (scenes.length > 0) {
        for (let i = 0; i < scenes.length; i++) {
          const scene = scenes[i]
          rounds = 0
          noProgressRounds = 0

          history.push(this.systemMessage(this.buildSceneContext(scene)))
          this.emitProgress(options, 'scene_setup', { type: 'scene_change', data: { scene } })

          const activeMembers = this.filterMembersByScene(members, scene)
          let sceneDone = false

          while (!sceneDone && rounds < DISCUSSION_LIMITS.MAX_ROUNDS_PER_SCENE) {
            const state: ModeratorState = {
              phase: 'acting',
              round: rounds,
              currentScene: scene,
              scenesRemaining: scenes.length - i - 1,
              scenesDefined: true,
            }
            const decision = await this.moderator.decide(goal, history, activeMembers, state)
            await this.handleDecision(decision, history, activeMembers, options, channelName, { phase: 'acting', sceneId: scene.sceneId })
            rounds++

            if (decision.type === 'converge' && decision.scope === 'scene') {
              const sceneContent = await this.weaveScene(decision.agentId, history, scene, members, options)
              sceneContents.push(sceneContent)
              sceneDone = true
            } else if (decision.type === 'next_scene') {
              sceneDone = true
            } else if (decision.type === 'observe') {
              noProgressRounds++
              if (noProgressRounds >= DISCUSSION_LIMITS.MAX_OBSERVE_ROUNDS) {
                const writer = members.find(m => m.canConverge)
                if (writer) {
                  const sceneContent = await this.weaveScene(writer.id, history, scene, members, options)
                  sceneContents.push(sceneContent)
                  sceneDone = true
                }
              }
            } else {
              noProgressRounds = 0
            }
          }
        }
      }

      // ── Phase 3：全章编织 ──
      this.emitProgress(options, 'chapter_weaving', { type: 'phase_change', data: { message: '正在编织完整章节' } })
      finalContent = await this.weaveChapter(members, sceneContents, scenes, goal, options)

      return {
        status: 'completed',
        content: finalContent,
        transcript: history,
        scenes,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.context.logger.error({ err }, '群聊引擎异常')
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
        try {
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
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          history.push(this.errorMessage(`${member.name} 发言失败：${errMsg}`))
        }
        break
      }
      case 'pause': {
        this.emitProgress(options, ctx.phase, { type: 'pause', data: { question: decision.question } })
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
        // 由调用方循环处理
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
    const transcriptSummary = this.formatTranscriptForMember(history, member.id)
    const userMessage = `${prompt}\n\n---\n\n## 群聊记录\n\n${transcriptSummary}`

    const handle = await this.context.createAgUiSession({
      systemPrompt,
      userMessage,
      tools: [],
      signal: options.signal,
      temperature: member.type === 'character' ? 0.8 : 0.7,
      timeoutMs: 300_000,
      emit: options.emit,
      emitRaw: false,
      onFirstText: () => {
        this.emitProgress(options, ctx.phase, {
          type: 'agent_start',
          data: { agentName: member.name, message: `${member.name} 开始发言...` },
        })
      },
    })

    try {
      const result = await handle.session.prompt()
      handle.streamEmitter.finishTextMessage()
      return result
    } finally {
      handle.dispose()
    }
  }

  /** 整理单个场景的群聊记录为正文片段 */
  private async weaveScene(
    writerId: string,
    history: DiscussionMessage[],
    scene: SceneDefinition,
    members: DiscussionMember[],
    options: DiscussionOptions,
  ): Promise<string> {
    const writer = members.find(m => m.id === writerId)
    if (!writer) throw new Error(`收敛成员不存在: ${writerId}`)

    const sceneMessages = history.filter(m => m.sceneId === scene.sceneId && m.type === 'member')
    const transcript = sceneMessages.map(m => `[${m.fromName}] ${m.content}`).join('\n\n')

    const prompt = `请将以下群聊演出记录整理为小说正文片段。

## 场景信息
- 标题：${scene.title}
- 地点：${scene.location}
- 时间：${scene.time}
- 冲突：${scene.conflict ?? '无'}
- 目标：${scene.goal}

## 群聊演出记录
${transcript}

## 要求
1. 把剧本格式（[动作] "台词"）编织为小说叙事
2. 统一叙事视角，加入环境描写和节奏控制
3. 保留角色台词的核心内容，但可以调整措辞以适应叙事
4. 绝不使用破折号"——"`

    const result = await this.invokeMember(writer, prompt, [], options, { phase: 'scene_weaving' })
    return result
  }

  /** 合并各场景片段为完整章节正文 */
  private async weaveChapter(
    members: DiscussionMember[],
    sceneContents: string[],
    scenes: SceneDefinition[],
    goal: DiscussionGoal,
    options: DiscussionOptions,
  ): Promise<string> {
    const writer = members.find(m => m.canConverge)
    if (!writer) throw new Error('无可收敛成员')

    if (sceneContents.length === 0) {
      // 无场景（规划阶段未拆场），直接让 writer 基于群聊记录产出
      const result = await this.invokeMember(writer, '请基于群聊记录产出完整章节正文', [], options, { phase: 'chapter_weaving' })
      return result
    }

    const combined = sceneContents.map((content, i) => {
      const scene = scenes[i]
      return `### 场景${i + 1}：${scene?.title ?? ''}\n\n${content}`
    }).join('\n\n---\n\n')

    const prompt = `请将以下各场景的正文片段合并为完整章节正文。

## 各场景片段
${combined}

## 要求
1. 场景之间自然过渡，不要生硬拼接
2. 确保整体节奏流畅
3. 绝不使用破折号"——"`

    const result = await this.invokeMember(writer, prompt, [], options, { phase: 'chapter_weaving' })
    return result
  }

  /** 解析 Director 输出为场景列表 */
  private parseScenes(history: DiscussionMessage[], members: DiscussionMember[]): SceneDefinition[] {
    // 找到最后一条工种成员发言（通常是 Director 的规划）
    const directorMsg = [...history].reverse().find(m => m.type === 'member' && m.fromId.startsWith('novel-'))
    if (!directorMsg) return []

    // 构建角色名 → 成员 ID 映射表
    const nameToId = new Map<string, string>()
    for (const m of members) {
      if (m.type === 'character') {
        nameToId.set(m.name, m.id)
      }
    }

    const scenes: SceneDefinition[] = []
    const sceneRegex = /###\s*场景\s*(\d+)[：:]\s*(.+?)(?=\n###\s*场景|$)/gs
    const matches = directorMsg.content.matchAll(sceneRegex)

    for (const match of matches) {
      const sceneId = parseInt(match[1], 10)
      const block = match[2]
      const title = block.split('\n')[0].trim()
      const location = this.extractField(block, '地点') ?? '未指定'
      const time = this.extractField(block, '时间') ?? '未指定'
      const conflict = this.extractField(block, '冲突') ?? undefined
      const goalText = this.extractField(block, '目标') ?? ''

      const presentNamesRaw = this.extractField(block, '在场角色') ?? ''
      const presentNames = presentNamesRaw.split(/[、,，\s]+/).filter(Boolean)
      const presentCharacters = presentNames
        .map(name => nameToId.get(name.trim()))
        .filter((id): id is string => !!id)

      scenes.push({ sceneId, title, location, time, presentCharacters, conflict, goal: goalText })
    }

    return scenes
  }

  /** 从 markdown 块中提取字段值 */
  private extractField(block: string, fieldName: string): string | undefined {
    const regex = new RegExp(`-\\s*${fieldName}[：:]\\s*(.+)`)
    const match = block.match(regex)
    return match?.[1]?.trim()
  }

  /** 过滤场景在场成员 */
  private filterMembersByScene(members: DiscussionMember[], scene: SceneDefinition): DiscussionMember[] {
    return members.filter(m => {
      if (m.type === 'role') return true // 工种 Agent 始终在场
      return scene.presentCharacters.includes(m.id)
    })
  }

  /** 格式化群聊记录摘要（给成员看） */
  private formatTranscriptForMember(history: DiscussionMessage[], _memberId: string): string {
    const recent = history.slice(-10)
    return recent.map(m => `[${m.fromName}] ${m.content}`).join('\n\n')
  }

  private systemMessage(content: string): DiscussionMessage {
    return {
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      fromId: 'system',
      fromName: '系统',
      content,
      timestamp: Date.now(),
      type: 'system',
    }
  }

  private errorMessage(content: string): DiscussionMessage {
    return {
      id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      fromId: 'system',
      fromName: '系统',
      content,
      timestamp: Date.now(),
      type: 'error',
    }
  }

  private emitProgress(options: DiscussionOptions, phase: DiscussionPhase, event: { type: DiscussionFlowEvent['type']; data: unknown }): void {
    options.onProgress({
      type: event.type,
      phase,
      data: event.data,
      timestamp: Date.now(),
    })
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd apps/agent-server && npx vitest run src/__tests__/team-discussion-engine.test.ts`
预期：PASS（全部 5 个用例）

- [ ] **步骤 5：Commit**

```bash
git add apps/agent-server/src/core/agent/team-discussion-engine.ts apps/agent-server/src/__tests__/team-discussion-engine.test.ts
git commit -m "feat(discussion): 实现通用群聊引擎 + 死锁防护 + 场景循环"
```

---

## 任务 4：抽取 ChapterFinalizer

**文件：**
- 创建：`apps/agent-server/src/core/agent/chapter-finalizer.ts`
- 修改：`apps/agent-server/src/plugins/novel-plugin/core/novel-orchestrator.ts`
- 测试：`apps/agent-server/src/__tests__/chapter-finalizer.test.ts`

- [ ] **步骤 1：阅读 NovelOrchestrator 中要抽取的方法**

阅读 [novel-orchestrator.ts](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-orchestrator.ts) 中的以下私有方法，理解它们的依赖和签名：
- `stripThinkingPrelude` (L1992)
- `captureEntityState` (L1206)
- `parseIdList` (L1304)
- `recordMemoryEvents` (L1320)
- `applyHeuristicCausalLinks` (L1701)
- `syncChapterDimensions` (L1829)
- `saveChapterSnapshot` (L1961)
- `runMemoryAgent` (L1067)
- `generateChapterTitles` (L2065)
- `generateChapterRecap` (L2116)

- [ ] **步骤 2：创建 ChapterFinalizer 类**

创建 `apps/agent-server/src/core/agent/chapter-finalizer.ts`。此文件将上述 10 个方法从 `NovelOrchestrator` 原样迁移，方法签名和行为不变，只是从 `private` 改为 `public`，并接收必要的依赖。

```typescript
/**
 * ChapterFinalizer：章节收尾工具类
 *
 * 从 NovelOrchestrator 抽取，workflow 和 discussion 两边共用。
 * 负责：清洗正文 → 落库 → Memory 提取 → 状态快照 → 标题/提要生成。
 */

import type { NovelStore } from '../../plugins/novel-plugin/core/novel-store.js'
import type { NovelMemoryStore } from '../../plugins/novel-plugin/core/novel-memory-store.js'
import type { NovelPromptBuilder } from '../../plugins/novel-plugin/core/prompt-builder.js'
import type { NovelEngine } from '../../plugins/novel-plugin/core/novel-engine.js'
import type { NovelMemoryGenerator } from '../../plugins/novel-plugin/core/novel-memory-generator.js'
import type { PluginContext } from '../plugin/plugin-types.js'
import type { AgUiEventSink } from '@repo/protocol/events'
import type { ArrangedEntity, NarrativeTask } from '../../plugins/novel-plugin/core/types.js'
import type { CreationFlowEvent, DiscussionFlowEvent } from './discussion-types.js'
import { runtimePerformance } from '../../config/performance.js'

export class ChapterFinalizer {
  constructor(
    private store: NovelStore,
    private memoryStore: NovelMemoryStore,
    private promptBuilder: NovelPromptBuilder,
    private engine: NovelEngine,
    private context: PluginContext,
    private memoryGenerator?: NovelMemoryGenerator,
  ) {}

  /**
   * 章节收尾：落库 + Memory + 标题/提要 + 状态快照
   *
   * @param params.projectId 项目 ID
   * @param params.chapterNumber 章节号
   * @param params.content 章节正文（未清洗）
   * @param params.options.emit AG-UI 事件发射器
   * @param params.options.onProgress 进度回调
   * @param params.options.signal 取消信号
   * @param params.arrangedEntities 编排实体（可选）
   * @param params.directorTask 叙事任务（可选，用于落库 timeOffset/hook）
   */
  async finalize(params: {
    projectId: string
    chapterNumber: number
    content: string
    options: {
      emit: AgUiEventSink
      onProgress: (event: CreationFlowEvent | DiscussionFlowEvent) => void
      signal?: AbortSignal
    }
    arrangedEntities?: ArrangedEntity
    directorTask?: NarrativeTask
  }): Promise<void> {
    // 实现从 NovelOrchestrator.runMemoryAgent 调用点之后的收尾逻辑迁移
    // 1. stripThinkingPrelude 清洗
    // 2. updateChapter 落库
    // 3. runMemoryAgent（或 memoryGenerator.generate）
    // 4. captureEntityState + recordMemoryEvents + syncChapterDimensions + saveChapterSnapshot
    // 5. generateChapterTitles + generateChapterRecap
    //
    // 具体实现：将 NovelOrchestrator 中 createChapterWithFlow 方法从
    // "await this.runMemoryAgent(...)" 到方法结束的代码块迁移过来，
    // 把 this.xxx() 调用改为 this.xxx()（方法在本类中），
    // 把 this.store / this.memoryStore / this.promptBuilder 等改为 this.xxx。
    // 方法签名和行为完全不变。
    void params
    void runtimePerformance
    // ⚠️ 实现时：从 novel-orchestrator.ts 的 createChapterWithFlow 方法中，
    // 从 Memory 阶段开始到方法结束的所有代码迁移到此处。
    // 包括 stripThinkingPrelude / updateChapter / runMemoryAgent /
    // captureEntityState / recordMemoryEvents / applyHeuristicCausalLinks /
    // syncChapterDimensions / saveChapterSnapshot / generateChapterTitles /
    // generateChapterRecap 的调用。
    throw new Error('ChapterFinalizer.finalize 尚未实现——需从 NovelOrchestrator 迁移收尾逻辑')
  }

  // ── 以下方法从 NovelOrchestrator 原样迁移（private → public）──

  /** 清洗思考前缀（<prelude>...</prelude>） */
  stripThinkingPrelude(content: string): string {
    // 原样迁移自 NovelOrchestrator.stripThinkingPrelude
    return content.replace(/<prelude>[\s\S]*?<\/prelude>/g, '').trim()
  }

  parseIdList(raw: string): string[] {
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  // captureEntityState / recordMemoryEvents / applyHeuristicCausalLinks /
  // syncChapterDimensions / saveChapterSnapshot / runMemoryAgent /
  // generateChapterTitles / generateChapterRecap
  // → 从 NovelOrchestrator 原样迁移，this.store/memoryStore/promptBuilder/engine/context
  //   引用保持不变（本类持有相同依赖）
}
```

**重要说明**：步骤 2 的代码是骨架。实际实现时，需要打开 [novel-orchestrator.ts](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-orchestrator.ts)，将以下方法的完整实现代码复制到 `ChapterFinalizer`：
- L1992 `stripThinkingPrelude` — 完整复制
- L1304 `parseIdList` — 完整复制
- L1206 `captureEntityState` — 完整复制
- L1320 `recordMemoryEvents` — 完整复制
- L1701 `applyHeuristicCausalLinks` — 完整复制
- L1829 `syncChapterDimensions` — 完整复制
- L1961 `saveChapterSnapshot` — 完整复制
- L1067 `runMemoryAgent` — 完整复制（含 memoryGenerator 调用 + 回退逻辑）
- L2065 `generateChapterTitles` — 完整复制
- L2116 `generateChapterRecap` — 完整复制

`finalize()` 方法体从 `createChapterWithFlow` 的 Memory 阶段（约 L525 开始的 `await this.runMemoryAgent(...)`）到方法结束的代码迁移，把 `this.emitProgress(options, ...)` 改为 `params.options.onProgress({...})`，把 `this.currentArrangedEntities` 改为 `params.arrangedEntities`。

- [ ] **步骤 3：编写 ChapterFinalizer 单测**

创建 `apps/agent-server/src/__tests__/chapter-finalizer.test.ts`：

```typescript
import { describe, expect, it, vi } from 'vitest'
import { ChapterFinalizer } from '../core/agent/chapter-finalizer.js'

describe('ChapterFinalizer', () => {
  it('stripThinkingPrelude 清洗 prelude 标签', () => {
    const finalizer = new ChapterFinalizer(
      {} as any, {} as any, {} as any, {} as any, {} as any,
    )
    const input = '<prelude>思考内容</prelude>正文开始'
    expect(finalizer.stripThinkingPrelude(input)).toBe('正文开始')
  })

  it('stripThinkingPrelude 无 prelude 标签时原样返回', () => {
    const finalizer = new ChapterFinalizer(
      {} as any, {} as any, {} as any, {} as any, {} as any,
    )
    const input = '纯正文内容'
    expect(finalizer.stripThinkingPrelude(input)).toBe('纯正文内容')
  })

  it('parseIdList 解析 JSON 数组', () => {
    const finalizer = new ChapterFinalizer(
      {} as any, {} as any, {} as any, {} as any, {} as any,
    )
    expect(finalizer.parseIdList('["a","b","c"]')).toEqual(['a', 'b', 'c'])
    expect(finalizer.parseIdList('')).toEqual([])
    expect(finalizer.parseIdList('invalid')).toEqual([])
  })
})
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd apps/agent-server && npx vitest run src/__tests__/chapter-finalizer.test.ts`
预期：PASS（3 个用例）

- [ ] **步骤 5：修改 NovelOrchestrator 使用 ChapterFinalizer**

在 [novel-orchestrator.ts](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-orchestrator.ts) 中：

1. 在构造函数中新增 `finalizer: ChapterFinalizer` 参数
2. 将 `this.stripThinkingPrelude(...)` → `this.finalizer.stripThinkingPrelude(...)`
3. 将 `this.captureEntityState(...)` → `this.finalizer.captureEntityState(...)`
4. 将 `this.parseIdList(...)` → `this.finalizer.parseIdList(...)`
5. 将 `this.recordMemoryEvents(...)` → `this.finalizer.recordMemoryEvents(...)`
6. 将 `this.applyHeuristicCausalLinks(...)` → `this.finalizer.applyHeuristicCausalLinks(...)`
7. 将 `this.syncChapterDimensions(...)` → `this.finalizer.syncChapterDimensions(...)`
8. 将 `this.saveChapterSnapshot(...)` → `this.finalizer.saveChapterSnapshot(...)`
9. 将 `this.runMemoryAgent(...)` → `this.finalizer.runMemoryAgent(...)`
10. 将 `this.generateChapterTitles(...)` → `this.finalizer.generateChapterTitles(...)`
11. 将 `this.generateChapterRecap(...)` → `this.finalizer.generateChapterRecap(...)`
12. 删除 NovelOrchestrator 中这 10 个私有方法的定义（代码已迁移到 ChapterFinalizer）

**注意**：`runMemoryAgent` 和 `generateChapterTitles`/`generateChapterRecap` 内部调用了 `this.emitProgress` 和 `this.currentArrangedEntities`，迁移时需要把这些引用改为通过参数传入或让 ChapterFinalizer 持有必要的上下文。最简方案：让 ChapterFinalizer 的 `finalize` 方法接收完整的 options 和 arrangedEntities，内部方法调用改为 `this.xxx()`（本类方法），`emitProgress` 改为直接调用 `options.onProgress`。

- [ ] **步骤 6：运行现有测试确保无回归**

运行：`cd apps/agent-server && npx vitest run`
预期：全部 PASS（特别是 novel-routes.test.ts、novel-plugin-session.test.ts 不能有回归）

- [ ] **步骤 7：Commit**

```bash
git add apps/agent-server/src/core/agent/chapter-finalizer.ts apps/agent-server/src/__tests__/chapter-finalizer.test.ts apps/agent-server/src/plugins/novel-plugin/core/novel-orchestrator.ts
git commit -m "refactor: 抽取 ChapterFinalizer，workflow 和 discussion 共用收尾逻辑"
```

---

## 任务 5：创建群聊模式 prompt 模板

**文件：**
- 创建：`apps/agent-server/src/plugins/novel-plugin/core/prompts/role-writer-discussion.md`
- 创建：`apps/agent-server/src/plugins/novel-plugin/core/prompts/role-character-actor.md`

- [ ] **步骤 1：创建 role-writer-discussion.md**

创建 `apps/agent-server/src/plugins/novel-plugin/core/prompts/role-writer-discussion.md`：

```markdown
负责群聊模式下的正文编织。

你是小说的"编织者"，在群聊共创模式中负责把角色的剧本演出整理为小说叙事。

## 你的职责
- 把角色 Agent 输出的剧本格式（[动作] "台词"）编织为小说叙事
- 统一叙事视角，加入环境描写和节奏控制
- 保持文风统一，遵循风格指南
- 确保角色台词符合其说话风格
- 控制叙事节奏，营造适当的氛围和张力

## 编织规则
1. **视角统一**：选择合适的叙事视角（第一人称/第三人称），全场景保持一致
2. **剧本转叙事**：把 `[动作] "台词"` 格式转化为自然的小说段落
   - 动作描述 → 融入叙事（"他拍桌站起" → "赵岩猛地拍桌站起，椅子在地板上刮出刺耳的声响"）
   - 台词 → 保留核心内容，可调整措辞以适应叙事节奏
3. **环境描写**：在场景开头和关键转折处加入环境描写，营造氛围
4. **节奏控制**：快节奏用短句，慢节奏用长句，关键处留白
5. **补充过渡**：场景之间需要过渡段落，不能生硬拼接

## 输出规范
- 遵循创作指令中指定的目标字数，允许 ±15% 浮动
- 不得用无意义内容凑字数，也不得草草收尾
- 绝不使用破折号"——"，转折用句号，补充用逗号，列举用顿号

## 创作核心原则
1. **Show, don't tell**：用角色的行动、对话和感官细节展示情绪和状态
2. **声音一致性**：保持叙事腔调与前文一致
3. **章尾留钩**：每章结尾必须留下钩子（悬念/反转/情感/行动），止于一个动作、一句对话或一个画面
4. **信息控制**：角色不能知道不该知道的事
5. **开篇承接**：第一句必须自然承接上一章结尾
```

- [ ] **步骤 2：创建 role-character-actor.md**

创建 `apps/agent-server/src/plugins/novel-plugin/core/prompts/role-character-actor.md`：

```markdown
你是小说中的一个角色，正在以第一人称参与群聊共创。

## 你的行为规则
1. **始终以第一人称说话和行动**，你就是这个角色本人
2. **严格遵循你的性格和当前心理状态**——如果群聊里的情境让你"不会这么做"，明确说出你的异议，标记 [PUSHBACK] 并说明原因
3. **你的输出是剧本格式**：先写 [动作/表情/心理外化]，然后写 "台词"
4. **不要写小说叙述**（环境描写/心理独白/节奏控制由 Writer 负责）
5. **如果有人提出让你做明显违反人设的事**，标记 [PUSHBACK] 并说明原因
6. **绝不使用破折号"——"**，转折用句号，补充用逗号，列举用顿号

## 输出格式
```
[动作/表情/心理外化]
"你的台词"
```

## 示例
```
[拍桌，怒目圆睁]
"你胡说！那批料的检验报告我亲眼看过，明明是合格的！"
```

## PUSHBACK 示例
```
[PUSHBACK] 赵岩的性格是刚烈且正直，他不会在证据确凿时选择沉默求饶。
[摇头，后退一步]
"我不可能答应这种事。你要杀要剐随便，但我不会替你背这个黑锅。"
```

## 重要提醒
- 你只在被点名时发言
- 你的台词和动作会被 Writer 编织进小说正文
- 保持角色一致性是最高优先级，高于"推进剧情"
- 如果角色的秘密可能会暴露，按角色性格决定是否守护
```

- [ ] **步骤 3：Commit**

```bash
git add apps/agent-server/src/plugins/novel-plugin/core/prompts/role-writer-discussion.md apps/agent-server/src/plugins/novel-plugin/core/prompts/role-character-actor.md
git commit -m "feat(discussion): 新增群聊模式 Writer + 角色 Agent prompt 模板"
```

---

## 任务 6：实现 NovelDiscussionRunner

**文件：**
- 创建：`apps/agent-server/src/plugins/novel-plugin/core/novel-discussion-runner.ts`
- 测试：`apps/agent-server/src/__tests__/novel-discussion-runner.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `apps/agent-server/src/__tests__/novel-discussion-runner.test.ts`：

```typescript
import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { NovelStore } from '../plugins/novel-plugin/core/novel-store.js'
import { NovelMemoryStore } from '../plugins/novel-plugin/core/novel-memory-store.js'
import { PromptManager } from '../plugins/novel-plugin/core/prompt-manager.js'
import { NovelPromptBuilder } from '../plugins/novel-plugin/core/prompt-builder.js'
import { NovelEngine } from '../plugins/novel-plugin/core/novel-engine.js'
import { NovelSessionFactory } from '../plugins/novel-plugin/core/novel-session.js'
import { novelMigrations } from '../plugins/novel-plugin/novel-migrations.js'
import { NovelDiscussionRunner } from '../plugins/novel-plugin/core/novel-discussion-runner.js'
import type { DiscussionOptions } from '../core/agent/discussion-types.js'

function setupTestDb(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of novelMigrations) {
    db.exec(migration.sql)
  }
  return db
}

function makeOptions(): DiscussionOptions {
  return {
    emit: vi.fn(),
    onCheckpoint: vi.fn().mockResolvedValue('approve'),
    onProgress: vi.fn(),
  }
}

describe('NovelDiscussionRunner', () => {
  let db: Database.Database
  let store: NovelStore
  let memoryStore: NovelMemoryStore

  beforeAll(() => {
    db = setupTestDb()
    store = new NovelStore(db)
    memoryStore = new NovelMemoryStore(db)
  })

  afterAll(() => {
    db.close()
  })

  it('buildMembers 包含 4 个工种 Agent + 项目角色', () => {
    // 创建测试项目 + 角色
    const project = store.createProject({
      title: '测试小说',
      synopsis: '测试简介',
      outline: '测试大纲',
    } as any)
    store.createCharacter({
      projectId: project.id,
      name: '赵岩',
      personality: '刚烈正直',
      currentState: '愤怒',
      currentGoal: '查清真相',
      secret: '是卧底',
      arcStage: '觉醒',
    } as any)

    const promptManager = new PromptManager(db, process.cwd())
    const promptBuilder = new NovelPromptBuilder(promptManager, store, memoryStore)
    const sessionFactory = new NovelSessionFactory(store, promptManager)
    const engine = new NovelEngine(store, sessionFactory)
    const mockContext = {
      createAgUiSession: vi.fn(),
      createSession: vi.fn(),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    } as any

    const runner = new NovelDiscussionRunner(
      store, memoryStore, sessionFactory, promptBuilder, engine, mockContext, {} as any,
    )

    // 通过反射调用 buildMembers
    const members = (runner as any).buildMembers(project.id, 1)
    expect(members.length).toBe(5) // 4 工种 + 1 角色
    expect(members.filter((m: any) => m.type === 'role').length).toBe(4)
    expect(members.filter((m: any) => m.type === 'character').length).toBe(1)
    expect(members.find((m: any) => m.type === 'character').name).toBe('赵岩')
  })

  it('buildCharacterPrompt 注入角色人设字段', () => {
    const project = store.createProject({
      title: '测试',
      synopsis: '',
      outline: '',
    } as any)
    const char = store.createCharacter({
      projectId: project.id,
      name: '李明',
      personality: '沉稳冷静',
      currentState: '焦虑',
      currentGoal: '保护家人',
      secret: '欠债',
      arcStage: '挣扎',
    } as any)

    const promptManager = new PromptManager(db, process.cwd())
    const promptBuilder = new NovelPromptBuilder(promptManager, store, memoryStore)
    const sessionFactory = new NovelSessionFactory(store, promptManager)
    const engine = new NovelEngine(store, sessionFactory)
    const mockContext = {
      createAgUiSession: vi.fn(),
      createSession: vi.fn(),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    } as any

    const runner = new NovelDiscussionRunner(
      store, memoryStore, sessionFactory, promptBuilder, engine, mockContext, {} as any,
    )
    const prompt = (runner as any).buildCharacterPrompt(char)
    expect(prompt).toContain('李明')
    expect(prompt).toContain('沉稳冷静')
    expect(prompt).toContain('焦虑')
    expect(prompt).toContain('保护家人')
    expect(prompt).toContain('欠债')
    expect(prompt).toContain('挣扎')
    // 确认破折号禁令
    expect(prompt).toContain('绝不使用破折号')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd apps/agent-server && npx vitest run src/__tests__/novel-discussion-runner.test.ts`
预期：FAIL，报错 `Cannot find module '../plugins/novel-plugin/core/novel-discussion-runner.js'`

- [ ] **步骤 3：实现 NovelDiscussionRunner**

创建 `apps/agent-server/src/plugins/novel-plugin/core/novel-discussion-runner.ts`：

```typescript
/**
 * NovelDiscussionRunner：novel 适配器
 *
 * 把 novel 的 Agent 角色翻译成群聊成员，构建目标，调用引擎，收尾。
 * 不包含业务编排逻辑（编排逻辑在 TeamDiscussionEngine + Moderator）。
 */

import type { FastifyBaseLogger } from 'fastify'
import type { PluginContext } from '../../../core/plugin/plugin-types.js'
import type { AgUiEventSink } from '@repo/protocol/events'
import { AgentChannel } from '../../../core/agent/agent-channel.js'
import { Moderator } from '../../../core/agent/moderator.js'
import { TeamDiscussionEngine, type EngineContext } from '../../../core/agent/team-discussion-engine.js'
import { ChapterFinalizer } from '../../../core/agent/chapter-finalizer.js'
import type {
  DiscussionGoal,
  DiscussionMember,
  DiscussionOptions,
  DiscussionResult,
} from '../../../core/agent/discussion-types.js'
import { NovelStore } from './novel-store.js'
import { NovelMemoryStore } from './novel-memory-store.js'
import { NovelPromptBuilder } from './prompt-builder.js'
import { NovelEngine } from './novel-engine.js'
import { NovelSessionFactory } from './novel-session.js'
import { NOVEL_AGENT_CONFIGS, type NovelAgentType } from './novel-agents.js'
import type { NovelCharacter } from './types.js'

export class NovelDiscussionRunner {
  constructor(
    private store: NovelStore,
    private memoryStore: NovelMemoryStore,
    private sessionFactory: NovelSessionFactory,
    private promptBuilder: NovelPromptBuilder,
    private engine: NovelEngine,
    private context: PluginContext,
    private moderatorModel?: { provider: string; modelId: string },
    private memoryGenerator?: any,
  ) {}

  async run(
    projectId: string,
    chapterNumber: number,
    options: DiscussionOptions,
  ): Promise<DiscussionResult> {
    // 1. 构建 SEMI 层 shared 上下文
    const constraints = this.engine.buildChapterConstraints(projectId, chapterNumber)
    const defaultTask = this.buildDefaultNarrativeTask(chapterNumber)
    const sharedContext = this.promptBuilder.buildChapterContextShared(
      projectId, chapterNumber, defaultTask, constraints, undefined,
    )

    // 2. 构建目标
    const goal: DiscussionGoal = {
      task: `创作第 ${chapterNumber} 章正文`,
      context: sharedContext,
    }

    // 3. 构建成员列表
    const members = this.buildMembers(projectId, chapterNumber)

    // 4. 构建引擎
    const channel = new AgentChannel()
    const moderatorCtx = {
      createSession: this.context.createSession.bind(this.context),
      logger: this.context.logger,
    }
    const moderator = new Moderator(moderatorCtx, options.moderatorModel ?? this.moderatorModel)
    const engineCtx: EngineContext = {
      createAgUiSession: this.context.createAgUiSession.bind(this.context),
      logger: this.context.logger,
    }
    const engine = new TeamDiscussionEngine(moderator, channel, engineCtx)

    // 5. 运行
    const result = await engine.run(goal, members, options)

    // 6. 收尾（如果成功）
    if (result.status === 'completed' && result.content) {
      const finalizer = new ChapterFinalizer(
        this.store, this.memoryStore, this.promptBuilder, this.engine, this.context, this.memoryGenerator,
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

  /** 构建群聊成员：4 个工种 Agent + 项目角色 Agent */
  private buildMembers(projectId: string, chapterNumber: number): DiscussionMember[] {
    void chapterNumber
    const members: DiscussionMember[] = []

    // 工种 Agent（不含 Memory——收尾阶段单独跑）
    const roleAgents: NovelAgentType[] = ['director', 'writer', 'reviewer', 'reviser']
    for (const agentType of roleAgents) {
      const config = NOVEL_AGENT_CONFIGS[agentType]
      members.push({
        id: config.id,
        type: 'role',
        name: config.name,
        expertise: config.identity,
        canConverge: agentType === 'writer' || agentType === 'reviser',
        buildSystemPrompt: () => this.promptBuilder.buildSystemPrompt(projectId, agentType),
      })
    }

    // 角色 Agent：读取项目所有活跃角色
    const characters = this.store.listCharacters(projectId)
    for (const char of characters) {
      // 跳过已退场角色
      if (char.arcStage === 'resolved' && !char.currentGoal) continue

      members.push({
        id: `char-${char.id}`,
        type: 'character',
        name: char.name,
        expertise: char.personality ?? '未设定性格',
        canConverge: false,
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

  private buildDefaultNarrativeTask(chapterNumber: number) {
    return {
      description: `创作第 ${chapterNumber} 章正文`,
      type: 'advance_mainline' as const,
      targetEntity: null,
      priority: 'high' as const,
    }
  }

  private parseIdList(raw: string): string[] {
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd apps/agent-server && npx vitest run src/__tests__/novel-discussion-runner.test.ts`
预期：PASS（2 个用例）

- [ ] **步骤 5：Commit**

```bash
git add apps/agent-server/src/plugins/novel-plugin/core/novel-discussion-runner.ts apps/agent-server/src/__tests__/novel-discussion-runner.test.ts
git commit -m "feat(discussion): 实现 NovelDiscussionRunner novel 适配器"
```

---

## 任务 7：群聊设置存储 + 迁移

**文件：**
- 创建：`apps/agent-server/src/core/agent/discussion-settings-store.ts`
- 修改：`apps/agent-server/src/plugins/novel-plugin/novel-migrations.ts`

- [ ] **步骤 1：新增数据库迁移**

在 [novel-migrations.ts](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/novel-migrations.ts) 末尾的 `]` 之前追加：

```typescript
  {
    // 群聊模式设置（单行表，key-value 式存储）
    id: '060_create_novel_discussion_settings',
    sql: `CREATE TABLE IF NOT EXISTS novel_discussion_settings (
      key           TEXT PRIMARY KEY,
      value         TEXT NOT NULL,
      updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );`,
  },
```

- [ ] **步骤 2：实现 DiscussionSettingsStore**

创建 `apps/agent-server/src/core/agent/discussion-settings-store.ts`：

```typescript
/**
 * 群聊模式设置存储
 *
 * 单行 key-value 表，存储：
 * - moderatorModel：Moderator 使用的模型（JSON: {provider, modelId}）
 * - maxRounds：总轮数上限（默认 20）
 * - maxRoundsPerScene：单场景轮数上限（默认 10）
 * - characterTemperature：角色 Agent 温度（默认 0.8）
 */

import type Database from 'better-sqlite3'

export interface DiscussionSettings {
  moderatorModel?: { provider: string; modelId: string }
  maxRounds?: number
  maxRoundsPerScene?: number
  characterTemperature?: number
}

const DEFAULTS: Required<Omit<DiscussionSettings, 'moderatorModel'>> = {
  maxRounds: 20,
  maxRoundsPerScene: 10,
  characterTemperature: 0.8,
}

export class DiscussionSettingsStore {
  private stmtGet: Database.Statement
  private stmtUpsert: Database.Statement

  constructor(private db: Database.Database) {
    this.stmtGet = db.prepare('SELECT value FROM novel_discussion_settings WHERE key = ?')
    this.stmtUpsert = db.prepare(`
      INSERT INTO novel_discussion_settings (key, value, updated_at)
      VALUES (?, ?, unixepoch())
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
    `)
  }

  get(): DiscussionSettings {
    const settings: DiscussionSettings = {}
    const moderatorModel = this.getValue('moderatorModel')
    if (moderatorModel) {
      try { settings.moderatorModel = JSON.parse(moderatorModel) } catch { /* ignore */ }
    }
    const maxRounds = this.getValue('maxRounds')
    if (maxRounds) settings.maxRounds = parseInt(maxRounds, 10)
    const maxRoundsPerScene = this.getValue('maxRoundsPerScene')
    if (maxRoundsPerScene) settings.maxRoundsPerScene = parseInt(maxRoundsPerScene, 10)
    const characterTemperature = this.getValue('characterTemperature')
    if (characterTemperature) settings.characterTemperature = parseFloat(characterTemperature)
    return settings
  }

  update(settings: Partial<DiscussionSettings>): void {
    if (settings.moderatorModel !== undefined) {
      this.setValue('moderatorModel', JSON.stringify(settings.moderatorModel))
    }
    if (settings.maxRounds !== undefined) {
      this.setValue('maxRounds', String(settings.maxRounds))
    }
    if (settings.maxRoundsPerScene !== undefined) {
      this.setValue('maxRoundsPerScene', String(settings.maxRoundsPerScene))
    }
    if (settings.characterTemperature !== undefined) {
      this.setValue('characterTemperature', String(settings.characterTemperature))
    }
  }

  private getValue(key: string): string | undefined {
    const row = this.stmtGet.get(key) as { value: string } | undefined
    return row?.value
  }

  private setValue(key: string, value: string): void {
    this.stmtUpsert.run(key, value)
  }
}
```

- [ ] **步骤 3：Commit**

```bash
git add apps/agent-server/src/core/agent/discussion-settings-store.ts apps/agent-server/src/plugins/novel-plugin/novel-migrations.ts
git commit -m "feat(discussion): 新增群聊设置存储 + 060 迁移"
```

---

## 任务 8：NovelServices 接线 + 路由端点

**文件：**
- 修改：`apps/agent-server/src/plugins/novel-plugin/novel-services.ts`
- 修改：`apps/agent-server/src/plugins/novel-plugin/novel-routes.ts`

- [ ] **步骤 1：NovelServices 新增 discussionRunner + discussionSettingsStore**

在 [novel-services.ts](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/novel-services.ts) 中：

1. 在 `NovelServices` interface 中添加：
```typescript
  /** 群聊共创模式 Runner */
  discussionRunner: NovelDiscussionRunner
  /** 群聊设置存储 */
  discussionSettingsStore: DiscussionSettingsStore
```

2. 在 `createNovelServices` 函数中，在 `orchestrator` 创建之后添加：
```typescript
  // 11. 创建群聊设置存储
  const discussionSettingsStore = new DiscussionSettingsStore(db)

  // 12. 创建 NovelDiscussionRunner
  const discussionRunner = new NovelDiscussionRunner(
    store, memoryStore, sessionFactory, promptBuilder, engine, context,
    discussionSettingsStore.get().moderatorModel,
    memoryGenerator,
  )
```

3. 在 return 语句中添加 `discussionRunner, discussionSettingsStore`

4. 在文件顶部添加 import：
```typescript
import { NovelDiscussionRunner } from './core/novel-discussion-runner.js'
import { DiscussionSettingsStore } from '../../core/agent/discussion-settings-store.js'
```

- [ ] **步骤 2：novel-routes.ts 新增 /create-discussion 端点**

在 [novel-routes.ts](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/novel-routes.ts) 中，在 `/create-flow` 端点之后（约 L2180 处），新增 `/create-discussion` 端点。此端点的 SSE 设置与 `/create-flow` 完全一致，只是把 `orchestrator.createChapterWithFlow` 换成 `discussionRunner.run`：

```typescript
  // 群聊共创模式启动端点（SSE）
  routes.push({
    method: 'POST',
    path: '/projects/:projectId/chapters/:chapterNumber/create-discussion',
    handler: async (request: any, reply: any) => {
      const { projectId, chapterNumber } = request.params
      const runner = services.discussionRunner
      const input = validateBody(createFlowBodySchema, request, reply)
      if (!input) return reply
      const arrangedEntities = input.arrangedEntities
        ? {
            characterIds: input.arrangedEntities.characterIds,
            conflictIds: input.arrangedEntities.conflictIds,
            foreshadowIds: input.arrangedEntities.foreshadowIds,
            factionIds: input.arrangedEntities.factionIds,
            locationIds: input.arrangedEntities.locationIds,
          }
        : undefined

      // SSE 设置（与 create-flow 一致）
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': request.headers.origin || '*',
        'Access-Control-Allow-Credentials': 'true',
      })
      request.raw.socket?.setNoDelay(true)

      const heartbeat = setInterval(() => {
        reply.raw.write(': keepalive\n\n')
      }, 15000)

      const emitter = createNovelAgUiEmitter(
        createSseEmitterSink((data) => reply.raw.write(data)),
        `novel:discussion:${projectId}:${chapterNumber}`,
        randomUUID(),
      )

      // 读取群聊设置
      const settings = services.discussionSettingsStore.get()

      try {
        const result = await runner.run(projectId, parseInt(chapterNumber, 10), {
          emit: emitter.emit,
          moderatorModel: settings.moderatorModel,
          onCheckpoint: async (checkpoint) => {
            const toolCallId = randomUUID()
            const decisionPromise = services.confirmationManager.requestDecision({
              threadId: `novel-discussion-${projectId}-${chapterNumber}`,
              toolCallId,
              toolName: `checkpoint_${checkpoint.type}`,
              args: { checkpoint } as Record<string, unknown>,
              reason: `等待用户确认 ${checkpoint.phase} 阶段检查点`,
            }, 0)
            const pending = services.confirmationManager.listPending().find((r) => r.toolCallId === toolCallId)
            emitter.checkpoint({ ...checkpoint, checkpointId: pending?.id })
            return decisionPromise as Promise<'approve' | 'reject' | 'revise' | 'rewrite'>
          },
          onProgress: (event) => emitter.progress(event),
          signal: request.raw.socket ? undefined : undefined,
        })
        emitter.result(result)
      } catch (err) {
        emitter.error(String(err))
      } finally {
        clearInterval(heartbeat)
        reply.raw.end()
      }
    },
  })
```

- [ ] **步骤 3：novel-routes.ts 新增群聊设置 API**

在群聊端点之后，新增设置 GET/PUT 端点：

```typescript
  // GET /discussion-settings — 获取群聊设置
  routes.push({
    method: 'GET',
    path: '/discussion-settings',
    handler: async (request: any) => {
      const settings = services.discussionSettingsStore.get()
      return success(settings, request.traceId)
    },
  })

  // PUT /discussion-settings — 更新群聊设置
  const discussionSettingsSchema = z.object({
    moderatorModel: z.object({
      provider: z.string(),
      modelId: z.string(),
    }).optional(),
    maxRounds: z.number().int().min(5).max(50).optional(),
    maxRoundsPerScene: z.number().int().min(3).max(20).optional(),
    characterTemperature: z.number().min(0).max(2).optional(),
  })

  routes.push({
    method: 'PUT',
    path: '/discussion-settings',
    handler: async (request: any, reply: any) => {
      const input = validateBody(discussionSettingsSchema, request, reply)
      if (!input) return reply
      services.discussionSettingsStore.update(input)
      const updated = services.discussionSettingsStore.get()
      return success(updated, request.traceId)
    },
  })
```

- [ ] **步骤 4：运行测试确保无回归**

运行：`cd apps/agent-server && npx vitest run src/__tests__/novel-routes.test.ts`
预期：PASS（现有测试不受影响）

- [ ] **步骤 5：Commit**

```bash
git add apps/agent-server/src/plugins/novel-plugin/novel-services.ts apps/agent-server/src/plugins/novel-plugin/novel-routes.ts
git commit -m "feat(discussion): 接线 NovelServices + /create-discussion SSE 端点 + 设置 API"
```

---

## 任务 9：前端创作模式切换

**文件：**
- 修改：`apps/desktop/src/renderer/src/hooks/use-novel-creation-flow.ts`
- 修改：`apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx`

- [ ] **步骤 1：use-novel-creation-flow.ts 新增 startDiscussion**

在 [use-novel-creation-flow.ts](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/hooks/use-novel-creation-flow.ts) 中，在 `startCreation` 方法之后新增 `startDiscussion` 方法。此方法与 `startCreation` 结构完全一致，只是 URL 改为 `/create-discussion`：

```typescript
  const startDiscussion = useCallback(
    async (projectId: string, chapterNumber: number, options?: { arrangedEntities?: ArrangedEntity }): Promise<void> => {
      // 并发保护
      if (abortControllerRef.current) return

      // 重置状态（与 startCreation 一致）
      setPhase('idle')
      setEvents([])
      setCurrentCheckpoint(null)
      setResult(null)
      setError(null)
      setChapterContent('')
      setAgentOutputs([])
      setUserMessages([])
      messageAgentMapRef.current.clear()
      writerContentRef.current = ''
      deltaBufferRef.current.clear()
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
      setIsRunning(true)
      projectIdRef.current = projectId

      const controller = new AbortController()
      abortControllerRef.current = controller

      const url = `${browserConfig.apiBaseUrl}/api/plugins/novel/projects/${projectId}/chapters/${chapterNumber}/create-discussion`
      const body = options?.arrangedEntities ? { arrangedEntities: options.arrangedEntities } : {}

      try {
        await runFlow(url, body, controller)
      } finally {
        abortControllerRef.current = null
      }
    },
    [runFlow],
  )
```

在 return 语句中添加 `startDiscussion`。

- [ ] **步骤 2：novel-workspace.tsx 创作按钮加模式切换**

在 [novel-workspace.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx) 中：

1. 在组件顶部添加状态：
```typescript
const [creationMode2, setCreationMode2] = useState<'workflow' | 'discussion'>('workflow')
```

2. 修改 `handleStartCreation`，在 `mode === 'manual'` 分支中根据 `creationMode2` 选择调用 `creationFlow.startCreation` 还是 `creationFlow.startDiscussion`：
```typescript
if (mode === 'manual') {
  if (creationMode2 === 'discussion') {
    await creationFlow.startDiscussion(currentProjectId, playhead, { arrangedEntities: collectArrangedEntities(playhead) })
  } else {
    await creationFlow.startCreation(currentProjectId, playhead, { arrangedEntities: collectArrangedEntities(playhead) })
  }
}
```

3. 在创作按钮 UI 旁加一个分段控件（具体位置在现有"手动编排"/"AI编排"选择处附近）：
```tsx
<div className="flex items-center gap-2">
  <Button
    variant={creationMode2 === 'workflow' ? 'default' : 'outline'}
    size="sm"
    onClick={() => setCreationMode2('workflow')}
  >
    编排模式
  </Button>
  <Button
    variant={creationMode2 === 'discussion' ? 'default' : 'outline'}
    size="sm"
    onClick={() => setCreationMode2('discussion')}
  >
    群聊模式
  </Button>
</div>
```

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-novel-creation-flow.ts apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx
git commit -m "feat(discussion): 前端创作模式切换（编排/群聊）"
```

---

## 任务 10：前端设置页 Moderator 模型配置

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/settings/agent-page.tsx`
- 修改：`apps/desktop/src/renderer/src/api/novel-client.ts`（或 `http-client.ts`）

- [ ] **步骤 1：新增群聊设置 API client**

在 novel-client.ts 或 http-client.ts 中新增群聊设置的 API 调用函数：

```typescript
/** 群聊设置 */
export interface DiscussionSettings {
  moderatorModel?: { provider: string; modelId: string }
  maxRounds?: number
  maxRoundsPerScene?: number
  characterTemperature?: number
}

export async function getDiscussionSettings(): Promise<DiscussionSettings> {
  const res = await fetch(`${browserConfig.apiBaseUrl}/api/plugins/novel/discussion-settings`)
  const json = await res.json()
  return json.data
}

export async function updateDiscussionSettings(settings: Partial<DiscussionSettings>): Promise<DiscussionSettings> {
  const res = await fetch(`${browserConfig.apiBaseUrl}/api/plugins/novel/discussion-settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  })
  const json = await res.json()
  return json.data
}
```

- [ ] **步骤 2：agent-page.tsx 新增"群聊设置"区块**

在 [agent-page.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/settings/agent-page.tsx) 中，在现有 Agent 配置区块之后新增"群聊设置"区块。使用 `/api/providers` 获取 provider + model 列表填充下拉框：

```tsx
{/* 群聊设置 */}
<div className="rounded-lg border p-4 space-y-4">
  <h3 className="text-lg font-semibold">群聊模式设置</h3>

  {/* Moderator 模型 */}
  <div className="space-y-2">
    <Label>Moderator 模型（决策器，建议用便宜的小模型）</Label>
    <div className="flex gap-2">
      <select
        value={discussionSettings.moderatorModel?.provider ?? ''}
        onChange={(e) => setDiscussionSettings({
          ...discussionSettings,
          moderatorModel: { provider: e.target.value, modelId: discussionSettings.moderatorModel?.modelId ?? '' },
        })}
        className="border rounded px-2 py-1"
      >
        <option value="">默认（最便宜）</option>
        {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <select
        value={discussionSettings.moderatorModel?.modelId ?? ''}
        onChange={(e) => setDiscussionSettings({
          ...discussionSettings,
          moderatorModel: { provider: discussionSettings.moderatorModel?.provider ?? '', modelId: e.target.value },
        })}
        className="border rounded px-2 py-1"
        disabled={!discussionSettings.moderatorModel?.provider}
      >
        <option value="">选择模型</option>
        {selectedProviderModels.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
    </div>
  </div>

  {/* 最大轮数 */}
  <div className="space-y-2">
    <Label>最大轮数（默认 20）</Label>
    <Input
      type="number"
      min={5}
      max={50}
      value={discussionSettings.maxRounds ?? 20}
      onChange={(e) => setDiscussionSettings({ ...discussionSettings, maxRounds: parseInt(e.target.value, 10) })}
    />
  </div>

  <Button onClick={handleSaveDiscussionSettings}>
    <SaveIcon className="size-4 mr-1" /> 保存群聊设置
  </Button>
</div>
```

需要在组件中添加相应的 state 和 handler：

```typescript
const [discussionSettings, setDiscussionSettings] = useState<DiscussionSettings>({})
const [providers, setProviders] = useState<ProviderInfo[]>([])

// 加载 providers + discussion settings
useEffect(() => {
  getProviders().then(setProviders)
  getDiscussionSettings().then(setDiscussionSettings)
}, [])

const selectedProviderModels = providers.find(p => p.id === discussionSettings.moderatorModel?.provider)?.models ?? []

const handleSaveDiscussionSettings = async () => {
  await updateDiscussionSettings(discussionSettings)
  // toast 成功
}
```

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/renderer/src/components/settings/agent-page.tsx apps/desktop/src/renderer/src/api/novel-client.ts
git commit -m "feat(discussion): 设置页新增 Moderator 模型配置"
```

---

## 自检结果

### 1. 规格覆盖度

| 规格章节 | 覆盖任务 | 状态 |
|---------|---------|------|
| 三、核心类型定义 | 任务 1 | ✅ |
| 四.1 TeamDiscussionEngine | 任务 3 | ✅ |
| 四.2 Moderator | 任务 2 | ✅ |
| 四.3 ChapterFinalizer | 任务 4 | ✅ |
| 四.4 NovelDiscussionRunner | 任务 6 | ✅ |
| 四.5 角色剧本格式 | 任务 5（prompt）+ 任务 6（buildCharacterPrompt） | ✅ |
| 四.6 场景拆分与解析 | 任务 3（parseScenes） | ✅ |
| 五.1 设置页 | 任务 10 | ✅ |
| 五.2 默认值 | 任务 7（DEFAULTS） | ✅ |
| 六.1 前端模式切换 | 任务 9 | ✅ |
| 六.2 群聊记录展示 | 任务 9（复用现有 SSE） | ✅ 基础展示 |
| 七、完整数据流 | 任务 8（端点）+ 任务 6（runner） | ✅ |
| 八、错误处理 | 任务 2（Moderator 降级）+ 任务 3（死锁防护） | ✅ |
| 九、测试策略 | 任务 2/3/4/6 各有测试 | ✅ |
| 十、实施路线图 Phase 1-4 | 任务 1-10 | ✅ |
| Phase 5 打磨 | 未包含（后续迭代） | ⏭️ |

### 2. 占位符扫描

- 任务 4 ChapterFinalizer 的 `finalize()` 方法标注了"需从 NovelOrchestrator 迁移"——这不是占位符，是明确的迁移指令（源文件 + 行号 + 方法清单都给了）。但 `throw new Error('尚未实现')` 需要执行者完成迁移后删除。已在步骤说明中明确了要迁移的 10 个方法和它们的源行号。
- 所有其他任务的代码步骤都包含完整代码，无占位符。

### 3. 类型一致性

- `DiscussionMember.id`：工种用 `NOVEL_AGENT_CONFIGS[agentType].id`（即 `'novel-director'` 等），角色用 `'char-${char.id}'` —— 任务 3 的 `parseScenes` 和 `filterMembersByScene` 都用这个格式。✅
- `ModeratorDecision` 类型在任务 1 定义，任务 2 的 `parseDecision` 返回值和任务 3 的 `handleDecision` 参数都使用此类型。✅
- `DiscussionOptions` 在任务 1 定义，任务 3/6/8 都使用相同的 `emit/onCheckpoint/onProgress/signal/moderatorModel` 字段。✅
- `SceneDefinition.presentCharacters` 存储的是 `member.id` 格式（`'char-xxx'`），`filterMembersByScene` 用 `scene.presentCharacters.includes(m.id)` 匹配。✅
- `NovelDiscussionRunner` 构造函数参数在任务 6 定义，任务 8 的 `createNovelServices` 接线时传入的参数顺序和类型一致。✅

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-07-10-team-discussion-mode.md`。两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

选哪种方式？
