/**
 * 结构化提交工具（方案 D）：apply_revision / narrative_task / scene_plan / review。
 * 闭包捕获式提交，参数结构由 schema 约束。从 novel-tools.ts 拆出。
 */

// 导入头：从原 novel-tools.ts 拆出时带入
import { Type } from 'typebox'
import { defineTool, type ToolDefinition, type AgentToolResult } from '@earendil-works/pi-coding-agent'
import type { CharacterTurn, SubmittedSceneInput } from '../discussion/engine/discussion-types.js'
import type {
  NarrativeTask,
  ChapterPositioning,
  NovelChapterReview
} from '@repo/shared/novel'

export interface RevisionDraftHolder {
  /** 当前正文状态。工具每次调用会更新此字段，多次调用累积修改。 */
  content: string
  /** 已应用的修订记录，供 orchestrator 判断是否真的修改过。 */
  appliedPatches: Array<{ from: string; to: string; success: boolean; reason?: string }>
}

const ApplyRevisionParams = Type.Object({
  pairs: Type.Array(Type.Object({
    from: Type.String({
      minLength: 1,
      description: '需要替换的原文片段。必须从章节正文中逐字复制（含标点和换行），工具据此做精确匹配定位。',
    }),
    to: Type.String({
      description: '替换后的文字。可为空字符串表示删除该片段。',
    }),
  }), { minItems: 1, description: '一组或多组"原文/修改后"配对，工具会按顺序依次应用' }),
})

/**
 * 创建 novel_apply_revision 工具
 *
 * ⚠️ 此工具不进入全局 createNovelTools 列表，而是由 orchestrator 在调用 Reviser 时
 * 通过 runAgent 的 extraTools 参数动态注入。理由：
 * 1. 工具通过闭包引用 draft 对象，draft 在每次 Reviser 调用时重新创建
 * 2. 其他 Agent（Director/Writer/Reviewer/Memory）不应看到此工具，避免误用
 * 3. 工具不在 STATIC 层 schema 中出现，不影响跨 Agent 的 prompt cache 命中率
 */

export function createNovelApplyRevisionTool(draft: RevisionDraftHolder): ToolDefinition<typeof ApplyRevisionParams> {
  return defineTool({
    name: 'novel_apply_revision',
    label: '应用修订',
    description:
      '对章节正文做精确字符串替换。通过 pairs 参数传入一组或多组"原文片段/修改后片段"配对，' +
      '工具会按顺序在当前章节正文中查找 from 片段并替换为 to。' +
      'from 片段必须从章节正文中逐字复制（含标点和换行），否则无法定位。' +
      '可多次调用此工具，每次调用都在上一次的结果上继续修改。' +
      '不要在对话文本中输出"原文/修改后"配对，那不会被系统识别，必须调用此工具。',
    promptSnippet: '对章节正文应用精确修订（原文→修改后）',
    parameters: ApplyRevisionParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const results: Array<{ success: boolean; reason?: string; preview: string }> = []
      let appliedCount = 0

      for (const pair of params.pairs) {
        if (draft.content.includes(pair.from)) {
          draft.content = draft.content.replace(pair.from, pair.to)
          draft.appliedPatches.push({ ...pair, success: true })
          appliedCount++
          results.push({
            success: true,
            preview: pair.to.length > 30 ? pair.to.slice(0, 30) + '...' : pair.to,
          })
        } else {
          draft.appliedPatches.push({ ...pair, success: false, reason: '原文片段未在章节中找到' })
          results.push({
            success: false,
            reason: '原文片段未在章节中找到',
            preview: pair.from.length > 30 ? pair.from.slice(0, 30) + '...' : pair.from,
          })
        }
      }

      const summary = `已应用 ${appliedCount}/${params.pairs.length} 个修订。\n` +
        results.map((r, i) => {
          const mark = r.success ? '✓' : '✗'
          const detail = r.success ? `已替换为"${r.preview}"` : `${r.reason}："${r.preview}"`
          return `${mark} ${i + 1}. ${detail}`
        }).join('\n')

      return {
        content: [{ type: 'text', text: summary }],
        details: undefined,
      }
    },
  })
}

