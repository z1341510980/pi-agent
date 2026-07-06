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

// ── 工具创建函数 ──

/**
 * 创建小说状态查询工具
 *
 * 读工具：查询数据库最新状态，结果作为 tool message 追加到对话末尾。
 * 不影响系统提示词和章节上下文 → 前缀缓存命中。
 */
export function createNovelQueryStateTool(store: NovelStore): ToolDefinition<typeof QueryStateParams> {
  return defineTool({
    name: 'novel_query_state',
    label: '查询故事状态',
    description:
      '查询小说的当前故事状态，包括角色、关系、冲突、伏笔、线索、世界规则等。' +
      '用于在创作过程中获取最新状态信息。此工具只读不写，不影响缓存。',
    promptSnippet: '查询小说故事状态',
    parameters: QueryStateParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const { projectId, queryType } = params
      let result: string

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

      const updated = store.updateCharacter(characterId, patch as any)
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

      const updated = store.updateForeshadow(foreshadowId, patch as any)
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

      const updated = store.updateConflict(conflictId, patch as any)
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

      const updated = store.updateClue(clueId, patch as any)
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
      '在小说项目中创建一个新伏笔，包含描述、类别、回收章节和关联实体。' +
      '用于埋设叙事债务，后续可通过 novel_update_foreshadow 管理其生命周期。',
    promptSnippet: '创建新伏笔',
    parameters: CreateForeshadowParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const foreshadow = store.createForeshadow({
        id: randomUUID(),
        projectId: params.projectId,
        description: params.description,
        category: params.category ?? 'event',
        status: 'planned',
        firstChapter: null,
        lastChapter: null,
        recoverByChapter: params.recoverByChapter ?? null,
        linkedCharacters: JSON.stringify(params.linkedCharacters ?? []),
        linkedClues: JSON.stringify(params.linkedClues ?? []),
        plantMethod: params.plantMethod,
        recoverMethod: params.recoverMethod,
        linkedInfoLayers: '[]',
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
        linkedForeshadow: params.linkedForeshadow ?? null,
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
      const updated = store.updateFaction(factionId, patch as any)
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
      const updated = store.updateLocation(locationId, patch as any)
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
      const updated = store.updateWorldElement(worldElementId, patch as any)
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
 * 获取所有小说工具
 *
 * 用于注入到 Pi SDK session 的 customTools 参数。
 */
export function createNovelTools(store: NovelStore): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createNovelQueryStateTool(store),
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
    createNovelCreateWorldElementTool(store),
    createNovelUpdateWorldElementTool(store),
  ]
  // 按工具名排序，确保 tools schema 顺序稳定，最大化 prompt cache 命中率
  return tools.sort((a, b) => a.name.localeCompare(b.name))
}
