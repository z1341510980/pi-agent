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
 *    - 只包含静态数据（世界规则、风格、角色定义的静态部分）
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
})

const UpdateClueParams = Type.Object({
  clueId: Type.String({ description: '线索 ID' }),
  progress: Type.Optional(Type.Number({ minimum: 0, maximum: 100, description: '进度 0-100' })),
  currentStep: Type.Optional(Type.String({ description: '当前步骤' })),
  nextStep: Type.Optional(Type.String({ description: '下一步' })),
})

const UpdateRelationshipParams = Type.Object({
  relationshipId: Type.String({ description: '关系 ID' }),
  currentStage: Type.String({ description: '新阶段' }),
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
})

const CreateForeshadowParams = Type.Object({
  projectId: Type.String({ description: '项目 ID' }),
  description: Type.String({ description: '伏笔描述' }),
  category: Type.Optional(Type.String({ description: '类别（物品/身份/事件/承诺/台词...）' })),
  recoverByChapter: Type.Optional(Type.Number({ description: '应在第几章前回收' })),
  linkedCharacters: Type.Optional(Type.Array(Type.String(), { description: '关联角色 ID 列表' })),
  linkedClues: Type.Optional(Type.Array(Type.String(), { description: '关联线索 ID 列表' })),
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
      const { foreshadowId, status, chapterNumber } = params
      const patch: Record<string, unknown> = { status }

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
      const { conflictId, ...updates } = params
      const patch: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(updates)) {
        if (value !== undefined) patch[key] = value
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
 */
export function createNovelUpdateRelationshipTool(store: NovelStore): ToolDefinition<typeof UpdateRelationshipParams> {
  return defineTool({
    name: 'novel_update_relationship',
    label: '更新关系状态',
    description:
      '更新角色间关系的当前阶段。用于推进关系的演变。',
    promptSnippet: '更新角色关系状态',
    parameters: UpdateRelationshipParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const { relationshipId, currentStage } = params
      const updated = store.updateRelationship(relationshipId, { currentStage })

      if (!updated) {
        return {
          content: [{ type: 'text', text: `关系不存在: ${relationshipId}` }],
          details: undefined,
        }
      }

      return {
        content: [{ type: 'text', text: `关系 ${updated.characterA} ↔ ${updated.characterB} 阶段已更新为: ${currentStage}` }],
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
  ]
  // 按工具名排序，确保 tools schema 顺序稳定，最大化 prompt cache 命中率
  return tools.sort((a, b) => a.name.localeCompare(b.name))
}
