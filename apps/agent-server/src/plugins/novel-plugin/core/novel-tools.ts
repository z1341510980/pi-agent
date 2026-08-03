/**
 * 小说创作系统工具定义
 *
 * ── 缓存命中策略（核心设计）──
 *
 * 问题：工具调用后上下文变化，导致 LLM 提供商的 prompt cache 失效。
 *
 * 解决方案：
 *
 * 1. 系统提示词（STATIC）在章节生成期间不可变
 *    - 只包含静态数据（世界规则、风格、Agent 身份），不含角色定义
 *    - 角色定义放在章节上下文（SEMI 层），通过 arrangedEntities 注入本章出场角色
 *    - 工具更新状态 → 不影响系统提示词
 *    - systemPromptOverride 只在 session 创建时调用一次
 *
 * 2. 章节上下文（SEMI）在章节生成期间不可变
 *    - 作为首条 user 消息发送，包含当前故事状态快照
 *    - 工具更新状态 → 不影响已发送的章节上下文
 *    - 状态变更在下一章的章节上下文中体现
 *
 * 3. 工具结果追加到对话末尾（DYNAMIC）
 *    - 读工具：查询数据库最新状态，结果作为 tool message 追加
 *    - 写工具：更新数据库，返回确认信息作为 tool message 追加
 *    - 前缀（系统提示词 + 章节上下文 + 早期消息）保持不变 → 缓存命中
 *
 * 4. 状态更新的延迟生效
 *    - 工具更新角色状态/伏笔/冲突等 → 立即写入数据库
 *    - 但当前章节的系统提示词和章节上下文不会重新生成
 *    - 后续读工具可以读到最新状态（从数据库查询）
 *    - 状态变更在下一章的提示词中体现（新 session → 新系统提示词 + 新章节上下文）
 *
 * ── 缓存层级示意 ──
 *
 * [系统提示词] ← STATIC，跨章节缓存命中
 * [章节上下文]  ← SEMI，单章内缓存命中
 * [用户消息1]  ← DYNAMIC
 * [助手消息1]  ← DYNAMIC
 * [工具调用1]  ← DYNAMIC（追加到末尾，不破坏前缀缓存）
 * [工具结果1]  ← DYNAMIC
 * [助手消息2]  ← DYNAMIC
 * ...
 *
 * LLM 调用时，前缀（系统提示词 + 章节上下文）命中缓存，
 * 只有 DYNAMIC 部分需要重新计算。
 */

import { randomUUID } from 'node:crypto'
import { Type, type Static } from 'typebox'
import { defineTool, type ToolDefinition, type AgentToolResult } from '@earendil-works/pi-coding-agent'
import type { NovelStore } from './novel-store.js'
import type { NovelMemoryStore } from './novel-memory-store.js'
import { isAdmissibleNewForeshadow } from './foreshadow-policy.js'
import type { ChapterBoundaryContext } from './prompt-builder.js'
import type {
  ChapterStoryContext,
  NarrativeTask,
  NarrativeTaskType,
  ChapterEndingHookType,
  ChapterPositioning,
  NovelChapterReview,
} from '@repo/shared/novel'

/**
 * 章前边界查询提供者（统一 Story State Service 接口）
 *
 * 让 novel_query_state / novel_ask_story 工具与 prompt-builder 注入路径共用同一章前语义，
 * 消除"注入走快照/账本，工具查询走活库"的双事实源问题（P0）。
 *
 * NovelPromptBuilder 天然实现该接口（其 getChapterBoundaryContext 为 public 方法），
 * 由 novel-services.ts 在创建工具时注入。
 */
export interface ChapterBoundaryProvider {
  /**
   * 读取第 N 章开篇边界状态。
   *
   * 语义：chapterNumber > 1 且存在 N-1 快照时，返回 N-1 章结束时的实体快照；
   * 否则返回当前活库状态（顺序生成场景）。
   *
   * 工具与注入路径都应调用此方法，确保重写中间章节时读到一致的章前状态。
   */
  getChapterBoundaryContext(projectId: string, chapterNumber: number): ChapterBoundaryContext
}

// ── 工具参数 Schema ──

const QueryStateParams = Type.Object({
  projectId: Type.String({ description: '项目 ID' }),
  queryType: Type.Union([
    Type.Literal('characters'),
    Type.Literal('relationships'),
    Type.Literal('conflicts'),
    Type.Literal('foreshadowing'),
    Type.Literal('clues'),
    Type.Literal('world_rules'),
    Type.Literal('constraints'),
    Type.Literal('info_layers'),
    Type.Literal('style_guide'),
    Type.Literal('all'),
  ], { description: '查询类型' }),
  asOfChapter: Type.Optional(Type.Number({
    description: '章前时点（可选）：返回该章开篇前的状态快照，而非活库最新值。' +
      '重写中间章节时必传，避免读到未来章节已写入的状态倒灌。顺序生成当前章时留空。',
  })),
})

const UpdateCharacterParams = Type.Object({
  characterId: Type.String({ description: '角色 ID' }),
  currentState: Type.Optional(Type.String({ description: '当前状态（情绪/处境）' })),
  currentGoal: Type.Optional(Type.String({ description: '当前目标' })),
  currentPressure: Type.Optional(Type.String({ description: '当前压力' })),
  secret: Type.Optional(Type.String({ description: '秘密' })),
  arcStage: Type.Optional(Type.String({ description: '弧光阶段' })),
})

const UpdateForeshadowParams = Type.Object({
  foreshadowId: Type.String({ description: '伏笔 ID' }),
  status: Type.Union([
    Type.Literal('planted'),
    Type.Literal('reinforced'),
    Type.Literal('partially_revealed'),
    Type.Literal('recovering'),
    Type.Literal('recovered'),
    Type.Literal('abandoned'),
  ], { description: '新状态' }),
  chapterNumber: Type.Optional(Type.Number({ description: '当前章节号（用于记录 first/last chapter）' })),
  // ── P2-2：伏笔埋设/回收方式 ──
  plantMethod: Type.Optional(Type.Union([
    Type.Literal('explicit'),
    Type.Literal('implicit'),
    Type.Literal('indirect'),
  ], { description: '埋设方式：explicit=明写 / implicit=暗写 / indirect=侧写' })),
  recoverMethod: Type.Optional(Type.Union([
    Type.Literal('explicit'),
    Type.Literal('implicit'),
    Type.Literal('reverse'),
    Type.Literal('progressive'),
  ], { description: '回收方式：explicit=点破 / implicit=暗示 / reverse=反向 / progressive=递进' })),
})

const UpdateConflictParams = Type.Object({
  conflictId: Type.String({ description: '冲突 ID' }),
  stage: Type.Optional(Type.Union([
    Type.Literal('latent'),
    Type.Literal('emerging'),
    Type.Literal('escalating'),
    Type.Literal('erupting'),
    Type.Literal('reversing'),
    Type.Literal('resolved'),
    Type.Literal('transformed'),
  ], { description: '冲突阶段' })),
  intensity: Type.Optional(Type.Number({ minimum: 1, maximum: 10, description: '强度 1-10' })),
  // ── 四层逻辑④：双向关联 ──
  participants: Type.Optional(Type.Array(Type.String(), {
    description: '参与方角色 ID 列表（更新后会自动同步到角色的 participating_conflicts 反向索引）',
  })),
  // ── P2-1：冲突功能位 + 非线性推进 ──
  plotFunction: Type.Optional(Type.Union([
    Type.Literal('provide_resource'),
    Type.Literal('create_obstacle'),
    Type.Literal('amplify_conflict'),
    Type.Literal('open_phase'),
    Type.Literal('change_judgment'),
    Type.Literal('advance_relationship'),
    Type.Literal('reveal_world_rule'),
  ], { description: '剧情功能位：provide_resource=提供资源 / create_obstacle=制造障碍 / amplify_conflict=放大冲突 / open_phase=开启新阶段 / change_judgment=改变主角判断 / advance_relationship=推进关系 / reveal_world_rule=揭示世界规则' })),
  progressionMode: Type.Optional(Type.Union([
    Type.Literal('linear'),
    Type.Literal('mutation'),
    Type.Literal('stagnation'),
    Type.Literal('regression'),
    Type.Literal('reversal'),
  ], { description: '推进模式：linear=线性升级 / mutation=突变 / stagnation=停滞 / regression=降级 / reversal=反转' })),
})

const UpdateClueParams = Type.Object({
  clueId: Type.String({ description: '线索 ID' }),
  progress: Type.Optional(Type.Number({ minimum: 0, maximum: 100, description: '进度 0-100' })),
  currentStep: Type.Optional(Type.String({ description: '当前步骤' })),
  nextStep: Type.Optional(Type.String({ description: '下一步' })),
})

const UpdateRelationshipParams = Type.Object({
  relationshipId: Type.String({ description: '关系 ID' }),
  currentStage: Type.Optional(Type.String({ description: '新阶段（如：合作→信任→反目）' })),
  // ── 四层逻辑②：动态关系补全 ──
  dynamicRole: Type.Optional(Type.String({
    description: '动态功能位："在帮主角什么 / 拦主角什么"，一句话描述本关系对剧情的推动作用',
  })),
  alignment: Type.Optional(Type.Union([
    Type.Literal('ally'),
    Type.Literal('temporary_ally'),
    Type.Literal('opponent'),
    Type.Literal('temporary_opponent'),
    Type.Literal('neutral'),
    Type.Literal('pending_shift'),
  ], { description: '阵营关系：ally=同一边 / temporary_ally=暂时同路 / opponent=对立 / temporary_opponent=暂时对立 / neutral=中立 / pending_shift=待转变' })),
  trend: Type.Optional(Type.Union([
    Type.Literal('stable'),
    Type.Literal('warming'),
    Type.Literal('cooling'),
    Type.Literal('breaking'),
    Type.Literal('reconciling'),
  ], { description: '走向：stable=稳定 / warming=升温 / cooling=降温 / breaking=即将破裂 / reconciling=和解' })),
  chapterHint: Type.Optional(Type.String({
    description: '本章关系约束提示：一句话说明本章关系应如何变化（可空，空表示本章不约束）',
  })),
  chapterNumber: Type.Optional(Type.Number({
    description: '当前章节号（用于更新 lastUpdatedChapter 并自动追加 stageHistory 条目）',
  })),
  changeReason: Type.Optional(Type.String({
    description: '阶段变更原因（与 chapterNumber 一起写入 stageHistory 的 reason 字段）',
  })),
})

