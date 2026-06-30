/**
 * NovelEntityGenerator：通用 AI 实体生成器
 *
 * 与 NovelCharacterGenerator 平行存在，支持 6 种实体类型：
 * character / conflict / foreshadow / faction / location / world_element
 *
 * 设计要点：
 * - character 分支委托给 NovelCharacterGenerator（复用已有 prompt 与解析逻辑）
 * - 其余 5 类各自构建 prompt + 解析 JSON
 * - 返回字段不落库，由前端 review 后调 createXxx 落库
 * - 通过 PluginContext.createSession 创建独立 Pi Session，与主聊天隔离
 */

import type { PluginContext } from '../../../core/plugin/plugin-types.js'
import type { NovelPromptBuilder } from './prompt-builder.js'
import type { PromptManager } from './prompt-manager.js'
import type { NovelCharacterGenerator } from './novel-character-generator.js'
import type {
  NovelCharacter,
  NovelConflict,
  NovelForeshadow,
  NovelFaction,
  NovelLocation,
  NovelWorldElement,
} from './types.js'

// ── 生成结果类型 ──

/** character 生成结果（与 NovelCharacterGenerator.GeneratedCharacter 一致） */
export type GeneratedCharacter = Pick<
  NovelCharacter,
  'name' | 'description' | 'identity' | 'personality' | 'appearance'
  | 'currentState' | 'currentGoal' | 'currentPressure' | 'secret'
  | 'arcStage' | 'speechStyle'
>

export type GeneratedConflict = Pick<
  NovelConflict,
  'description' | 'type' | 'intensity' | 'stage' | 'tier' | 'participants'
>

export type GeneratedForeshadow = Pick<
  NovelForeshadow,
  'description' | 'category' | 'status' | 'linkedCharacters' | 'linkedClues'
>

export type GeneratedFaction = Pick<
  NovelFaction,
  'name' | 'description' | 'type' | 'ideology' | 'strength' | 'resources' | 'allies' | 'enemies' | 'status'
>

export type GeneratedLocation = Pick<
  NovelLocation,
  'name' | 'description' | 'type' | 'significance' | 'status'
>

export type GeneratedWorldElement = Pick<
  NovelWorldElement,
  'category' | 'name' | 'description' | 'attributes'
>

/** 所有实体类型的生成结果联合（按 entityType 区分） */
export type GeneratedEntity =
  | { type: 'character'; data: GeneratedCharacter }
  | { type: 'conflict'; data: GeneratedConflict }
  | { type: 'foreshadow'; data: GeneratedForeshadow }
  | { type: 'faction'; data: GeneratedFaction }
  | { type: 'location'; data: GeneratedLocation }
  | { type: 'world_element'; data: GeneratedWorldElement }

export type EntityKind = 'character' | 'conflict' | 'foreshadow' | 'faction' | 'location' | 'world_element'

/** 进度事件（与 CharacterGenerationProgressEvent 对齐） */
export interface EntityGenerationProgressEvent {
  phase: 'preparing' | 'generating' | 'parsing' | 'completed' | 'fallback'
  message: string
  data?: unknown
}

// ── 工具函数 ──

/** 将任意 LLM 输出值安全转为 string */
function ensureString(value: unknown, defaultValue: string): string {
  if (typeof value === 'string') return value
  if (value == null) return defaultValue
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** 将任意 LLM 输出值安全转为 string[] */
function ensureStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => ensureString(v, '')).filter((s) => s.length > 0)
  if (typeof value === 'string' && value.trim()) {
    return value.split(/[,，]/).map((s) => s.trim()).filter((s) => s.length > 0)
  }
  return []
}

/** 将任意 LLM 输出值安全转为 number */
function ensureNumber(value: unknown, defaultValue: number, min?: number, max?: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return defaultValue
  let r = n
  if (min != null && r < min) r = min
  if (max != null && r > max) r = max
  return r
}

/** 提取 ```json ... ``` 代码块 */
function extractJsonBlock(text: string): string {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  return m ? m[1] : text
}

// ── 主类 ──

export class NovelEntityGenerator {
  constructor(
    private promptBuilder: NovelPromptBuilder,
    private promptManager: PromptManager,
    private context: PluginContext,
    private characterGenerator: NovelCharacterGenerator,
  ) {}