/**
 * 叙事任务草稿持有者
 *
 * 由 orchestrator 在调用 Director 前创建，通过闭包传递给 novel_submit_narrative_task 工具。
 * Director 调用工具提交结构化任务对象，工具内部把对象存入 draft.task。
 * Director 结束后，orchestrator 读取 draft.task 作为 NarrativeTask，完全绕开正则解析。
 *
 * 设计动机：
 * 旧方案让 Director 输出 Markdown 自由文本，再用 parseDirectorTask 用 18 处正则提取字段。
 * LLM 不严格遵守格式时正则解析失败，降级到默认值，Director 的真实意图丢失。
 * 新方案通过工具协议化输入：LLM 必须按 schema 提交结构化对象，工具参数 schema 强制校验。
 */

export interface NarrativeTaskDraftHolder {
  /** Director 提交的叙事任务对象。undefined 表示 Director 未调用工具。 */
  task?: NarrativeTask
  /** Director 的原始自然语言输出（推理过程等），用于审计和回退展示。 */
  rawOutput?: string
}

const NarrativeTaskTypeEnum = Type.Union([
  Type.Literal('advance_mainline'),
  Type.Literal('advance_subline'),
  Type.Literal('create_conflict'),
  Type.Literal('escalate_conflict'),
  Type.Literal('release_info'),
  Type.Literal('hide_info'),
  Type.Literal('reinforce_foreshadow'),
  Type.Literal('recover_foreshadow'),
  Type.Literal('change_relationship'),
  Type.Literal('change_cognition'),
  Type.Literal('create_reversal'),
  Type.Literal('create_suspense'),
  Type.Literal('phase_closure'),
  Type.Literal('introduce_problem'),
])

const ChapterEndingHookTypeEnum = Type.Union([
  Type.Literal('suspense'),
  Type.Literal('reversal'),
  Type.Literal('emotional'),
  Type.Literal('action'),
  Type.Literal('none'),
])

const ChapterPositioningEnum = Type.Union([
  Type.Literal('high_pressure'),
  Type.Literal('advancement'),
  Type.Literal('cultivation'),
  Type.Literal('relationship'),
  Type.Literal('low_pressure'),
  Type.Literal('information'),
])

const SubmitNarrativeTaskParams = Type.Object({
  taskType: NarrativeTaskTypeEnum,
  priority: Type.Union([Type.Literal('high'), Type.Literal('medium'), Type.Literal('low')]),
  narrativeTask: Type.String({
    minLength: 10,
    maxLength: 800,
    description: '给 Writer 看的完整叙事任务文本，按场景分段并标注每场核心/过场（核心场景合计占一半以上笔墨）。包含本章核心目标、情节点、约束说明等，Writer 会基于此创作正文。',
  }),
  secondaryTasks: Type.Array(NarrativeTaskTypeEnum, {
    maxItems: 2,
    description: '次要任务类型（最多 2 个，允许一章兼顾多个任务）。无次要任务时传空数组。',
  }),
  requiredReferences: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
    maxItems: 8,
    description: 'Writer 额外需要的现有故事实体 ID 或精确名称（最多 8 个）。无额外引用时传空数组。',
  }),
  chapterEndingHook: Type.Object({
    type: ChapterEndingHookTypeEnum,
    description: Type.String({ description: '章尾钩子的完整描述文本（用于创建钩子实体）' }),
  }),
  povCharacters: Type.Array(Type.String(), {
    minItems: 1,
    description: '本章 POV 角色名列表（至少 1 个），Writer 必须严格使用这些角色的视角',
  }),
  sceneCount: Type.Integer({ minimum: 1, maximum: 5, description: '本章场景数（1=单场景写透，2-3=多场景快推）' }),
  positioning: ChapterPositioningEnum,
  timelineOffset: Type.Object({
    days: Type.Integer({
      description: '相对第 1 章的天数偏移。第 1 章 = 0，+3 表示 3 天后，-2 表示 2 天前',
    }),
    description: Type.String({ description: '原始时间线描述（如"3 天后"、"同日"）' }),
  }),
  suspenseDuration: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 10,
    description: '悬念持续章数（仅 taskType=create_suspense 时必填，默认 3 章）',
  })),
  intensityDelta: Type.Optional(Type.Integer({
    minimum: -10,
    maximum: 10,
    description: '预期冲突强度变化（仅 taskType=escalate_conflict 时必填，如 +5 表示强度提升 5）',
  })),
})