const CreateRelationshipParams = Type.Object({
  projectId: Type.String({ description: '项目 ID' }),
  characterA: Type.String({ description: '角色 A ID' }),
  characterB: Type.String({ description: '角色 B ID' }),
  relationType: Type.String({ description: '关系类型标签：敌对/合作/师徒/恋人/亲属...' }),
  currentStage: Type.Optional(Type.String({ description: '当前阶段（如：初识/合作/反目），默认空' })),
  // ── 四层逻辑②：动态关系补全 ──
  dynamicRole: Type.Optional(Type.String({
    description: '动态功能位："在帮主角什么 / 拦主角什么"',
  })),
  alignment: Type.Optional(Type.Union([
    Type.Literal('ally'),
    Type.Literal('temporary_ally'),
    Type.Literal('opponent'),
    Type.Literal('temporary_opponent'),
    Type.Literal('neutral'),
    Type.Literal('pending_shift'),
  ], { description: '阵营关系（默认 neutral）' })),
  trend: Type.Optional(Type.Union([
    Type.Literal('stable'),
    Type.Literal('warming'),
    Type.Literal('cooling'),
    Type.Literal('breaking'),
    Type.Literal('reconciling'),
  ], { description: '走向（默认 stable）' })),
  chapterHint: Type.Optional(Type.String({
    description: '本章关系约束提示',
  })),
})

const DeleteRelationshipParams = Type.Object({
  relationshipId: Type.String({ description: '关系 ID' }),
})

const CreateCharacterParams = Type.Object({
  projectId: Type.String({ description: '项目 ID' }),
  name: Type.String({ description: '角色名' }),
  description: Type.Optional(Type.String({ description: '角色简要描述' })),
  identity: Type.Optional(Type.String({ description: '身份' })),
  personality: Type.Optional(Type.String({ description: '性格' })),
  appearance: Type.Optional(Type.String({ description: '外貌' })),
  currentState: Type.Optional(Type.String({ description: '当前状态（情绪/处境）' })),
  currentGoal: Type.Optional(Type.String({ description: '当前目标' })),
  currentPressure: Type.Optional(Type.String({ description: '当前压力' })),
  secret: Type.Optional(Type.String({ description: '秘密' })),
  arcStage: Type.Optional(Type.String({ description: '弧光阶段' })),
  speechStyle: Type.Optional(Type.String({ description: '说话风格' })),
  // ── 四层逻辑补全字段 ──
  longTermDesire: Type.Optional(Type.String({
    description: '长期欲望：跨章节稳定的发动机（与当前目标的区别：当前目标会随剧情变化，长期欲望贯穿全书）',
  })),
  plotRole: Type.Optional(Type.Union([
    Type.Literal('protagonist'),
    Type.Literal('main_opponent'),
    Type.Literal('supporting'),
    Type.Literal('function'),
    Type.Literal('background'),
  ], { description: '角色层级：protagonist=主角 / main_opponent=主要对手 / supporting=重要配角 / function=功能配角 / background=背景人物' })),
  removalImpact: Type.Optional(Type.String({
    description: '删掉影响：一句话描述"删掉这个角色哪段剧情会受影响"',
  })),
})

const CreateForeshadowParams = Type.Object({
  projectId: Type.String({ description: '项目 ID' }),
  description: Type.String({ description: '伏笔描述' }),
  importance: Type.Union([
    Type.Literal('major'),
    Type.Literal('critical'),
  ], { description: '重要级别：只允许 major（重要）或 critical（关键）' }),
  narrativeRole: Type.Union([
    Type.Literal('dark_line'),
    Type.Literal('major_reveal'),
  ], { description: '叙事作用：推进暗线，或服务重大揭示/反转' }),
  hiddenQuestion: Type.String({ description: '该伏笔建立、推进或改写的隐藏问题' }),
  plannedPayoff: Type.String({ description: '计划如何揭示或回收，以及回收后改变什么' }),
  category: Type.Optional(Type.Union([
    Type.Literal('item'),
    Type.Literal('spoken'),
    Type.Literal('event'),
    Type.Literal('identity'),
    Type.Literal('secret'),
    Type.Literal('prophecy'),
    Type.Literal('promise'),
    Type.Literal('quote'),
  ], { description: '类别：item=物品 / spoken=言语 / event=事件 / identity=身份 / secret=秘密 / prophecy=预言 / promise=承诺 / quote=台词' })),
  recoverByChapter: Type.Optional(Type.Number({ description: '应在第几章前回收' })),
  linkedCharacters: Type.Optional(Type.Array(Type.String(), { description: '关联角色 ID 列表' })),
  linkedClues: Type.Optional(Type.Array(Type.String(), { description: '关联线索 ID 列表' })),
  // ── P2-2：伏笔埋设/回收方式 ──
  plantMethod: Type.Optional(Type.Union([
    Type.Literal('explicit'),
    Type.Literal('implicit'),
    Type.Literal('indirect'),
  ], { description: '埋设方式：explicit=明写 / implicit=暗写 / indirect=侧写' })),
  recoverMethod: Type.Optional(Type.Union([
    Type.Literal('explicit'),
    Type.Literal('implicit'),
    Type.Literal('reverse'),
    Type.Literal('progressive'),
  ], { description: '回收方式：explicit=点破 / implicit=暗示 / reverse=反向 / progressive=递进' })),
})

const CreateConflictParams = Type.Object({
  projectId: Type.String({ description: '项目 ID' }),
  description: Type.String({ description: '冲突描述' }),
  type: Type.Optional(Type.Union([
    Type.Literal('inner'),
    Type.Literal('relationship'),
    Type.Literal('faction'),
    Type.Literal('interest'),
    Type.Literal('moral'),
    Type.Literal('identity'),
    Type.Literal('emotional'),
    Type.Literal('world_rule'),
    Type.Literal('survival'),
  ], { description: '冲突类型' })),
  intensity: Type.Optional(Type.Number({ minimum: 1, maximum: 10, description: '强度 1-10' })),
  stage: Type.Optional(Type.Union([
    Type.Literal('latent'),
    Type.Literal('emerging'),
    Type.Literal('escalating'),
    Type.Literal('erupting'),
    Type.Literal('reversing'),
    Type.Literal('resolved'),
    Type.Literal('transformed'),
  ], { description: '冲突阶段' })),
  participants: Type.Optional(Type.Array(Type.String(), { description: '参与方 ID 列表' })),
  // ── P2-1：冲突功能位 + 非线性推进 ──
  plotFunction: Type.Optional(Type.Union([
    Type.Literal('provide_resource'),
    Type.Literal('create_obstacle'),
    Type.Literal('amplify_conflict'),
    Type.Literal('open_phase'),
    Type.Literal('change_judgment'),
    Type.Literal('advance_relationship'),
    Type.Literal('reveal_world_rule'),
  ], { description: '剧情功能位：provide_resource=提供资源 / create_obstacle=制造障碍 / amplify_conflict=放大冲突 / open_phase=开启新阶段 / change_judgment=改变主角判断 / advance_relationship=推进关系 / reveal_world_rule=揭示世界规则' })),
  progressionMode: Type.Optional(Type.Union([
    Type.Literal('linear'),
    Type.Literal('mutation'),
    Type.Literal('stagnation'),
    Type.Literal('regression'),
    Type.Literal('reversal'),
  ], { description: '推进模式：linear=线性升级 / mutation=突变 / stagnation=停滞 / regression=降级 / reversal=反转' })),
})

const CreateClueParams = Type.Object({
  projectId: Type.String({ description: '项目 ID' }),
  description: Type.String({ description: '线索描述' }),
  pointsTo: Type.String({ description: '线索指向的真相/目标' }),
  progress: Type.Optional(Type.Number({ minimum: 0, maximum: 100, description: '进度 0-100' })),
  currentStep: Type.Optional(Type.String({ description: '当前步骤' })),
  nextStep: Type.Optional(Type.String({ description: '下一步' })),
  isMisleading: Type.Optional(Type.Boolean({ description: '是否为误导线索' })),
  linkedForeshadow: Type.Optional(Type.String({ description: '关联伏笔 ID' })),
})

// ── 势力 / 地点 / 世界观要素 工具参数 ──

const QueryFactionsParams = Type.Object({
  projectId: Type.String({ description: '项目 ID' }),
})

const CreateFactionParams = Type.Object({
  projectId: Type.String({ description: '项目 ID' }),
  name: Type.String({ description: '势力名称' }),
  description: Type.Optional(Type.String({ description: '势力简述' })),
  type: Type.Optional(Type.Union([
    Type.Literal('organization'),
    Type.Literal('sect'),
    Type.Literal('kingdom'),
    Type.Literal('family'),
    Type.Literal('guild'),
    Type.Literal('cult'),
  ], { description: '势力类型' })),
  leaderId: Type.Optional(Type.String({ description: '首领角色 ID' })),
  ideology: Type.Optional(Type.String({ description: '理念/信仰' })),
  strength: Type.Optional(Type.Union([
    Type.Literal('weak'),
    Type.Literal('medium'),
    Type.Literal('strong'),
    Type.Literal('overwhelming'),
  ], { description: '实力等级' })),
  resources: Type.Optional(Type.Array(Type.String(), { description: '资源列表' })),
  allies: Type.Optional(Type.Array(Type.String(), { description: '盟友势力 ID 列表' })),
  enemies: Type.Optional(Type.Array(Type.String(), { description: '敌对势力 ID 列表' })),
  status: Type.Optional(Type.Union([
    Type.Literal('active'),
    Type.Literal('declined'),
    Type.Literal('destroyed'),
    Type.Literal('hidden'),
  ], { description: '势力状态' })),
})

const UpdateFactionParams = Type.Object({
  factionId: Type.String({ description: '势力 ID' }),
  name: Type.Optional(Type.String({ description: '势力名称' })),
  description: Type.Optional(Type.String({ description: '势力简述' })),
  type: Type.Optional(Type.Union([
    Type.Literal('organization'),
    Type.Literal('sect'),
    Type.Literal('kingdom'),
    Type.Literal('family'),
    Type.Literal('guild'),
    Type.Literal('cult'),
  ], { description: '势力类型' })),
  leaderId: Type.Optional(Type.String({ description: '首领角色 ID' })),
  ideology: Type.Optional(Type.String({ description: '理念/信仰' })),
  strength: Type.Optional(Type.Union([
    Type.Literal('weak'),
    Type.Literal('medium'),
    Type.Literal('strong'),
    Type.Literal('overwhelming'),
  ], { description: '实力等级' })),
  resources: Type.Optional(Type.Array(Type.String(), { description: '资源列表' })),
  allies: Type.Optional(Type.Array(Type.String(), { description: '盟友势力 ID 列表' })),
  enemies: Type.Optional(Type.Array(Type.String(), { description: '敌对势力 ID 列表' })),
  status: Type.Optional(Type.Union([
    Type.Literal('active'),
    Type.Literal('declined'),
    Type.Literal('destroyed'),
    Type.Literal('hidden'),
  ], { description: '势力状态' })),
})