  /**
   * 生成实体字段（不落库）
   *
   * @param projectId 项目 ID
   * @param entityType 实体类型
   * @param coreStyle 用户输入的核心风格描述（如 "沉默寡言的剑客" 或 "林墨与苏晚的信任危机"）
   * @param onProgress 进度回调
   * @returns 生成结果（按 entityType 区分 data 字段）
   */
  async generate(
    projectId: string,
    entityType: EntityKind,
    coreStyle: string,
    onProgress?: (event: EntityGenerationProgressEvent) => void,
  ): Promise<GeneratedEntity> {
    // character 委托给现有 generator（保持 prompt 一致性）
    if (entityType === 'character') {
      const data = await this.characterGenerator.generate(projectId, coreStyle, onProgress)
      return { type: 'character', data }
    }

    // 其余 5 类走通用流程
    onProgress?.({ phase: 'preparing', message: `正在构建${this.kindLabel(entityType)}生成提示词...` })
    const systemPrompt = this.promptBuilder.buildSystemPrompt(projectId, 'character-generator')
    const userPrompt = this.buildUserPrompt(entityType, coreStyle)

    onProgress?.({ phase: 'generating', message: `AI 正在生成${this.kindLabel(entityType)}设定...` })
    const session = await this.context.createSession({
      systemPrompt,
      userMessage: userPrompt,
    })

    try {
      let streamedText = ''
      const result = await session.promptStream((delta) => {
        streamedText += delta
        const partial = streamedText.slice(-200)
        onProgress?.({
          phase: 'generating',
          message: `AI 正在生成${this.kindLabel(entityType)}设定...`,
          data: { partial },
        })
      })

      onProgress?.({ phase: 'parsing', message: '正在解析生成结果...', data: { resultLength: result.length } })
      const data = this.parseResult(entityType, result, coreStyle)
      onProgress?.({ phase: 'completed', message: `${this.kindLabel(entityType)}生成完成` })
      return { type: entityType, data } as GeneratedEntity
    } catch (err) {
      this.context.logger.error(
        { projectId, entityType, coreStylePreview: coreStyle.slice(0, 80), err },
        `${this.kindLabel(entityType)}生成 LLM 调用失败，回退到模板`,
      )
      onProgress?.({ phase: 'fallback', message: 'AI 生成失败，使用模板兜底...' })
      const data = this.buildTemplate(entityType, coreStyle)
      return { type: entityType, data } as GeneratedEntity
    } finally {
      session.dispose()
    }
  }

  // ── 私有方法 ──

  private kindLabel(kind: EntityKind): string {
    return {
      character: '角色',
      conflict: '冲突',
      foreshadow: '伏笔',
      faction: '势力',
      location: '地点',
      world_element: '世界要素',
    }[kind]
  }