/**
 * 创建 novel_submit_narrative_task 工具
 *
 * ⚠️ 此工具不进入全局 createNovelTools 列表，而是由 orchestrator 在调用 Director 时
 * 通过 runAgent 的 extraTools 参数动态注入。理由：
 * 1. 工具通过闭包引用 draft 对象，draft 在每次 Director 调用时重新创建
 * 2. 其他 Agent 不应看到此工具，避免误用
 * 3. 工具不在 STATIC 层 schema 中出现，不影响跨 Agent 的 prompt cache 命中率
 */

export function createNovelSubmitNarrativeTaskTool(
  draft: NarrativeTaskDraftHolder,
): ToolDefinition<typeof SubmitNarrativeTaskParams> {
  return defineTool({
    name: 'novel_submit_narrative_task',
    label: '提交叙事任务',
    description:
      '提交本章的结构化叙事任务。Director 必须调用此工具来提交叙事任务，不要在对话文本中输出 Markdown 格式的任务文档。' +
      '工具参数 schema 强制结构化，所有字段必须按 schema 提交。' +
      '可在对话文本中输出推理过程和规划思路，但结构化任务对象必须通过此工具提交。',
    promptSnippet: '提交结构化叙事任务（任务类型/优先级/POV/钩子/时间线等）',
    parameters: SubmitNarrativeTaskParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      // 防御式字数闸（宽松 provider 直连时 schema maxLength 可能不生效）：
      // 任务文本超限=一章塞了整条事件链，Writer 只能平均用力导致主次不分+惯性超写。
      // 不写 draft，返回纠正提示让模型精简后重调。
      if (params.narrativeTask.length > 800) {
        return {
          content: [{
            type: 'text',
            text: `narrativeTask 过长（${params.narrativeTask.length} 字，硬上限 800 字）：一章装不下整条事件链。` +
              '请只保留不超过 3 个核心事件，按场景分段（标注核心/过场），过场用一句话带过，精简后重新提交；装不下就在任务里指出并建议拆章。'
          }],
          details: undefined,
        }
      }
      const task: NarrativeTask = {
        // 字面 \n 归一：模型偶发把 JSON 转义残留在字符串值里（\n\n【场景一：…），
        // 原样落库会让 Writer 看到一整段无换行的文字墙（实测一章 16 处）。
        description: params.narrativeTask.includes('\\n')
          ? params.narrativeTask
              .replace(/\\r\\n/g, '\n')
              .replace(/\\n/g, '\n')
              .replace(/\n{3,}/g, '\n\n')
              .trim()
          : params.narrativeTask,
        type: params.taskType,
        targetEntity: null,
        priority: params.priority,
      }

      if (params.secondaryTasks && params.secondaryTasks.length > 0) {
        // 过滤掉与主任务相同的次要任务
        task.secondaryTasks = params.secondaryTasks.filter(t => t !== params.taskType)
      }

      const requiredReferences = [...new Set(params.requiredReferences.map((value) => value.trim()))]
        .filter(Boolean)
        .slice(0, 8)
      if (requiredReferences.length > 0) task.requiredReferences = requiredReferences

      if (params.chapterEndingHook) {
        task.chapterEndingHook = params.chapterEndingHook.type
        task.chapterEndingHookDescription = params.chapterEndingHook.description.slice(0, 200)
      }

      if (params.povCharacters && params.povCharacters.length > 0) {
        task.povCharacters = params.povCharacters.filter(Boolean)
      }

      if (params.sceneCount) {
        task.sceneCount = params.sceneCount
      }

      if (params.positioning) {
        task.positioning = params.positioning as ChapterPositioning
      }

      if (params.timelineOffset) {
        task.timeOffset = params.timelineOffset.days
      }

      // 悬念持续章数（仅 create_suspense 任务）
      if (params.taskType === 'create_suspense' && params.suspenseDuration !== undefined) {
        task.suspenseDuration = params.suspenseDuration
      }

      // 冲突强度变化（仅 escalate_conflict 任务）
      if (params.taskType === 'escalate_conflict' && params.intensityDelta !== undefined) {
        task.expectedIntensityDelta = params.intensityDelta
      }

      draft.task = task

      const summary = `叙事任务已提交：\n` +
        `- 任务类型：${task.type}\n` +
        `- 优先级：${task.priority}\n` +
        `- POV 角色：${task.povCharacters?.join('、') ?? '（未指定）'}\n` +
        `- 场景数：${task.sceneCount ?? '（未指定）'}\n` +
        `- 章节定位：${task.positioning ?? '（未指定）'}\n` +
        `- 章尾钩子：${task.chapterEndingHook ?? '（未指定）'}\n` +
        `- 时间线偏移：${task.timeOffset ?? 0} 天\n` +
        (task.secondaryTasks?.length ? `- 次要任务：${task.secondaryTasks.join('、')}\n` : '')

      return {
        content: [{ type: 'text', text: summary }],
        details: undefined,
      }
    },
  })
}