const QueryLocationsParams = Type.Object({
  projectId: Type.String({ description: '项目 ID' }),
})

const CreateLocationParams = Type.Object({
  projectId: Type.String({ description: '项目 ID' }),
  name: Type.String({ description: '地点名称' }),
  description: Type.Optional(Type.String({ description: '地点简述' })),
  type: Type.Optional(Type.Union([
    Type.Literal('continent'),
    Type.Literal('country'),
    Type.Literal('city'),
    Type.Literal('building'),
    Type.Literal('dungeon'),
    Type.Literal('region'),
    Type.Literal('wilderness'),
  ], { description: '地点类型' })),
  parentId: Type.Optional(Type.String({ description: '父级地点 ID（构建层级树）' })),
  factionId: Type.Optional(Type.String({ description: '归属势力 ID' })),
  significance: Type.Optional(Type.Union([
    Type.Literal('minor'),
    Type.Literal('moderate'),
    Type.Literal('major'),
    Type.Literal('critical'),
  ], { description: '重要程度' })),
  firstChapter: Type.Optional(Type.Number({ description: '首次出现章节' })),
  status: Type.Optional(Type.Union([
    Type.Literal('normal'),
    Type.Literal('destroyed'),
    Type.Literal('changed'),
    Type.Literal('hidden'),
  ], { description: '地点状态' })),
})

const UpdateLocationParams = Type.Object({
  locationId: Type.String({ description: '地点 ID' }),
  name: Type.Optional(Type.String({ description: '地点名称' })),
  description: Type.Optional(Type.String({ description: '地点简述' })),
  type: Type.Optional(Type.Union([
    Type.Literal('continent'),
    Type.Literal('country'),
    Type.Literal('city'),
    Type.Literal('building'),
    Type.Literal('dungeon'),
    Type.Literal('region'),
    Type.Literal('wilderness'),
  ], { description: '地点类型' })),
  parentId: Type.Optional(Type.String({ description: '父级地点 ID' })),
  factionId: Type.Optional(Type.String({ description: '归属势力 ID' })),
  significance: Type.Optional(Type.Union([
    Type.Literal('minor'),
    Type.Literal('moderate'),
    Type.Literal('major'),
    Type.Literal('critical'),
  ], { description: '重要程度' })),
  firstChapter: Type.Optional(Type.Number({ description: '首次出现章节' })),
  status: Type.Optional(Type.Union([
    Type.Literal('normal'),
    Type.Literal('destroyed'),
    Type.Literal('changed'),
    Type.Literal('hidden'),
  ], { description: '地点状态' })),
})

// ── 物品工具参数 ──

const QueryItemsParams = Type.Object({
  projectId: Type.String({ description: '项目 ID' }),
  /** 可选：按持有者过滤，传角色 ID 返回该角色拥有的所有物品 */
  ownerId: Type.Optional(Type.String({ description: '按持有者角色 ID 过滤；不传则返回项目所有物品' })),
})

const CreateItemParams = Type.Object({
  projectId: Type.String({ description: '项目 ID' }),
  name: Type.String({ description: '物品名称' }),
  description: Type.Optional(Type.String({ description: '物品简述' })),
  type: Type.Optional(Type.Union([
    Type.Literal('weapon'),
    Type.Literal('armor'),
    Type.Literal('artifact'),
    Type.Literal('consumable'),
    Type.Literal('key'),
    Type.Literal('material'),
    Type.Literal('info'),
    Type.Literal('misc'),
  ], { description: '物品类型：weapon(武器)/armor(防具)/artifact(法宝)/consumable(消耗品)/key(关键道具)/material(材料)/info(情报物品)/misc(杂物)' })),
  ownerId: Type.Optional(Type.String({ description: '持有者角色 ID；不传或空字符串表示无主物品' })),
  status: Type.Optional(Type.Union([
    Type.Literal('active'),
    Type.Literal('lost'),
    Type.Literal('destroyed'),
    Type.Literal('transformed'),
    Type.Literal('sealed'),
    Type.Literal('transferred'),
  ], { description: '物品状态：active(可用)/lost(遗失)/destroyed(损毁)/transformed(已转化)/sealed(封印)/transferred(已易主)' })),
  abilities: Type.Optional(Type.String({ description: '物品能力/效果描述' })),
  origin: Type.Optional(Type.String({ description: '物品来源描述' })),
  firstChapter: Type.Optional(Type.Number({ description: '首次出现章节号' })),
})

const UpdateItemParams = Type.Object({
  itemId: Type.String({ description: '物品 ID' }),
  name: Type.Optional(Type.String({ description: '物品名称' })),
  description: Type.Optional(Type.String({ description: '物品简述' })),
  type: Type.Optional(Type.Union([
    Type.Literal('weapon'),
    Type.Literal('armor'),
    Type.Literal('artifact'),
    Type.Literal('consumable'),
    Type.Literal('key'),
    Type.Literal('material'),
    Type.Literal('info'),
    Type.Literal('misc'),
  ], { description: '物品类型' })),
  ownerId: Type.Optional(Type.String({ description: '持有者角色 ID；传空字符串表示变更为无主' })),
  status: Type.Optional(Type.Union([
    Type.Literal('active'),
    Type.Literal('lost'),
    Type.Literal('destroyed'),
    Type.Literal('transformed'),
    Type.Literal('sealed'),
    Type.Literal('transferred'),
  ], { description: '物品状态' })),
  abilities: Type.Optional(Type.String({ description: '物品能力/效果描述' })),
  origin: Type.Optional(Type.String({ description: '物品来源描述' })),
  firstChapter: Type.Optional(Type.Number({ description: '首次出现章节号' })),
})

const DeleteItemParams = Type.Object({
  itemId: Type.String({ description: '物品 ID' }),
})

const AskStoryParams = Type.Object({
  projectId: Type.String({ description: '项目 ID' }),
  question: Type.String({ description: '自然语言问题，例如"上一章结尾是什么？""角色林深的当前目标是什么？"' }),
  chapterNumber: Type.Optional(Type.Number({ description: '当前章节号（可选，用于上下文过滤）' })),
})

const CreateWorldElementParams = Type.Object({
  projectId: Type.String({ description: '项目 ID' }),
  category: Type.Union([
    Type.Literal('power_system'),
    Type.Literal('history'),
    Type.Literal('culture'),
    Type.Literal('religion'),
    Type.Literal('technology'),
    Type.Literal('economy'),
    Type.Literal('geography'),
  ], { description: '世界观要素分类' }),
  name: Type.String({ description: '要素名称' }),
  description: Type.Optional(Type.String({ description: '要素描述' })),
  parentId: Type.Optional(Type.String({ description: '父级要素 ID（支持层级）' })),
  attributes: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: '附加属性（键值对）' })),
})

const UpdateWorldElementParams = Type.Object({
  worldElementId: Type.String({ description: '世界观要素 ID' }),
  category: Type.Optional(Type.Union([
    Type.Literal('power_system'),
    Type.Literal('history'),
    Type.Literal('culture'),
    Type.Literal('religion'),
    Type.Literal('technology'),
    Type.Literal('economy'),
    Type.Literal('geography'),
  ], { description: '世界观要素分类' })),
  name: Type.Optional(Type.String({ description: '要素名称' })),
  description: Type.Optional(Type.String({ description: '要素描述' })),
  parentId: Type.Optional(Type.String({ description: '父级要素 ID' })),
  attributes: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: '附加属性（键值对）' })),
})

/**
 * 创建小说信息问答工具（A+B 语义化查询）
 *
 * 让 Director / Writer / Reviewer / Reviser 用自然语言按需查询故事信息，
 * 避免一次性 dump 全表导致上下文膨胀，也避免完全关闭工具导致创作中无法核对细节。
 *
 * 双事实源修复（P0）：当注入 boundaryProvider 且携带 chapterNumber 时，
 * 优先走与 prompt-builder 注入路径相同的章前语义（N-1 快照优先），
 * 而非 memoryStore 账本重放，确保工具查询与注入上下文一致。
 * 无 boundaryProvider 时回退到 memoryStore 账本重放（兼容路径）。
 */