  private buildUserPrompt(kind: EntityKind, coreStyle: string): string {
    const builders: Record<Exclude<EntityKind, 'character'>, () => string> = {
      conflict: () => [
        '请根据以下核心描述，生成一个完整的冲突设定。',
        '',
        '【核心描述】',
        coreStyle,
        '',
        '【输出要求】',
        '请返回 JSON 格式，包含以下字段：',
        '- description: 冲突的一句话描述',
        '- type: 冲突类型，从以下枚举中选择一个：inner/relationship/faction/interest/moral/identity/emotional/world_rule/survival',
        '- intensity: 冲突强度，1-10 的整数',
        '- stage: 冲突当前阶段，从以下枚举中选择一个：latent/emerging/escalating/erupting/reversing/resolved/transformed',
        '- tier: 冲突层级，从以下枚举中选择一个：main/secondary/goal',
        '- participants: 参与者描述（字符串，可包含多个参与者，用逗号分隔）',
      ].join('\n'),
      foreshadow: () => [
        '请根据以下核心描述，生成一个完整的伏笔设定。',
        '',
        '【核心描述】',
        coreStyle,
        '',
        '【输出要求】',
        '请返回 JSON 格式，包含以下字段：',
        '- description: 伏笔的一句话描述',
        '- category: 伏笔类别（如：物品/言语/事件/身份/秘密/预言）',
        '- status: 伏笔当前状态，从以下枚举中选择一个：planned/planted/reinforced/partially_revealed/recovering/recovered/abandoned',
        '- linkedCharacters: 关联角色描述（字符串，可多个，逗号分隔）',
        '- linkedClues: 关联线索描述（字符串，可多个，逗号分隔）',
      ].join('\n'),
      faction: () => [
        '请根据以下核心描述，生成一个完整的势力设定。',
        '',
        '【核心描述】',
        coreStyle,
        '',
        '【输出要求】',
        '请返回 JSON 格式，包含以下字段：',
        '- name: 势力名称',
        '- description: 势力一句话描述',
        '- type: 势力类型，从以下枚举中选择一个：organization/sect/kingdom/family/guild/cult',
        '- ideology: 势力理念/信条',
        '- strength: 势力实力，从以下枚举中选择一个：weak/medium/strong/overwhelming',
        '- resources: 势力资源（字符串数组，每项一种关键资源）',
        '- allies: 盟友描述（字符串数组，每项一个盟友势力名）',
        '- enemies: 敌对描述（字符串数组，每项一个敌对势力名）',
        '- status: 势力状态，从以下枚举中选择一个：active/declined/destroyed/hidden',
      ].join('\n'),
      location: () => [
        '请根据以下核心描述，生成一个完整的地点设定。',
        '',
        '【核心描述】',
        coreStyle,
        '',
        '【输出要求】',
        '请返回 JSON 格式，包含以下字段：',
        '- name: 地点名称',
        '- description: 地点一句话描述',
        '- type: 地点类型，从以下枚举中选择一个：continent/country/city/building/dungeon/region/wilderness',
        '- significance: 地点重要性，从以下枚举中选择一个：minor/moderate/major/critical',
        '- status: 地点状态，从以下枚举中选择一个：normal/destroyed/changed/hidden',
      ].join('\n'),
      world_element: () => [
        '请根据以下核心描述，生成一个完整的世界要素设定。',
        '',
        '【核心描述】',
        coreStyle,
        '',
        '【输出要求】',
        '请返回 JSON 格式，包含以下字段：',
        '- category: 要素类别，从以下枚举中选择一个：power_system/history/culture/religion/technology/economy/geography',
        '- name: 要素名称',
        '- description: 要素一句话描述',
        '- attributes: 要素属性（对象，键值对形式，如 { "key": "value" }）',
      ].join('\n'),
    }
    return builders[kind as Exclude<EntityKind, 'character'>]()
  }

  private parseResult(kind: EntityKind, text: string, coreStyle: string): GeneratedEntity['data'] {
    const jsonStr = extractJsonBlock(text)
    try {
      const parsed = JSON.parse(jsonStr.trim()) as Record<string, unknown>
      switch (kind) {
        case 'conflict':
          return this.parseConflict(parsed)
        case 'foreshadow':
          return this.parseForeshadow(parsed)
        case 'faction':
          return this.parseFaction(parsed)
        case 'location':
          return this.parseLocation(parsed)
        case 'world_element':
          return this.parseWorldElement(parsed)
        default:
          throw new Error(`Unsupported kind: ${kind}`)
      }
    } catch (err) {
      this.context.logger.warn(
        { err, kind, textPreview: text.slice(0, 200) },
        `解析 LLM 返回的 ${this.kindLabel(kind)} JSON 失败，回退到模板`,
      )
      return this.buildTemplate(kind, coreStyle) as GeneratedEntity['data']
    }
  }

  private parseConflict(p: Record<string, unknown>): GeneratedConflict {
    const validTypes = ['inner', 'relationship', 'faction', 'interest', 'moral', 'identity', 'emotional', 'world_rule', 'survival']
    const validStages = ['latent', 'emerging', 'escalating', 'erupting', 'reversing', 'resolved', 'transformed']
    const validTiers = ['main', 'secondary', 'goal']
    return {
      description: ensureString(p.description, ''),
      type: (validTypes.includes(p.type as string) ? p.type : 'relationship') as NovelConflict['type'],
      intensity: ensureNumber(p.intensity, 5, 1, 10),
      stage: (validStages.includes(p.stage as string) ? p.stage : 'emerging') as NovelConflict['stage'],
      tier: (validTiers.includes(p.tier as string) ? p.tier : 'secondary') as NovelConflict['tier'],
      participants: ensureString(p.participants, ''),
    }
  }

  private parseForeshadow(p: Record<string, unknown>): GeneratedForeshadow {
    const validStatus = ['planned', 'planted', 'reinforced', 'partially_revealed', 'recovering', 'recovered', 'abandoned']
    return {
      description: ensureString(p.description, ''),
      category: ensureString(p.category, '物品'),
      status: (validStatus.includes(p.status as string) ? p.status : 'planted') as NovelForeshadow['status'],
      linkedCharacters: ensureString(p.linkedCharacters, ''),
      linkedClues: ensureString(p.linkedClues, ''),
    }
  }