/**
 * 群聊场景计划草稿持有者
 *
 * 由 novel-discussion-runner 在规划阶段前创建，通过闭包传递给 novel_submit_scene_plan 工具。
 * Director 调用工具提交结构化场景计划，工具内部把对象存入 draft.plan。
 * 引擎在 converge(chapter) 后优先读取 draft.plan；Markdown 解析只作回退。
 *
 * 设计动机（2026-08-24 群聊演绎链路修复）：
 * 旧路径让 Director 输出 Markdown 场景拆分，引擎用正则解析 `### 场景N` 与 `- 字段：` 行。
 * 实测 Director 输出中文数字（场景一）/Markdown 表格字段变体时解析全部失败，
 * scenes=[] 导致整章静默跳过角色演出、Writer 盲写（run b616f15f 第4章）。
 * 与 novel_submit_narrative_task / novel_submit_review 同构：schema 强制结构化，绕开文本解析。
 */

export interface ScenePlanDraftHolder {
  /** Director 提交的场景计划（未调用工具时为 undefined） */
  plan?: { scenes: SubmittedSceneInput[] }
}

export interface ScenePlanToolOptions {
  /** 新运行强制 Director 安排动作节点；旧测试/旧快照保持兼容。 */
  requireActionBeats?: boolean
}

const SceneActionBeatParams = Type.Object({
  beatId: Type.String({ minLength: 1, maxLength: 80, description: '动作节点 ID，场景内唯一' }),
  actor: Type.String({ minLength: 1, maxLength: 40, description: '先行动角色名，必须在本场在场角色中' }),
  target: Type.Optional(Type.String({ maxLength: 40, description: '行动针对的角色名，无明确对象可省略' })),
  pressure: Type.String({ minLength: 2, maxLength: 300, description: '当前具体阻力，不能只写推进剧情' }),
  action: Type.String({ minLength: 2, maxLength: 400, description: '角色采取的具体可演行动' }),
  choice: Type.String({ minLength: 2, maxLength: 300, description: '角色必须面对的选择边界' }),
  consequence: Type.String({ minLength: 2, maxLength: 400, description: '行动造成的即时后果' }),
  nextActor: Type.Optional(Type.String({ maxLength: 40, description: '默认下一回应角色名' })),
  exitCondition: Type.String({ minLength: 2, maxLength: 300, description: '节点完成或允许跳过的条件' }),
})

const SubmitScenePlanParams = Type.Object({
  scenes: Type.Array(
    Type.Object({
      title: Type.String({ minLength: 1, maxLength: 60, description: '场景标题' }),
      location: Type.String({ minLength: 1, maxLength: 100, description: '场景发生地点' }),
      time: Type.String({ minLength: 1, maxLength: 60, description: '时间点' }),
      conflict: Type.Optional(Type.String({ maxLength: 300, description: '本场景核心冲突，无则省略' })),
      goal: Type.String({ minLength: 2, maxLength: 500, description: '本场景必须完成的推进' }),
      emotion: Type.Optional(Type.String({ maxLength: 120, description: '情绪走向（如"从警惕转向震惊"）' })),
      presentCharacters: Type.Array(Type.String({ minLength: 1, maxLength: 40 }), {
        minItems: 0,
        maxItems: 8,
        description: '在场角色名列表，必须与项目角色档案名完全一致；纯过渡场景可为空数组',
      }),
      actionBeats: Type.Optional(Type.Array(SceneActionBeatParams, {
        minItems: 0,
        maxItems: 8,
        description: '按演出顺序排列的戏剧动作节点；非过渡场景必须填写，至少包含压力/行动/选择/后果',
      })),
    }),
    { minItems: 1, maxItems: 5, description: '本章场景列表，按演出顺序排列' },
  ),
})