export function createNovelAskStoryTool(
  store: NovelStore,
  memoryStore?: NovelMemoryStore,
  boundaryProvider?: ChapterBoundaryProvider,
): ToolDefinition<typeof AskStoryParams> {
  return defineTool({
    name: 'novel_ask_story',
    label: '小说信息问答',
    description:
      '用自然语言向小说创作系统提问，获取当前项目的故事状态、角色、冲突、伏笔、上一章内容等信息。' +
      '适用于创作过程中按需查询，不必记忆全部设定。只读工具，不修改任何状态。' +
      '当携带 chapterNumber 时，会返回该章开篇前的状态（与注入上下文一致），避免重写中间章节时读到未来章节的状态倒灌。',
    promptSnippet: '小说信息问答',
    parameters: AskStoryParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const { projectId, question, chapterNumber } = params
      const q = question.toLowerCase()

      function quotedName(s: string): string | undefined {
        const m = s.match(/[“"""「『]([^""""」』]+)[""""」』]/)
        return m?.[1].trim()
      }

      // P0 修复：优先走 boundaryProvider（与注入路径一致），回退到 memoryStore 账本重放
      let boundary: ChapterBoundaryContext | undefined
      let chapterContext: ChapterStoryContext | undefined
      if (chapterNumber !== undefined) {
        if (boundaryProvider) {
          try {
            boundary = boundaryProvider.getChapterBoundaryContext(projectId, chapterNumber)
          } catch {
            boundary = undefined
          }
        } else if (memoryStore) {
          try {
            chapterContext = memoryStore.getChapterStoryContext(projectId, chapterNumber)
          } catch {
            chapterContext = undefined
          }
        }
      }

      if (q.includes('上一章') || q.includes('最近章节') || q.includes('结尾') || q.includes('前情') || q.includes('recap')) {
        return answerRecentChapter(store, projectId, chapterNumber)
      }
      if (q.includes('角色') || q.includes('人物') || q.includes('谁') || q.includes('主角') || quotedName(question)) {
        return answerCharacter(store, projectId, quotedName(question), boundary, chapterContext)
      }
      if (q.includes('冲突') || q.includes('矛盾') || q.includes('危机') || q.includes('张力')) {
        return answerConflicts(store, projectId, boundary, chapterContext)
      }
      if (q.includes('伏笔') || q.includes('铺垫') || q.includes('回收')) {
        return answerForeshadows(store, projectId, chapterNumber, boundary, chapterContext)
      }
      if (q.includes('线索') || q.includes('真相') || q.includes('谜题')) {
        return answerClues(store, projectId, boundary, chapterContext)
      }
      if (q.includes('风格') || q.includes('文风') || q.includes('写法') || q.includes('语言')) {
        return answerStyle(store, projectId)
      }
      if (q.includes('大纲') || q.includes('结构') || q.includes('整体') || q.includes('主线')) {
        return answerOutline(store, projectId)
      }
      if (q.includes('世界') || q.includes('设定') || q.includes('规则') || q.includes('势力') || q.includes('地点')) {
        return answerWorld(store, projectId)
      }

      return answerGuide()
    },
  })
}

function answerRecentChapter(store: NovelStore, projectId: string, chapterNumber?: number): AgentToolResult<undefined> {
  // 重写中间章节时，chapterNumber 之前的章节才算"最近章节"，避免读到未来章节内容
  const allChapters = store.listRecentChapters(projectId, 3)
  const chapters = chapterNumber !== undefined
    ? allChapters.filter((c) => c.chapterNumber < chapterNumber)
    : allChapters
  if (chapters.length === 0) {
    return { content: [{ type: 'text', text: '尚未生成任何章节。' }], details: undefined }
  }
  const latest = chapters[chapters.length - 1]
  const ending = latest.content ? latest.content.slice(-500) : '（无内容）'
  const recap = latest.recap ? `\n\n前情提要：${latest.recap}` : ''
  const text = [
    `## 最近章节：第${latest.chapterNumber}章 ${latest.title}`,
    `状态：${latest.status} | 字数：${latest.wordCount || 0}`,
    ``,
    `### 结尾片段（最后 500 字）`,
    ending,
    recap,
  ].join('\n')
  return { content: [{ type: 'text', text }], details: undefined }
}

function answerCharacter(
  store: NovelStore,
  projectId: string,
  nameHint?: string,
  boundary?: ChapterBoundaryContext,
  chapterContext?: ChapterStoryContext,
): AgentToolResult<undefined> {
  // P0 修复：优先用 boundary.entities（与注入路径一致的章前快照），回退到账本覆盖逻辑
  const baseCharacters = boundary ? boundary.entities.characters : store.listCharacters(projectId)
  if (baseCharacters.length === 0) {
    return { content: [{ type: 'text', text: '项目中暂无角色。' }], details: undefined }
  }

  let view: typeof baseCharacters
  let sourceSuffix: string
  if (boundary) {
    // boundary.entities 已是章前状态，无需覆盖
    view = baseCharacters
    sourceSuffix = boundary.fromSnapshot
      ? `\n（以上为第 ${boundary.chapterNumber} 章开篇前快照，与注入上下文一致）`
      : `\n（未找到 N-1 快照，回退为当前活库状态）`
  } else {
    // 回退路径：用账本反推的角色动态字段覆盖 store 中的最新值
    const stateById = chapterContext
      ? collectChapterStateBySubject(chapterContext, 'character')
      : new Map<string, Record<string, unknown>>()
    view = baseCharacters.map((c) => {
      const state = stateById.get(c.id)
      if (!state) return c
      return {
        ...c,
        currentState: pickString(state.currentState, c.currentState),
        currentGoal: pickString(state.currentGoal, c.currentGoal),
        currentPressure: pickString(state.currentPressure, c.currentPressure),
        secret: pickString(state.secret, c.secret),
        arcStage: pickString(state.arcStage, c.arcStage),
        longTermDesire: pickString(state.longTermDesire, c.longTermDesire),
        plotRole: pickString(state.plotRole, c.plotRole) as typeof c.plotRole,
      }
    })
    sourceSuffix = chapterContext
      ? `\n（以上动态字段基于第 ${chapterContext.chapterNumber} 章前事件账本反推）`
      : ''
  }

  let target = view.find((c) => c.isProtagonist)
  if (nameHint) {
    const exact = view.find((c) => c.name === nameHint)
    const fuzzy = view.find((c) => c.name.includes(nameHint) || nameHint.includes(c.name))
    target = exact ?? fuzzy ?? target
  }

  if (target) {
    const text = [
      `## 角色：${target.name}`,
      `身份：${target.identity || '未设定'}`,
      `性格：${target.personality || '未设定'}`,
      `外貌：${target.appearance || '未设定'}`,
      `说话风格：${target.speechStyle || '未设定'}`,
      `当前状态：${target.currentState || '未设定'}`,
      `当前目标：${target.currentGoal || '未设定'}`,
      `当前压力：${target.currentPressure || '未设定'}`,
      `长期欲望：${target.longTermDesire || '未设定'}`,
      `角色层级：${target.plotRole || '未设定'}`,
      `弧光阶段：${target.arcStage || '未设定'}`,
      `秘密：${target.secret || '无'}`,
      sourceSuffix,
    ].join('\n')
    return { content: [{ type: 'text', text }], details: undefined }
  }

  const list = view
    .map((c) => `- ${c.name}${c.isProtagonist ? '（主角）' : ''}：${c.identity || c.description || '暂无简介'}`)
    .join('\n')
  return { content: [{ type: 'text', text: `## 角色列表\n${list}` }], details: undefined }
}

function answerConflicts(
  store: NovelStore,
  projectId: string,
  boundary?: ChapterBoundaryContext,
  chapterContext?: ChapterStoryContext,
): AgentToolResult<undefined> {
  // P0 修复：优先用 boundary.entities.conflicts（章前快照），回退到账本覆盖逻辑
  const baseConflicts = boundary ? boundary.entities.conflicts : store.listConflicts(projectId)

  let conflicts: typeof baseConflicts
  let suffix: string
  if (boundary) {
    conflicts = baseConflicts
    suffix = boundary.fromSnapshot
      ? `\n（以上为第 ${boundary.chapterNumber} 章开篇前快照，与注入上下文一致）`
      : `\n（未找到 N-1 快照，回退为当前活库状态）`
  } else {
    const stateById = chapterContext
      ? collectChapterStateBySubject(chapterContext, 'conflict')
      : new Map<string, Record<string, unknown>>()
    conflicts = baseConflicts.map((c) => {
      const state = stateById.get(c.id)
      if (!state) return c
      return {
        ...c,
        stage: pickString(state.stage, c.stage) as typeof c.stage,
        intensity: pickNumber(state.intensity, c.intensity),
      }
    })
    suffix = chapterContext ? `\n（以上状态基于第 ${chapterContext.chapterNumber} 章前事件账本反推）` : ''
  }

  conflicts = conflicts
    .filter((c) => c.stage !== 'resolved' && c.stage !== 'transformed')
    .sort((a, b) => b.intensity - a.intensity)
    .slice(0, 5) as typeof conflicts

  if (conflicts.length === 0) {
    return { content: [{ type: 'text', text: '当前没有活跃冲突。' }], details: undefined }
  }
  const list = conflicts
    .map((c) => `- ${c.description}（强度 ${c.intensity}/10，阶段 ${c.stage}）`)
    .join('\n')
  return { content: [{ type: 'text', text: `## 活跃冲突（Top 5）\n${list}${suffix}` }], details: undefined }
}

function answerForeshadows(
  store: NovelStore,
  projectId: string,
  chapterNumber?: number,
  boundary?: ChapterBoundaryContext,
  chapterContext?: ChapterStoryContext,
): AgentToolResult<undefined> {
  // P0 修复：优先用 boundary.entities.foreshadowing（章前快照），回退到账本覆盖逻辑
  const baseForeshadows = boundary ? boundary.entities.foreshadowing : store.listForeshadowing(projectId)

  let foreshadows: typeof baseForeshadows
  let suffix: string
  if (boundary) {
    foreshadows = baseForeshadows
    suffix = boundary.fromSnapshot
      ? `\n（以上为第 ${boundary.chapterNumber} 章开篇前快照，与注入上下文一致）`
      : `\n（未找到 N-1 快照，回退为当前活库状态）`
  } else {
    const stateById = chapterContext
      ? collectChapterStateBySubject(chapterContext, 'foreshadow')
      : new Map<string, Record<string, unknown>>()
    foreshadows = baseForeshadows.map((f) => {
      const state = stateById.get(f.id)
      if (!state) return f
      return {
        ...f,
        status: pickString(state.status, f.status) as typeof f.status,
      }
    })
    suffix = chapterContext ? `\n（以上状态基于第 ${chapterContext.chapterNumber} 章前事件账本反推）` : ''
  }

  foreshadows = foreshadows
    .filter((f) => f.status === 'planned' || f.status === 'planted' || f.status === 'reinforced') as typeof foreshadows

  if (chapterNumber !== undefined) {
    foreshadows = foreshadows.filter((f) => !f.recoverByChapter || f.recoverByChapter <= chapterNumber + 5) as typeof foreshadows
  }

  foreshadows = foreshadows.slice(0, 10) as typeof foreshadows
  if (foreshadows.length === 0) {
    return { content: [{ type: 'text', text: '当前没有待回收伏笔。' }], details: undefined }
  }
  const list = foreshadows
    .map((f) => `- ${f.description}（类别 ${f.category}，状态 ${f.status}${f.recoverByChapter ? `，预计第 ${f.recoverByChapter} 章前回收` : ''}）`)
    .join('\n')
  return { content: [{ type: 'text', text: `## 未回收伏笔（Top 10）\n${list}${suffix}` }], details: undefined }
}

function answerClues(
  store: NovelStore,
  projectId: string,
  boundary?: ChapterBoundaryContext,
  chapterContext?: ChapterStoryContext,
): AgentToolResult<undefined> {
  // P0 修复：优先用 boundary.entities.clues（章前快照），回退到账本覆盖逻辑
  const baseClues = boundary ? boundary.entities.clues : store.listClues(projectId)

  let clues: typeof baseClues
  let suffix: string
  if (boundary) {
    clues = baseClues
    suffix = boundary.fromSnapshot
      ? `\n（以上为第 ${boundary.chapterNumber} 章开篇前快照，与注入上下文一致）`
      : `\n（未找到 N-1 快照，回退为当前活库状态）`
  } else {
    const stateById = chapterContext
      ? collectChapterStateBySubject(chapterContext, 'clue')
      : new Map<string, Record<string, unknown>>()
    clues = baseClues.map((c) => {
      const state = stateById.get(c.id)
      if (!state) return c
      return {
        ...c,
        progress: pickNumber(state.progress, c.progress),
      }
    })
    suffix = chapterContext ? `\n（以上状态基于第 ${chapterContext.chapterNumber} 章前事件账本反推）` : ''
  }

  clues = clues
    .filter((c) => c.progress < 100)
    .sort((a, b) => b.progress - a.progress)
    .slice(0, 8) as typeof clues

  if (clues.length === 0) {
    return { content: [{ type: 'text', text: '当前没有进行中的线索。' }], details: undefined }
  }
  const list = clues
    .map((c) => `- ${c.description}（进度 ${c.progress}%${c.isMisleading ? '，误导线索' : ''}）`)
    .join('\n')
  return { content: [{ type: 'text', text: `## 进行中线索（Top 8）\n${list}${suffix}` }], details: undefined }
}

function answerStyle(store: NovelStore, projectId: string): AgentToolResult<undefined> {
  const guides = store.listStyleGuide(projectId)
  if (guides.length === 0) {
    return { content: [{ type: 'text', text: '尚未配置风格指南。' }], details: undefined }
  }
  const list = guides.map((g) => `- ${g.category}：${g.rule}${g.example ? `（示例：${g.example}）` : ''}`).join('\n')
  return { content: [{ type: 'text', text: `## 风格指南\n${list}` }], details: undefined }
}

function answerOutline(store: NovelStore, projectId: string): AgentToolResult<undefined> {
  const project = store.getProject(projectId)
  if (!project) {
    return { content: [{ type: 'text', text: '项目不存在。' }], details: undefined }
  }
  const text = [
    `## 项目：${project.title}`,
    `类型：${project.genre || '未设定'}`,
    `阶段：${project.currentStage || '未设定'} | 当前卷：${project.currentVolume} | 当前章：${project.currentChapter}`,
    ``,
    `### 简介`,
    project.synopsis || '（暂无）',
    ``,
    `### 大纲`,
    project.outline || '（暂无）',
  ].join('\n')
  return { content: [{ type: 'text', text }], details: undefined }
}

function answerWorld(store: NovelStore, projectId: string): AgentToolResult<undefined> {
  const rules = store.listWorldRules(projectId)
  const factions = store.listFactions(projectId)
  const locations = store.listLocations(projectId)

  const parts: string[] = ['## 世界设定']
  if (rules.length > 0) {
    parts.push('\n### 世界规则\n' + rules.map((r) => `- [${r.category}] ${r.rule}${r.cost ? `（代价：${r.cost}）` : ''}`).join('\n'))
  }
  if (factions.length > 0) {
    parts.push('\n### 势力\n' + factions.slice(0, 10).map((f) => `- ${f.name}（${f.type}，实力 ${f.strength}，状态 ${f.status}）`).join('\n'))
  }
  if (locations.length > 0) {
    parts.push('\n### 地点\n' + locations.slice(0, 10).map((l) => `- ${l.name}（${l.type}，重要度 ${l.significance}）`).join('\n'))
  }
  if (rules.length === 0 && factions.length === 0 && locations.length === 0) {
    parts.push('暂无世界设定。')
  }
  return { content: [{ type: 'text', text: parts.join('\n') }], details: undefined }
}

function answerGuide(): AgentToolResult<undefined> {
  const text = [
    '## 小说信息问答使用指南',
    '你可以用自然语言提问，例如：',
    '- 上一章结尾是什么？',
    '- 角色 "林深" 的当前目标是什么？',
    '- 当前最大的冲突是什么？',
    '- 有哪些未回收的伏笔？',
    '- 故事的风格要求是什么？',
    '- 全书大纲是什么？',
    '- 世界设定/势力/地点有哪些？',
  ].join('\n')
  return { content: [{ type: 'text', text }], details: undefined }
}

// ── 章前状态反推辅助函数 ──

/**
 * 从 ChapterStoryContext.stateBeforeChapter 中按 subjectType 聚合，
 * 返回 subjectId → { dimension: value } 的映射。
 *
 * stateBeforeChapter 已经按 (subjectType, subjectId, dimension, targetType, targetId)
 * 去重并保留最近一次变化（见 novel-memory-store.getChapterStoryContext），
 * 因此这里只需按 subjectType 过滤后按 subjectId 分组即可。
 */
function collectChapterStateBySubject(
  context: ChapterStoryContext,
  subjectType: 'character' | 'conflict' | 'foreshadow' | 'clue',
): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>()
  for (const state of context.stateBeforeChapter) {
    if (state.subjectType !== subjectType) continue
    const entry = map.get(state.subjectId) ?? {}
    entry[state.dimension] = state.value
    map.set(state.subjectId, entry)
  }
  return map
}

/** 账本值若为非空字符串则采用，否则回退到 store 中的当前值 */
function pickString(ledgerValue: unknown, fallback: string): string {
  return typeof ledgerValue === 'string' && ledgerValue.length > 0 ? ledgerValue : fallback
}

/** 账本值若为有效数字则采用，否则回退到 store 中的当前值 */
function pickNumber(ledgerValue: unknown, fallback: number): number {
  return typeof ledgerValue === 'number' && Number.isFinite(ledgerValue) ? ledgerValue : fallback
}

// ── 工具创建函数 ──

/**
 * 创建小说状态查询工具
 *
 * 读工具：查询故事状态，结果作为 tool message 追加到对话末尾。
 * 不影响系统提示词和章节上下文 → 前缀缓存命中。
 *
 * 双事实源修复（P0）：当传入 asOfChapter 且注入了 boundaryProvider 时，
 * 走与 prompt-builder 注入路径相同的章前语义（N-1 快照优先，活库兜底），
 * 避免重写中间章节时读到未来章节已写入的状态。未传 asOfChapter 时走活库最新值（顺序生成场景）。
 */
export function createNovelQueryStateTool(
  store: NovelStore,
  boundaryProvider?: ChapterBoundaryProvider,
): ToolDefinition<typeof QueryStateParams> {
  return defineTool({
    name: 'novel_query_state',
    label: '查询故事状态',
    description:
      '查询小说的故事状态，包括角色、关系、冲突、伏笔、线索、世界规则等。' +
      '用于在创作过程中获取状态信息。此工具只读不写，不影响缓存。' +
      '重写中间章节时请传 asOfChapter 获取该章开篇前的状态，避免读到未来章节的状态倒灌。',
    promptSnippet: '查询小说故事状态',
    parameters: QueryStateParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const { projectId, queryType, asOfChapter } = params

      // 当传入 asOfChapter 且有 boundaryProvider 时，走统一章前语义
      // 与 prompt-builder.buildChapterContextShared 注入路径一致，消除双事实源
      const boundary = (asOfChapter !== undefined && boundaryProvider)
        ? boundaryProvider.getChapterBoundaryContext(projectId, asOfChapter)
        : undefined

      let result: string

      if (boundary) {
        const e = boundary.entities
        const suffix = boundary.fromSnapshot
          ? `\n\n（以上为第 ${asOfChapter} 章开篇前快照，与注入上下文一致）`
          : `\n\n（未找到 N-1 快照，回退为当前活库状态）`
        switch (queryType) {
          case 'characters':
            result = JSON.stringify(e.characters, null, 2) + suffix
            break
          case 'relationships':
            result = JSON.stringify(e.relationships, null, 2) + suffix
            break
          case 'conflicts':
            result = JSON.stringify(e.conflicts, null, 2) + suffix
            break
          case 'foreshadowing':
            result = JSON.stringify(e.foreshadowing, null, 2) + suffix
            break
          case 'clues':
            result = JSON.stringify(e.clues, null, 2) + suffix
            break
          case 'world_rules':
            result = JSON.stringify(store.listWorldRules(projectId), null, 2) + suffix
            break
          case 'constraints':
            result = JSON.stringify(store.listConstraints(projectId), null, 2) + suffix
            break
          case 'info_layers':
            result = JSON.stringify(e.informationLayers, null, 2) + suffix
            break
          case 'style_guide':
            result = JSON.stringify(store.listStyleGuide(projectId), null, 2) + suffix
            break
          case 'all':
            result = JSON.stringify({
              characters: e.characters,
              relationships: e.relationships,
              conflicts: e.conflicts,
              foreshadowing: e.foreshadowing,
              clues: e.clues,
              factions: e.factions,
              locations: e.locations,
              items: e.items,
              worldElements: e.worldElements,
              informationLayers: e.informationLayers,
              worldRules: store.listWorldRules(projectId),
              constraints: store.listConstraints(projectId),
              styleGuides: store.listStyleGuide(projectId),
            }, null, 2) + suffix
            break
          default:
            result = `未知查询类型: ${queryType}`
        }
      } else {
        // 活库最新值（顺序生成场景，或未注入 boundaryProvider 的兼容路径）
        switch (queryType) {
          case 'characters':
            result = JSON.stringify(store.listCharacters(projectId), null, 2)
            break
          case 'relationships':
            result = JSON.stringify(store.listRelationships(projectId), null, 2)
            break
          case 'conflicts':
            result = JSON.stringify(store.listConflicts(projectId), null, 2)
            break
          case 'foreshadowing':
            result = JSON.stringify(store.listForeshadowing(projectId), null, 2)
            break
          case 'clues':
            result = JSON.stringify(store.listClues(projectId), null, 2)
            break
          case 'world_rules':
            result = JSON.stringify(store.listWorldRules(projectId), null, 2)
            break
          case 'constraints':
            result = JSON.stringify(store.listConstraints(projectId), null, 2)
            break
          case 'info_layers':
            result = JSON.stringify(store.listInformationLayers(projectId), null, 2)
            break
          case 'style_guide':
            result = JSON.stringify(store.listStyleGuide(projectId), null, 2)
            break
          case 'all':
            result = JSON.stringify({
              characters: store.listCharacters(projectId),
              relationships: store.listRelationships(projectId),
              conflicts: store.listConflicts(projectId),
              foreshadowing: store.listForeshadowing(projectId),
              clues: store.listClues(projectId),
              worldRules: store.listWorldRules(projectId),
              constraints: store.listConstraints(projectId),
              infoLayers: store.listInformationLayers(projectId),
              styleGuides: store.listStyleGuide(projectId),
            }, null, 2)
            break
          default:
            result = `未知查询类型: ${queryType}`
        }
      }

      return {
        content: [{ type: 'text', text: result }],
        details: undefined,
      }
    },
  })
}

/**
 * 创建角色状态更新工具
 *
 * 写工具：更新数据库中的角色动态状态。
 *
 * 缓存策略：
 * - 立即写入数据库 → 后续读工具可查到最新状态
 * - 不修改系统提示词（系统提示词只含静态部分）→ 前缀缓存命中
 * - 不修改章节上下文（已作为首条消息发送）→ 前缀缓存命中
 * - 返回确认信息作为 tool message 追加到对话末尾 → DYNAMIC 层
 */
export function createNovelUpdateCharacterTool(store: NovelStore): ToolDefinition<typeof UpdateCharacterParams> {
  return defineTool({
    name: 'novel_update_character',
    label: '更新角色状态',
    description:
      '更新角色的动态状态（当前状态/目标/压力/秘密/弧光阶段）。' +
      '注意：此工具只更新动态状态，不影响角色的静态设定（身份/性格/外貌/说话风格）。' +
      '更新立即生效，但不影响当前章节的系统提示词。',
    promptSnippet: '更新角色动态状态',
    parameters: UpdateCharacterParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const { characterId, ...updates } = params
      // 过滤掉 undefined 值
      const patch: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(updates)) {
        if (value !== undefined) {
          patch[key] = value
        }
      }

      const updated = store.updateCharacter(characterId, patch as Partial<import('./types.js').NovelCharacter>)
      if (!updated) {
        return {
          content: [{ type: 'text', text: `角色不存在: ${characterId}` }],
          details: undefined,
        }
      }

      return {
        content: [{ type: 'text', text: `角色 ${updated.name} 状态已更新` }],
        details: undefined,
      }
    },
  })
}

/**
 * 创建伏笔状态更新工具
 */
export function createNovelUpdateForeshadowTool(store: NovelStore): ToolDefinition<typeof UpdateForeshadowParams> {
  return defineTool({
    name: 'novel_update_foreshadow',
    label: '更新伏笔状态',
    description:
      '更新伏笔的状态（埋设/强化/揭露/回收/放弃）。' +
      '用于管理伏笔的生命周期，确保叙事债务按时回收。',
    promptSnippet: '更新伏笔状态',
    parameters: UpdateForeshadowParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const { foreshadowId, status, chapterNumber, plantMethod, recoverMethod } = params
      const patch: Record<string, unknown> = { status }
      if (plantMethod !== undefined) patch.plantMethod = plantMethod
      if (recoverMethod !== undefined) patch.recoverMethod = recoverMethod

      // 自动更新 first/last chapter
      if (chapterNumber !== undefined) {
        const existing = store.getForeshadow(foreshadowId)
        if (existing) {
          if (!existing.firstChapter && status === 'planted') {
            patch.firstChapter = chapterNumber
          }
          patch.lastChapter = chapterNumber
        }
      }

      const updated = store.updateForeshadow(foreshadowId, patch as Partial<import('./types.js').NovelForeshadow>)
      if (!updated) {
        return {
          content: [{ type: 'text', text: `伏笔不存在: ${foreshadowId}` }],
          details: undefined,
        }
      }

      return {
        content: [{ type: 'text', text: `伏笔「${updated.description}」状态已更新为: ${status}` }],
        details: undefined,
      }
    },
  })
}

/**
 * 创建冲突状态更新工具
 */
export function createNovelUpdateConflictTool(store: NovelStore): ToolDefinition<typeof UpdateConflictParams> {
  return defineTool({
    name: 'novel_update_conflict',
    label: '更新冲突状态',
    description:
      '更新冲突的阶段和强度。用于推进冲突的演变（潜伏→浮现→升级→爆发→逆转→解决/转化）。',
    promptSnippet: '更新冲突状态',
    parameters: UpdateConflictParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const { conflictId, participants, ...restUpdates } = params
      const patch: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(restUpdates)) {
        if (value !== undefined) patch[key] = value
      }
      // participants 单独处理：JSON.stringify 为 string 落库
      if (participants !== undefined) {
        patch.participants = JSON.stringify(participants)
      }

      const updated = store.updateConflict(conflictId, patch as Partial<import('./types.js').NovelConflict>)
      if (!updated) {
        return {
          content: [{ type: 'text', text: `冲突不存在: ${conflictId}` }],
          details: undefined,
        }
      }

      return {
        content: [{ type: 'text', text: `冲突「${updated.description}」已更新` }],
        details: undefined,
      }
    },
  })
}

/**
 * 创建线索进度更新工具
 */
export function createNovelUpdateClueTool(store: NovelStore): ToolDefinition<typeof UpdateClueParams> {
  return defineTool({
    name: 'novel_update_clue',
    label: '更新线索进度',
    description:
      '更新线索的进度、当前步骤和下一步。用于推进线索的揭示过程。',
    promptSnippet: '更新线索进度',
    parameters: UpdateClueParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const { clueId, ...updates } = params
      const patch: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(updates)) {
        if (value !== undefined) patch[key] = value
      }

      const updated = store.updateClue(clueId, patch as Partial<import('./types.js').NovelClue>)
      if (!updated) {
        return {
          content: [{ type: 'text', text: `线索不存在: ${clueId}` }],
          details: undefined,
        }
      }

      return {
        content: [{ type: 'text', text: `线索「${updated.description}」进度已更新: ${updated.progress}%` }],
        details: undefined,
      }
    },
  })
}

/**
 * 创建关系状态更新工具
 *
 * 写工具：更新角色间关系的动态字段（currentStage / dynamicRole / alignment / trend / chapterHint）。
 * 当传入 chapterNumber 且 currentStage 发生变化时，自动追加一条 RelationChange 到 stageHistory，
 * 让关系演变有可追溯的历史轨迹（修复四层逻辑②批评的"stageHistory 永远是 []"问题）。
 */
export function createNovelUpdateRelationshipTool(store: NovelStore): ToolDefinition<typeof UpdateRelationshipParams> {
  return defineTool({
    name: 'novel_update_relationship',
    label: '更新关系状态',
    description:
      '更新角色间关系的当前阶段与动态字段（功能位 / 阵营 / 走向 / 本章提示）。' +
      '当传入 chapterNumber 且阶段变化时，自动追加历史条目到 stageHistory。',
    promptSnippet: '更新角色关系状态',
    parameters: UpdateRelationshipParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const {
        relationshipId, currentStage, dynamicRole, alignment, trend,
        chapterHint, chapterNumber, changeReason,
      } = params

      const existing = store.getRelationship(relationshipId)
      if (!existing) {
        return {
          content: [{ type: 'text', text: `关系不存在: ${relationshipId}` }],
          details: undefined,
        }
      }

      // 构造 patch：仅传非 undefined 字段，避免覆盖未指定字段
      const patch: Partial<import('./types.js').NovelRelationship> = {}
      if (currentStage !== undefined) patch.currentStage = currentStage
      if (dynamicRole !== undefined) patch.dynamicRole = dynamicRole
      if (alignment !== undefined) patch.alignment = alignment
      if (trend !== undefined) patch.trend = trend
      if (chapterHint !== undefined) patch.chapterHint = chapterHint
      if (chapterNumber !== undefined) patch.lastUpdatedChapter = chapterNumber

      // 阶段变化 + 有章节号 → 追加 stageHistory 条目
      if (chapterNumber !== undefined && currentStage !== undefined && currentStage !== existing.currentStage) {
        const history: import('./types.js').RelationChange[] = (() => {
          try {
            const parsed = JSON.parse(existing.stageHistory)
            return Array.isArray(parsed) ? parsed : []
          } catch {
            return []
          }
        })()
        history.push({
          chapter: chapterNumber,
          fromStage: existing.currentStage,
          toStage: currentStage,
          reason: changeReason ?? '',
          timestamp: Date.now(),
        })
        patch.stageHistory = JSON.stringify(history)
      }

      const updated = store.updateRelationship(relationshipId, patch)
      if (!updated) {
        return {
          content: [{ type: 'text', text: `关系不存在: ${relationshipId}` }],
          details: undefined,
        }
      }

      const summaryParts: string[] = []
      if (currentStage !== undefined) summaryParts.push(`阶段=${currentStage}`)
      if (dynamicRole !== undefined) summaryParts.push(`功能位=${dynamicRole}`)
      if (alignment !== undefined) summaryParts.push(`阵营=${alignment}`)
      if (trend !== undefined) summaryParts.push(`走向=${trend}`)
      if (chapterHint !== undefined) summaryParts.push(`本章提示=${chapterHint}`)
      const summary = summaryParts.length > 0 ? summaryParts.join('，') : '（无字段变更）'

      return {
        content: [{ type: 'text', text: `关系 ${updated.characterA} ↔ ${updated.characterB} 已更新：${summary}` }],
        details: undefined,
      }
    },
  })
}

/**
 * 创建角色间关系工具
 *
 * 写工具：新建一对角色的关系记录，含动态字段（功能位 / 阵营 / 走向 / 本章提示）。
 */
export function createNovelCreateRelationshipTool(store: NovelStore): ToolDefinition<typeof CreateRelationshipParams> {
  return defineTool({
    name: 'novel_create_relationship',
    label: '创建角色关系',
    description:
      '在项目中创建一对角色间的关系，含动态字段（功能位 / 阵营 / 走向 / 本章提示）。' +
      '用于建立角色间的叙事连接，后续可通过 novel_update_relationship 推进演变。',
    promptSnippet: '创建角色关系',
    parameters: CreateRelationshipParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const rel = store.createRelationship({
        id: randomUUID(),
        projectId: params.projectId,
        characterA: params.characterA,
        characterB: params.characterB,
        relationType: params.relationType,
        currentStage: params.currentStage ?? '',
        stageHistory: '[]',
        dynamicRole: params.dynamicRole ?? '',
        alignment: params.alignment ?? 'neutral',
        trend: params.trend ?? 'stable',
        chapterHint: params.chapterHint ?? '',
        lastUpdatedChapter: null,
      })
      return {
        content: [{ type: 'text', text: `已创建关系 ${params.characterA} ↔ ${params.characterB}（${params.relationType}），ID: ${rel.id}` }],
        details: undefined,
      }
    },
  })
}

/**
 * 删除角色间关系工具
 */
export function createNovelDeleteRelationshipTool(store: NovelStore): ToolDefinition<typeof DeleteRelationshipParams> {
  return defineTool({
    name: 'novel_delete_relationship',
    label: '删除角色关系',
    description: '删除一对角色间的关系记录（不可恢复）。',
    promptSnippet: '删除角色关系',
    parameters: DeleteRelationshipParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const deleted = store.deleteRelationship(params.relationshipId)
      if (!deleted) {
        return {
          content: [{ type: 'text', text: `关系不存在: ${params.relationshipId}` }],
          details: undefined,
        }
      }
      return {
        content: [{ type: 'text', text: `已删除关系: ${params.relationshipId}` }],
        details: undefined,
      }
    },
  })
}

/**
 * 创建角色工具
 *
 * 写工具：在项目中创建一个新角色，包含静态设定和动态状态。
 *
 * 缓存策略：
 * - 立即写入数据库 → 后续读工具可查到最新状态
 * - 不修改系统提示词和章节上下文 → 前缀缓存命中
 * - 返回确认信息作为 tool message 追加到对话末尾 → DYNAMIC 层
 */
export function createNovelCreateCharacterTool(store: NovelStore): ToolDefinition<typeof CreateCharacterParams> {
  return defineTool({
    name: 'novel_create_character',
    label: '创建角色',
    description:
      '在小说项目中创建一个新角色，包含静态设定（身份/性格/外貌/说话风格）和动态状态（当前状态/目标/压力/秘密/弧光阶段）。' +
      '创建后立即生效，但不影响当前章节的系统提示词。',
    promptSnippet: '创建新角色',
    parameters: CreateCharacterParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const character = store.createCharacter({
        id: randomUUID(),
        projectId: params.projectId,
        name: params.name,
        description: params.description ?? '',
        identity: params.identity ?? '',
        personality: params.personality ?? '',
        appearance: params.appearance ?? '',
        currentState: params.currentState ?? '',
        currentGoal: params.currentGoal ?? '',
        currentPressure: params.currentPressure ?? '',
        secret: params.secret ?? '',
        arcStage: params.arcStage ?? 'introduction',
        arcHistory: '[]',
        speechStyle: params.speechStyle ?? '',
        isProtagonist: false,
        // 四层逻辑补全字段（缺省值与数据库默认一致）
        longTermDesire: params.longTermDesire ?? '',
        plotRole: params.plotRole ?? 'supporting',
        removalImpact: params.removalImpact ?? '',
      })
      return {
        content: [{ type: 'text', text: `已创建角色「${params.name}」，ID: ${character.id}` }],
        details: undefined,
      }
    },
  })
}

/**
 * 创建伏笔工具
 *
 * 写工具：在项目中创建一个新伏笔，初始状态为 planned。
 */
export function createNovelCreateForeshadowTool(store: NovelStore): ToolDefinition<typeof CreateForeshadowParams> {
  return defineTool({
    name: 'novel_create_foreshadow',
    label: '创建伏笔',
    description:
      '仅为重要暗线或重大揭示创建伏笔，并明确隐藏问题与计划回收。' +
      '普通疑点/证据应创建线索，即时危险应创建冲突，章末吸引力属于钩子；默认不要创建伏笔。',
    promptSnippet: '创建新伏笔',
    parameters: CreateForeshadowParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      if (!isAdmissibleNewForeshadow(params)) {
        return {
          content: [{
            type: 'text',
            text: '未创建伏笔：必须是重要或关键的暗线/重大揭示节点，并提供明确的隐藏问题与计划回收。普通疑点请改用 novel_create_clue。',
          }],
          details: undefined,
        }
      }
      const foreshadow = store.createForeshadow({
        id: randomUUID(),
        projectId: params.projectId,
        description: params.description,
        category: params.category ?? 'event',
        status: 'planned',
        firstChapter: null,
        lastChapter: null,
        recoverByChapter: params.recoverByChapter ?? null,
        plantMethod: params.plantMethod,
        recoverMethod: params.recoverMethod,
        // 迁移 055：未指定 firstChapter 时 chapterSpans 为 []（进元素池，矩阵不渲染行）
        chapterSpans: [],
      })
      return {
        content: [{ type: 'text', text: `已创建伏笔「${params.description}」，ID: ${foreshadow.id}` }],
        details: undefined,
      }
    },
  })
}

/**
 * 创建冲突工具
 *
 * 写工具：在项目中创建一个新冲突，初始阶段默认为 latent。
 */
export function createNovelCreateConflictTool(store: NovelStore): ToolDefinition<typeof CreateConflictParams> {
  return defineTool({
    name: 'novel_create_conflict',
    label: '创建冲突',
    description:
      '在小说项目中创建一个新冲突，包含类型、强度、阶段和参与方。' +
      '用于建立故事张力，后续可通过 novel_update_conflict 推进演变。',
    promptSnippet: '创建新冲突',
    parameters: CreateConflictParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const conflict = store.createConflict({
        id: randomUUID(),
        projectId: params.projectId,
        description: params.description,
        type: params.type ?? 'interest',
        intensity: params.intensity ?? 5,
        stage: params.stage ?? 'latent',
        participants: JSON.stringify(params.participants ?? []),
        chapterSpans: [],
        tier: 'secondary',
        plotFunction: params.plotFunction,
        progressionMode: params.progressionMode,
      })
      return {
        content: [{ type: 'text', text: `已创建冲突「${params.description}」，ID: ${conflict.id}` }],
        details: undefined,
      }
    },
  })
}

/**
 * 创建线索工具
 *
 * 写工具：在项目中创建一个新线索，初始进度默认为 0。
 */
export function createNovelCreateClueTool(store: NovelStore): ToolDefinition<typeof CreateClueParams> {
  return defineTool({
    name: 'novel_create_clue',
    label: '创建线索',
    description:
      '在小说项目中创建一个新线索，包含指向、进度、步骤和是否误导。' +
      '用于推进真相揭示，后续可通过 novel_update_clue 更新进度。',
    promptSnippet: '创建新线索',
    parameters: CreateClueParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const clue = store.createClue({
        id: randomUUID(),
        projectId: params.projectId,
        description: params.description,
        pointsTo: params.pointsTo,
        progress: params.progress ?? 0,
        currentStep: params.currentStep ?? '',
        nextStep: params.nextStep ?? '',
        isMisleading: params.isMisleading ?? false,
        chapterSpans: [],
      })
      return {
        content: [{ type: 'text', text: `已创建线索「${params.description}」，ID: ${clue.id}` }],
        details: undefined,
      }
    },
  })
}

// ── 势力工具 ──

/** 查询项目下所有势力 */
export function createNovelQueryFactionsTool(store: NovelStore): ToolDefinition<typeof QueryFactionsParams> {
  return defineTool({
    name: 'novel_query_factions',
    label: '查询势力',
    description:
      '查询小说项目下的所有势力（组织/门派/王国/家族/公会/邪教）。' +
      '包含势力的类型、首领、理念、实力、盟友/敌人列表和当前状态。此工具只读不写。',
    promptSnippet: '查询势力列表',
    parameters: QueryFactionsParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const factions = store.listFactions(params.projectId)
      return {
        content: [{ type: 'text', text: JSON.stringify(factions, null, 2) }],
        details: undefined,
      }
    },
  })
}

/** 创建势力 */
export function createNovelCreateFactionTool(store: NovelStore): ToolDefinition<typeof CreateFactionParams> {
  return defineTool({
    name: 'novel_create_faction',
    label: '创建势力',
    description:
      '在小说项目中创建一个新势力，包含类型、首领、理念、实力、资源、盟友/敌人列表。' +
      '用于建立故事中的阵营结构，后续可通过 novel_update_faction 推进演变。',
    promptSnippet: '创建新势力',
    parameters: CreateFactionParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const faction = store.createFaction({
        id: randomUUID(),
        projectId: params.projectId,
        name: params.name,
        description: params.description ?? '',
        type: params.type ?? 'organization',
        leaderId: params.leaderId ?? null,
        ideology: params.ideology ?? '',
        strength: params.strength ?? 'medium',
        resources: params.resources ?? [],
        allies: params.allies ?? [],
        enemies: params.enemies ?? [],
        status: params.status ?? 'active',
        chapterSpans: [],
      })
      return {
        content: [{ type: 'text', text: `已创建势力「${params.name}」，ID: ${faction.id}` }],
        details: undefined,
      }
    },
  })
}

/** 更新势力 */
export function createNovelUpdateFactionTool(store: NovelStore): ToolDefinition<typeof UpdateFactionParams> {
  return defineTool({
    name: 'novel_update_faction',
    label: '更新势力',
    description:
      '更新势力的属性，包括类型、首领、理念、实力、资源、盟友/敌人列表和状态。' +
      '用于推进势力的演变（如实力变化、盟友反目、势力覆灭）。',
    promptSnippet: '更新势力属性',
    parameters: UpdateFactionParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const { factionId, ...updates } = params
      const patch: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(updates)) {
        if (value !== undefined) patch[key] = value
      }
      const updated = store.updateFaction(factionId, patch as Partial<import('./types.js').NovelFaction>)
      if (!updated) {
        return {
          content: [{ type: 'text', text: `势力不存在: ${factionId}` }],
          details: undefined,
        }
      }
      return {
        content: [{ type: 'text', text: `势力「${updated.name}」已更新` }],
        details: undefined,
      }
    },
  })
}

// ── 地点工具 ──

/** 查询项目下所有地点 */
export function createNovelQueryLocationsTool(store: NovelStore): ToolDefinition<typeof QueryLocationsParams> {
  return defineTool({
    name: 'novel_query_locations',
    label: '查询地点',
    description:
      '查询小说项目下的所有地点（大陆/国家/城市/建筑/地下城/区域/荒野）。' +
      '包含地点的类型、父级地点、归属势力、重要程度和状态。此工具只读不写。',
    promptSnippet: '查询地点列表',
    parameters: QueryLocationsParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const locations = store.listLocations(params.projectId)
      return {
        content: [{ type: 'text', text: JSON.stringify(locations, null, 2) }],
        details: undefined,
      }
    },
  })
}

/** 创建地点 */
export function createNovelCreateLocationTool(store: NovelStore): ToolDefinition<typeof CreateLocationParams> {
  return defineTool({
    name: 'novel_create_location',
    label: '创建地点',
    description:
      '在小说项目中创建一个新地点，包含类型、父级地点、归属势力、重要程度。' +
      '用于构建故事地图的层级结构，后续可通过 novel_update_location 更新。',
    promptSnippet: '创建新地点',
    parameters: CreateLocationParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const location = store.createLocation({
        id: randomUUID(),
        projectId: params.projectId,
        name: params.name,
        description: params.description ?? '',
        type: params.type ?? 'city',
        parentId: params.parentId ?? null,
        factionId: params.factionId ?? null,
        significance: params.significance ?? 'minor',
        firstChapter: params.firstChapter ?? null,
        status: params.status ?? 'normal',
        appearChapters: [],
      })
      return {
        content: [{ type: 'text', text: `已创建地点「${params.name}」，ID: ${location.id}` }],
        details: undefined,
      }
    },
  })
}

/** 更新地点 */
export function createNovelUpdateLocationTool(store: NovelStore): ToolDefinition<typeof UpdateLocationParams> {
  return defineTool({
    name: 'novel_update_location',
    label: '更新地点',
    description:
      '更新地点的属性，包括类型、父级地点、归属势力、重要程度和状态。' +
      '用于推进地点的演变（如归属势力易主、地点被毁、重要程度提升）。',
    promptSnippet: '更新地点属性',
    parameters: UpdateLocationParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const { locationId, ...updates } = params
      const patch: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(updates)) {
        if (value !== undefined) patch[key] = value
      }
      const updated = store.updateLocation(locationId, patch as Partial<import('./types.js').NovelLocation>)
      if (!updated) {
        return {
          content: [{ type: 'text', text: `地点不存在: ${locationId}` }],
          details: undefined,
        }
      }
      return {
        content: [{ type: 'text', text: `地点「${updated.name}」已更新` }],
        details: undefined,
      }
    },
  })
}

// ── 物品工具 ──

/** 查询项目下所有物品（或按持有者过滤） */
export function createNovelQueryItemsTool(store: NovelStore): ToolDefinition<typeof QueryItemsParams> {
  return defineTool({
    name: 'novel_query_items',
    label: '查询物品',
    description:
      '查询小说项目下的所有物品（武器/防具/法宝/消耗品/关键道具/材料/情报物品/杂物）。' +
      '包含物品的类型、持有者、状态、能力、来源和首次出现章节。传 ownerId 可按持有者过滤。此工具只读不写。',
    promptSnippet: '查询物品列表',
    parameters: QueryItemsParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const items = params.ownerId
        ? store.listItemsByOwner(params.ownerId)
        : store.listItems(params.projectId)
      return {
        content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
        details: undefined,
      }
    },
  })
}

/** 创建物品 */
export function createNovelCreateItemTool(store: NovelStore): ToolDefinition<typeof CreateItemParams> {
  return defineTool({
    name: 'novel_create_item',
    label: '创建物品',
    description:
      '在小说项目中创建一个新物品，包含类型、持有者、状态、能力、来源。' +
      '用于追踪角色拥有的关键道具（武器/法宝/钥匙/信物/线索物品等），后续可通过 novel_update_item 推进演变（转手/丢失/封印/损毁）。',
    promptSnippet: '创建新物品',
    parameters: CreateItemParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const item = store.createItem({
        id: randomUUID(),
        projectId: params.projectId,
        name: params.name,
        description: params.description ?? '',
        type: params.type ?? 'misc',
        ownerId: params.ownerId && params.ownerId.trim() ? params.ownerId : null,
        status: params.status ?? 'active',
        abilities: params.abilities ?? '',
        origin: params.origin ?? '',
        firstChapter: params.firstChapter ?? null,
        chapterSpans: [],
      })
      return {
        content: [{ type: 'text', text: `已创建物品「${params.name}」，ID: ${item.id}` }],
        details: undefined,
      }
    },
  })
}

/** 更新物品 */
export function createNovelUpdateItemTool(store: NovelStore): ToolDefinition<typeof UpdateItemParams> {
  return defineTool({
    name: 'novel_update_item',
    label: '更新物品',
    description:
      '更新物品的属性，包括名称、类型、持有者、状态、能力、来源。' +
      '用于推进物品的演变（如转手给新角色、丢失、封印、损毁、升级转化）。' +
      '当物品转手时，必须同步更新 ownerId 和 status=transferred。',
    promptSnippet: '更新物品属性',
    parameters: UpdateItemParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const { itemId, ...updates } = params
      const patch: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(updates)) {
        if (value !== undefined) {
          // ownerId 传空字符串 → 视为变更为无主
          if (key === 'ownerId' && value === '') {
            patch[key] = null
          } else {
            patch[key] = value
          }
        }
      }
      const updated = store.updateItem(itemId, patch as Partial<import('./types.js').NovelItem>)
      if (!updated) {
        return {
          content: [{ type: 'text', text: `物品不存在: ${itemId}` }],
          details: undefined,
        }
      }
      return {
        content: [{ type: 'text', text: `物品「${updated.name}」已更新` }],
        details: undefined,
      }
    },
  })
}

/** 删除物品 */
export function createNovelDeleteItemTool(store: NovelStore): ToolDefinition<typeof DeleteItemParams> {
  return defineTool({
    name: 'novel_delete_item',
    label: '删除物品',
    description:
      '删除小说项目中的物品。仅用于物品创建错误或剧情上彻底不再需要的物品；' +
      '正常演变（丢失/封印/损毁）请使用 novel_update_item 更新 status 字段。',
    promptSnippet: '删除物品',
    parameters: DeleteItemParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const deleted = store.deleteItem(params.itemId)
      return {
        content: [{ type: 'text', text: deleted ? `物品已删除: ${params.itemId}` : `物品不存在: ${params.itemId}` }],
        details: undefined,
      }
    },
  })
}

// ── 世界观要素工具 ──

/** 创建世界观要素 */
export function createNovelCreateWorldElementTool(store: NovelStore): ToolDefinition<typeof CreateWorldElementParams> {
  return defineTool({
    name: 'novel_create_world_element',
    label: '创建世界观要素',
    description:
      '在小说项目中创建一个结构化的世界观要素，分类包括力量体系/历史/文化/宗教/科技/经济/地理。' +
      '支持层级结构（parentId）和自由属性（attributes）。',
    promptSnippet: '创建世界观要素',
    parameters: CreateWorldElementParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const element = store.createWorldElement({
        id: randomUUID(),
        projectId: params.projectId,
        category: params.category,
        name: params.name,
        description: params.description ?? '',
        parentId: params.parentId ?? null,
        attributes: params.attributes ?? {},
      })
      return {
        content: [{ type: 'text', text: `已创建世界观要素「${params.name}」，ID: ${element.id}` }],
        details: undefined,
      }
    },
  })
}

/** 更新世界观要素 */
export function createNovelUpdateWorldElementTool(store: NovelStore): ToolDefinition<typeof UpdateWorldElementParams> {
  return defineTool({
    name: 'novel_update_world_element',
    label: '更新世界观要素',
    description:
      '更新世界观要素的属性，包括分类、名称、描述、父级要素和附加属性。' +
      '用于推进世界观设定的演化。',
    promptSnippet: '更新世界观要素',
    parameters: UpdateWorldElementParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const { worldElementId, ...updates } = params
      const patch: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(updates)) {
        if (value !== undefined) patch[key] = value
      }
      const updated = store.updateWorldElement(worldElementId, patch as Partial<import('./types.js').NovelWorldElement>)
      if (!updated) {
        return {
          content: [{ type: 'text', text: `世界观要素不存在: ${worldElementId}` }],
          details: undefined,
        }
      }
      return {
        content: [{ type: 'text', text: `世界观要素「${updated.name}」已更新` }],
        details: undefined,
      }
    },
  })
}

/**
 * 修订草稿持有者
 *
 * 由 orchestrator 在调用 Reviser 前创建，通过闭包传递给 novel_apply_revision 工具。
 * 工具每次被调用时，对 draft.content 做精确字符串替换并记录结果。
 * Reviser 结束后，orchestrator 读取 draft.content 作为最终正文。
 *
 * 设计动机：
 * 旧方案让 Reviser 输出"原文/修改后"配对文本，再由 applySafeRevision 用正则解析。
 * 当 LLM 不严格遵守格式时，正则解析失败会走 full 兜底，把"修改意见"当作完整正文落库。
 * 新方案通过工具协议化输入：LLM 必须调用工具才能修改正文，工具参数 schema 强制结构化，
 * 工具内部用 String.replace 做精确替换，完全绕开自然语言解析。
 */
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
    description: '给 Writer 看的完整叙事任务文本。包含本章核心目标、情节点、约束说明等，Writer 会基于此创作正文。',
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
      const task: NarrativeTask = {
        description: params.narrativeTask,
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
  review?: Omit<NovelChapterReview, 'id' | 'projectId' | 'chapterId' | 'reviewedBy' | 'createdAt'>
  /** Reviewer 的原始自然语言输出（推理过程等），用于审计和回退展示。 */
  rawOutput?: string
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
      const review: Omit<NovelChapterReview, 'id' | 'projectId' | 'chapterId' | 'reviewedBy' | 'createdAt'> = {
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

      const issuesCount = params.issues?.length ?? 0
      const suggestionsCount = params.suggestions?.length ?? 0
      const summary = `验收报告已提交：\n` +
        `- 结论：${params.verdict}\n` +
        `- 总体评分：${params.overallScore ?? '（未提供）'}\n` +
        `- 十维评分：一致性=${params.consistencyScore ?? '-'}/角色=${params.characterScore ?? '-'}/任务=${params.taskCompletionScore ?? '-'}/线索=${params.clueProgressScore ?? '-'}/伏笔=${params.foreshadowStatusScore ?? '-'}/冲突=${params.conflictChangeScore ?? '-'}/节奏=${params.pacingScore ?? '-'}/信息=${params.infoControlScore ?? '-'}/钩子=${params.readerHookScore ?? '-'}/文风=${params.styleScore ?? '-'}\n` +
        `- 问题数：${issuesCount}\n` +
        `- 建议数：${suggestionsCount}`

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
export function createNovelTools(
  store: NovelStore,
  memoryStore?: NovelMemoryStore,
  boundaryProvider?: ChapterBoundaryProvider,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    // A+B：语义化查询工具，优先放在列表前面便于 prompt cache 稳定
    createNovelAskStoryTool(store, memoryStore, boundaryProvider),
    createNovelQueryStateTool(store, boundaryProvider),
    createNovelUpdateCharacterTool(store),
    createNovelUpdateForeshadowTool(store),
    createNovelUpdateConflictTool(store),
    createNovelUpdateClueTool(store),
    createNovelUpdateRelationshipTool(store),
    // 创建类工具
    createNovelCreateCharacterTool(store),
    createNovelCreateForeshadowTool(store),
    createNovelCreateConflictTool(store),
    createNovelCreateClueTool(store),
    createNovelCreateRelationshipTool(store),
    // 删除类工具
    createNovelDeleteRelationshipTool(store),
    // 势力/地点/世界观要素工具
    createNovelQueryFactionsTool(store),
    createNovelCreateFactionTool(store),
    createNovelUpdateFactionTool(store),
    createNovelQueryLocationsTool(store),
    createNovelCreateLocationTool(store),
    createNovelUpdateLocationTool(store),
    // 物品工具
    createNovelQueryItemsTool(store),
    createNovelCreateItemTool(store),
    createNovelUpdateItemTool(store),
    createNovelDeleteItemTool(store),
    createNovelCreateWorldElementTool(store),
    createNovelUpdateWorldElementTool(store),
  ]
  // 按工具名排序，确保 tools schema 顺序稳定，最大化 prompt cache 命中率
  return tools.sort((a, b) => a.name.localeCompare(b.name))
}