  private parseFaction(p: Record<string, unknown>): GeneratedFaction {
    const validTypes = ['organization', 'sect', 'kingdom', 'family', 'guild', 'cult']
    const validStrength = ['weak', 'medium', 'strong', 'overwhelming']
    const validStatus = ['active', 'declined', 'destroyed', 'hidden']
    return {
      name: ensureString(p.name, '未命名势力'),
      description: ensureString(p.description, ''),
      type: (validTypes.includes(p.type as string) ? p.type : 'organization') as NovelFaction['type'],
      ideology: ensureString(p.ideology, ''),
      strength: (validStrength.includes(p.strength as string) ? p.strength : 'medium') as NovelFaction['strength'],
      resources: ensureStringArray(p.resources),
      allies: ensureStringArray(p.allies),
      enemies: ensureStringArray(p.enemies),
      status: (validStatus.includes(p.status as string) ? p.status : 'active') as NovelFaction['status'],
    }
  }

  private parseLocation(p: Record<string, unknown>): GeneratedLocation {
    const validTypes = ['continent', 'country', 'city', 'building', 'dungeon', 'region', 'wilderness']
    const validSignificance = ['minor', 'moderate', 'major', 'critical']
    const validStatus = ['normal', 'destroyed', 'changed', 'hidden']
    return {
      name: ensureString(p.name, '未命名地点'),
      description: ensureString(p.description, ''),
      type: (validTypes.includes(p.type as string) ? p.type : 'region') as NovelLocation['type'],
      significance: (validSignificance.includes(p.significance as string) ? p.significance : 'moderate') as NovelLocation['significance'],
      status: (validStatus.includes(p.status as string) ? p.status : 'normal') as NovelLocation['status'],
    }
  }

  private parseWorldElement(p: Record<string, unknown>): GeneratedWorldElement {
    const validCategories = ['power_system', 'history', 'culture', 'religion', 'technology', 'economy', 'geography']
    const attributes = ((): Record<string, unknown> => {
      if (p.attributes && typeof p.attributes === 'object' && !Array.isArray(p.attributes)) {
        return p.attributes as Record<string, unknown>
      }
      return {}
    })()
    return {
      category: (validCategories.includes(p.category as string) ? p.category : 'history') as NovelWorldElement['category'],
      name: ensureString(p.name, '未命名要素'),
      description: ensureString(p.description, ''),
      attributes,
    }
  }

  // ── 模板兜底（LLM 失败时） ──

  private buildTemplate(kind: EntityKind, coreStyle: string): Omit<GeneratedEntity, 'type'>['data'] {
    const trimmed = coreStyle.trim()
    switch (kind) {
      case 'conflict':
        return {
          description: trimmed || '未命名冲突',
          type: 'relationship',
          intensity: 5,
          stage: 'emerging',
          tier: 'secondary',
          participants: '',
        }
      case 'foreshadow':
        return {
          description: trimmed || '未命名伏笔',
          category: '物品',
          status: 'planned',
          linkedCharacters: '',
          linkedClues: '',
        }
      case 'faction': {
        const seed = trimmed.slice(0, 4).replace(/[^\u4e00-\u9fa5a-zA-Z]/g, '')
        return {
          name: seed.length >= 2 ? `${seed}（待定）` : '未命名势力',
          description: `基于"${trimmed.slice(0, 30)}"生成的占位势力`,
          type: 'organization',
          ideology: '',
          strength: 'medium',
          resources: [],
          allies: [],
          enemies: [],
          status: 'active',
        }
      }
      case 'location': {
        const seed = trimmed.slice(0, 4).replace(/[^\u4e00-\u9fa5a-zA-Z]/g, '')
        return {
          name: seed.length >= 2 ? `${seed}（待定）` : '未命名地点',
          description: `基于"${trimmed.slice(0, 30)}"生成的占位地点`,
          type: 'region',
          significance: 'moderate',
          status: 'normal',
        }
      }
      case 'world_element':
        return {
          category: 'history',
          name: trimmed.slice(0, 12) || '未命名要素',
          description: `基于"${trimmed.slice(0, 30)}"生成的占位世界要素`,
          attributes: {},
        }
      default:
        throw new Error(`Unsupported template kind: ${kind}`)
    }
  }
}