/**
 * 创建 novel_submit_scene_plan 工具
 *
 * ⚠️ 此工具不进入全局 createNovelTools 列表，而是由 discussion runner 在规划阶段
 * 通过 buildScenePlanToolset 动态注入。理由与 narrative_task/review 工具一致：
 * 闭包绑定 draft、其他成员不可见、不污染 STATIC 层 schema 的跨 Agent 缓存。
 */

export function createNovelSubmitScenePlanTool(
  draft: ScenePlanDraftHolder,
  options: ScenePlanToolOptions = {},
): ToolDefinition<typeof SubmitScenePlanParams> {
  // 旧快照允许没有 actionBeats；新群聊运行必须把戏肉提交为动作图。
  // TypeBox schema 在运行时按工厂参数切换，避免把历史快照和新协议混成一套。
  const parameters = options.requireActionBeats
    ? Type.Object({
        scenes: Type.Array(
          Type.Object({
            title: Type.String({ minLength: 1, maxLength: 60, description: '场景标题' }),
            location: Type.String({ minLength: 1, maxLength: 100, description: '场景发生地点' }),
            time: Type.String({ minLength: 1, maxLength: 60, description: '时间点' }),
            conflict: Type.Optional(Type.String({ maxLength: 300, description: '本场景核心冲突，无则省略' })),
            goal: Type.String({ minLength: 2, maxLength: 500, description: '本场景必须完成的推进' }),
            emotion: Type.Optional(Type.String({ maxLength: 120, description: '情绪走向' })),
            presentCharacters: Type.Array(Type.String({ minLength: 1, maxLength: 40 }), {
              minItems: 1,
              maxItems: 8,
              description: '在场角色名列表，必须与角色档案完全一致',
            }),
            actionBeats: Type.Array(SceneActionBeatParams, {
              minItems: 1,
              maxItems: 8,
              description: '按因果顺序排列的戏剧动作节点；不能只提交角色名单',
            }),
          }),
          { minItems: 1, maxItems: 5, description: '本章场景列表，按演出顺序排列' },
        ),
      })
    : SubmitScenePlanParams
  return defineTool({
    name: 'novel_submit_scene_plan',
    label: '提交场景计划',
    description:
      '提交本章群聊共创的结构化场景计划。Director 必须调用此工具提交场景拆分，不要只在对话文本中输出 Markdown 表格或章节概述。' +
      '每个场景包含标题/地点/时间/冲突/目标/情绪/在场角色和按顺序排列的动作节点；' +
      '动作节点必须写清角色、阻力、行动、选择、后果和下一回应角色，在场角色名必须与项目角色档案完全一致。',
    promptSnippet: '提交结构化场景计划（场景契约 + 角色戏份 + 冲突动作链）',
    parameters,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      if (options.requireActionBeats && params.scenes.some(scene => !scene.actionBeats || scene.actionBeats.length === 0)) {
        return {
          content: [{
            type: 'text',
            text: '提交失败：每个非纯过渡场景必须包含 actionBeats。请为每个场景安排角色、阻力、行动、选择、后果和下一回应角色后重新提交。',
          }],
          details: undefined,
        }
      }
      const scenes: SubmittedSceneInput[] = params.scenes.map(scene => ({
        title: scene.title.trim(),
        location: scene.location.trim(),
        time: scene.time.trim(),
        ...(scene.conflict?.trim() ? { conflict: scene.conflict.trim() } : {}),
        goal: scene.goal.trim(),
        ...(scene.emotion?.trim() ? { emotion: scene.emotion.trim() } : {}),
        presentCharacters: scene.presentCharacters.map(name => name.trim()).filter(Boolean),
        actionBeats: (scene.actionBeats ?? []).map(beat => ({
          beatId: beat.beatId.trim(),
          actor: beat.actor.trim(),
          ...(beat.target?.trim() ? { target: beat.target.trim() } : {}),
          pressure: beat.pressure.trim(),
          action: beat.action.trim(),
          choice: beat.choice.trim(),
          consequence: beat.consequence.trim(),
          ...(beat.nextActor?.trim() ? { nextActor: beat.nextActor.trim() } : {}),
          exitCondition: beat.exitCondition.trim(),
        })),
      }))
      for (const scene of scenes) {
        const beatIds = scene.actionBeats?.map(beat => beat.beatId) ?? []
        if (new Set(beatIds).size !== beatIds.length) {
          return {
            content: [{ type: 'text', text: `提交失败：场景「${scene.title}」的 actionBeats.beatId 必须唯一，请修正后重新提交。` }],
            details: undefined,
          }
        }
      }
      draft.plan = { scenes }
      const summary = `场景计划已提交：共 ${scenes.length} 个场景。\n` +
        scenes.map((s, i) => `${i + 1}. ${s.title}（在场：${s.presentCharacters.join('、') || '未指定'}）`).join('\n')
      return {
        content: [{ type: 'text', text: summary }],
        details: undefined,
      }
    },
  })
}

/** 角色结构化演出回合草稿持有者。 */
export interface CharacterTurnDraftHolder {
  turn?: CharacterTurn
}

const CharacterTurnProgress = Type.Union([
  Type.Literal('advance'),
  Type.Literal('escalate'),
  Type.Literal('retreat'),
  Type.Literal('reveal'),
  Type.Literal('stall'),
])

const SubmitCharacterTurnParams = Type.Object({
  publicText: Type.String({ minLength: 1, maxLength: 2400, description: '公开演出：动作、现场反应和台词' }),
  innerThought: Type.String({ maxLength: 1200, description: '角色此刻的判断/顾虑/误判，只给用户和 Writer' }),
  conflictReading: Type.String({ maxLength: 800, description: '角色如何理解当前阻力，只给用户和 Writer' }),
  responsePlan: Type.String({ maxLength: 800, description: '角色准备采取的应对，不代表一定成功，只给用户和 Writer' }),
  consequence: Type.String({ minLength: 1, maxLength: 800, description: '本次行动造成的即时后果' }),
  progress: CharacterTurnProgress,
  mentionNames: Type.Array(Type.String({ minLength: 1, maxLength: 40 }), {
    maxItems: 3,
    description: '主动请求当前场景内角色回应的姓名列表；不需要回应时为空数组',
  }),
  replyToMessageId: Type.Optional(Type.String({ maxLength: 120, description: '因果回应的上一条角色消息 ID' })),
})

export function createNovelSubmitCharacterTurnTool(
  draft: CharacterTurnDraftHolder,
  expectedActionBeatId?: string,
): ToolDefinition<typeof SubmitCharacterTurnParams> {
  return defineTool({
    name: 'novel_submit_character_turn',
    label: '提交角色演出回合',
    description:
      '提交当前角色一个完整的戏剧动作单元。publicText 是公开可见的演出，' +
      'innerThought/conflictReading/responsePlan 只给用户和 Writer，mentionNames 用于请求同场角色回应。' +
      '必须只演当前角色，不替其他角色决定结果。',
    promptSnippet: '提交角色演出（公开动作台词 + 私有判断 + 应对 + 后果 + 下一回应）',
    parameters: SubmitCharacterTurnParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      draft.turn = {
        ...(expectedActionBeatId ? { actionBeatId: expectedActionBeatId } : {}),
        publicText: params.publicText.trim(),
        innerThought: params.innerThought.trim(),
        conflictReading: params.conflictReading.trim(),
        responsePlan: params.responsePlan.trim(),
        consequence: params.consequence.trim(),
        progress: params.progress,
        mentionNames: params.mentionNames.map(name => name.trim()).filter(Boolean),
        ...(params.replyToMessageId?.trim() ? { replyToMessageId: params.replyToMessageId.trim() } : {}),
      }
      return {
        content: [{ type: 'text', text: '角色演出回合已提交。' }],
        details: undefined,
      }
    },
  })
}

/**
 * 章节验收草稿持有者
 *
 * 由 orchestrator 在调用 Reviewer 前创建，通过闭包传递给 novel_submit_review 工具。
 * Reviewer 调用工具提交结构化验收对象，工具内部把对象存入 draft.review。
 * Reviewer 结束后，orchestrator 读取 draft.review 作为 NovelChapterReview 的核心字段，
 * 完全绕开正则解析。
 *
 * 设计动机：
 * 旧方案让 Reviewer 输出 Markdown 报告（十维评分表 + Findings 表格 + 结论），
 * 再由 parseChapterReviewReport 用正则提取 11 个评分 + verdict + issues + suggestions。
 * LLM 不严格遵守格式时正则解析失败，评分/结论降级为 null，Reviewer 的真实判断丢失。
 * 新方案通过工具协议化输入：LLM 必须按 schema 提交结构化对象，工具参数 schema 强制校验。
 */

export interface ReviewDraftHolder {
  /** Reviewer 提交的验收对象（不含 id/projectId/chapterId/reviewedBy/createdAt，这些由 saveReview 填充）。 */
  review?: Omit<NovelChapterReview, 'id' | 'projectId' | 'chapterId' | 'reviewedBy' | 'createdAt' | 'contentRevisionId' | 'contentHash'>
  /** Reviewer 的原始自然语言输出（推理过程等），用于审计和回退展示。 */
  rawOutput?: string
  styleTechniqueChecks?: Array<{
    expertId: string
    expertName: string
    techniqueId: string
    techniqueName: string
    dimension: string
    verdict: 'present' | 'absent' | 'not_applicable'
    evidence?: string
    note?: string
  }>
}

const SubmitReviewParams = Type.Object({
  consistencyScore: Type.Optional(Type.Integer({
    minimum: 0,
    maximum: 10,
    description: '一致性评分（0-10）：角色状态/世界规则/时间线是否与既有设定一致',
  })),
  characterScore: Type.Optional(Type.Integer({
    minimum: 0,
    maximum: 10,
    description: '角色评分（0-10）：角色言行是否符合人设、弧光是否推进',
  })),
  taskCompletionScore: Type.Optional(Type.Integer({
    minimum: 0,
    maximum: 10,
    description: '任务完成评分（0-10）：本章叙事任务是否完成',
  })),
  clueProgressScore: Type.Optional(Type.Integer({
    minimum: 0,
    maximum: 10,
    description: '线索推进评分（0-10）：本章线索是否按计划推进',
  })),
  foreshadowStatusScore: Type.Optional(Type.Integer({
    minimum: 0,
    maximum: 10,
    description: '伏笔状态评分（0-10）：本章伏笔的埋设/维持/回收是否合理',
  })),
  conflictChangeScore: Type.Optional(Type.Integer({
    minimum: 0,
    maximum: 10,
    description: '冲突变化评分（0-10）：本章冲突推进是否符合节奏规划',
  })),
  pacingScore: Type.Optional(Type.Integer({
    minimum: 0,
    maximum: 10,
    description: '节奏评分（0-10）：章节节奏是否符合本章节奏建议',
  })),
  infoControlScore: Type.Optional(Type.Integer({
    minimum: 0,
    maximum: 10,
    description: '信息控制评分（0-10）：信息差/视角限制是否维持',
  })),
  readerHookScore: Type.Optional(Type.Integer({
    minimum: 0,
    maximum: 10,
    description: '读者钩子评分（0-10）：章尾钩子是否有效',
  })),
  styleScore: Type.Optional(Type.Integer({
    minimum: 0,
    maximum: 10,
    description: '文风评分（0-10）：是否符合项目文风档案',
  })),
  overallScore: Type.Optional(Type.Number({
    minimum: 0,
    maximum: 10,
    description: '总体评分（0-10，允许小数）：综合评价',
  })),
  verdict: Type.Union([
    Type.Literal('accept'),
    Type.Literal('revise'),
    Type.Literal('reject'),
  ], { description: '验收结论：accept=通过 / revise=需修订 / reject=重写' }),
  issues: Type.Array(Type.Object({
    severity: Type.Union([
      Type.Literal('S1'),
      Type.Literal('S2'),
      Type.Literal('S3'),
      Type.Literal('S4'),
    ], { description: '严重度：S1=致命 / S2=严重 / S3=一般 / S4=轻微' }),
    category: Type.String({ description: '问题分类（如 continuity/character/pacing/style）' }),
    description: Type.String({ description: '问题描述' }),
    location: Type.Optional(Type.String({ description: '问题位置（如"第12段"或引用原文片段）' })),
  }), { description: '发现的问题列表（空数组表示无问题）' }),
  suggestions: Type.Array(Type.String(), {
    description: '修改建议列表（与 issues 一一对应或整体建议，空数组表示无建议）',
  }),
  styleTechniqueChecks: Type.Optional(Type.Array(Type.Object({
    expertId: Type.String(), expertName: Type.String(), techniqueId: Type.String(), techniqueName: Type.String(), dimension: Type.String(),
    verdict: Type.Union([Type.Literal('present'), Type.Literal('absent'), Type.Literal('not_applicable')]),
    evidence: Type.Optional(Type.String()), note: Type.Optional(Type.String()),
  }), { description: '本次召集专家手法卡逐项体现检查：present/absent/not_applicable' })),
})

/**
 * 创建 novel_submit_review 工具
 *
 * ⚠️ 此工具不进入全局 createNovelTools 列表，而是由 orchestrator / discussion runner
 * 在调用 Reviewer 时通过 extraTools 参数动态注入。理由：
 * 1. 工具通过闭包引用 draft 对象，draft 在每次 Reviewer 调用时重新创建
 * 2. 其他 Agent（Director/Writer/Reviser/Memory）不应看到此工具，避免误用
 * 3. 工具不在 STATIC 层 schema 中出现，不影响跨 Agent 的 prompt cache 命中率
 */

export function createNovelSubmitReviewTool(
  draft: ReviewDraftHolder,
): ToolDefinition<typeof SubmitReviewParams> {
  return defineTool({
    name: 'novel_submit_review',
    label: '提交验收报告',
    description:
      '提交本章的结构化验收报告。Reviewer 必须调用此工具来提交十维评分、结论和问题列表，' +
      '不要在对话文本中输出 Markdown 格式的评分表或 Findings 表格。' +
      '工具参数 schema 强制结构化，所有字段必须按 schema 提交。' +
      '可在对话文本中输出推理过程和分析思路，但结构化验收对象必须通过此工具提交。',
    promptSnippet: '提交结构化验收报告（十维评分/结论/问题列表/建议）',
    parameters: SubmitReviewParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const review: Omit<NovelChapterReview, 'id' | 'projectId' | 'chapterId' | 'reviewedBy' | 'createdAt' | 'contentRevisionId' | 'contentHash'> = {
        consistencyScore: params.consistencyScore ?? null,
        characterScore: params.characterScore ?? null,
        taskCompletionScore: params.taskCompletionScore ?? null,
        clueProgressScore: params.clueProgressScore ?? null,
        foreshadowStatusScore: params.foreshadowStatusScore ?? null,
        conflictChangeScore: params.conflictChangeScore ?? null,
        pacingScore: params.pacingScore ?? null,
        infoControlScore: params.infoControlScore ?? null,
        readerHookScore: params.readerHookScore ?? null,
        styleScore: params.styleScore ?? null,
        overallScore: params.overallScore ?? null,
        verdict: params.verdict,
        issues: JSON.stringify(params.issues ?? []),
        suggestions: JSON.stringify(params.suggestions ?? []),
      }

      draft.review = review
      draft.styleTechniqueChecks = params.styleTechniqueChecks ?? []

      const issuesCount = params.issues?.length ?? 0
      const suggestionsCount = params.suggestions?.length ?? 0
      const styleChecks = params.styleTechniqueChecks ?? []
      const styleSummary = styleChecks.length > 0
        ? `\n- 专家手法检查：已体现=${styleChecks.filter((item) => item.verdict === 'present').length}/未体现=${styleChecks.filter((item) => item.verdict === 'absent').length}/不适用=${styleChecks.filter((item) => item.verdict === 'not_applicable').length}`
        : ''
      const summary = `验收报告已提交：\n` +
        `- 结论：${params.verdict}\n` +
        `- 总体评分：${params.overallScore ?? '（未提供）'}\n` +
        `- 十维评分：一致性=${params.consistencyScore ?? '-'}/角色=${params.characterScore ?? '-'}/任务=${params.taskCompletionScore ?? '-'}/线索=${params.clueProgressScore ?? '-'}/伏笔=${params.foreshadowStatusScore ?? '-'}/冲突=${params.conflictChangeScore ?? '-'}/节奏=${params.pacingScore ?? '-'}/信息=${params.infoControlScore ?? '-'}/钩子=${params.readerHookScore ?? '-'}/文风=${params.styleScore ?? '-'}\n` +
        `- 问题数：${issuesCount}\n` +
        `- 建议数：${suggestionsCount}${styleSummary}`

      return {
        content: [{ type: 'text', text: summary }],
        details: undefined,
      }
    },
  })
}

/**
 * 获取所有小说工具
 *
 * 用于注入到 Pi SDK session 的 customTools 参数。
 *
 * @param store 小说状态存储
 * @param memoryStore 可选的事件账本存储。注入后，novel_ask_story 工具在携带 chapterNumber
 *                    时会走账本反推章前状态，避免重写中间章节时读到未来章节的状态倒灌。
 *                    未注入时降级到原有读取 store 最新状态的逻辑。
 */
