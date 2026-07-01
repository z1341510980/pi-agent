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

import { randomUUID } from 'node:crypto'
import type { PluginContext } from '../../../core/plugin/plugin-types.js'
import type { NovelPromptBuilder } from './prompt-builder.js'
import type { PromptManager } from './prompt-manager.js'
import type { NovelCharacterGenerator } from './novel-character-generator.js'
import type { NovelStore } from './novel-store.js'
import type {
  ArrangedEntity,
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

/**
 * 提取 ```json ... ``` 代码块内容。
 * 处理 LLM 输出被 token 截断导致代码块未闭合的情况：
 * 1. 先尝试匹配完整闭合的代码块
 * 2. 若无闭合标记，提取 ```json 之后的所有内容（截断场景）
 * 3. 无代码块标记时返回原文
 */
function extractJsonBlock(text: string): string {
  // 完整闭合的代码块
  const closed = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (closed) return closed[1].trim()

  // 未闭合的代码块（token 截断）：提取 ```json 之后的所有内容
  const unclosed = text.match(/```(?:json)?\s*([\s\S]*)/)
  if (unclosed) return unclosed[1].trim()

  return text.trim()
}

/**
 * 尝试解析 JSON，处理 LLM 输出截断导致的 JSON 不完整。
 * 策略：
 * 1. 直接 JSON.parse
 * 2. 失败则尝试截尾补全：找到最后一个完整的键值对结尾（逗号或引号后），截断后补 }
 * 3. 仍然失败返回 null
 */
function repairAndParseJson(text: string): Record<string, unknown> | null {
  const jsonStr = extractJsonBlock(text)

  // 1. 直接解析
  try {
    return JSON.parse(jsonStr) as Record<string, unknown>
  } catch {
    // 继续
  }

  // 2. 截尾补全：逐步回退，尝试在合理位置截断后补 }
  // 移除末尾不完整的部分（非闭合的引号、逗号、冒号等）
  let truncated = jsonStr
  for (let i = 0; i < 5; i++) {
    // 尝试在最后一个逗号、引号、} 或 ] 后截断
    const lastValid = Math.max(
      truncated.lastIndexOf(','),
      truncated.lastIndexOf('"'),
      truncated.lastIndexOf('}'),
      truncated.lastIndexOf(']'),
    )
    if (lastValid <= 0) break
    truncated = truncated.slice(0, lastValid + 1)
    // 移除末尾多余的逗号
    truncated = truncated.replace(/,\s*$/, '')
    // 统计未闭合的括号
    const opens = (truncated.match(/[{\[]/g) ?? []).length
    const closes = (truncated.match(/[}\]]/g) ?? []).length
    const needClose = opens - closes
    if (needClose <= 0) continue
    // 补全闭合括号
    let repaired = truncated
    // 先补 ] 再补 }（数组在对象内时需要先闭数组）
    const closeChars: string[] = []
    // 简单策略：按需补 }
    for (let j = 0; j < needClose; j++) closeChars.push('}')
    repaired += closeChars.join('')
    try {
      return JSON.parse(repaired) as Record<string, unknown>
    } catch {
      // 继续回退
    }
  }

  return null
}

// ── 主类 ──

export class NovelEntityGenerator {
  constructor(
    private promptBuilder: NovelPromptBuilder,
    private promptManager: PromptManager,
    private context: PluginContext,
    private characterGenerator: NovelCharacterGenerator,
    private store: NovelStore,
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
      responseFormat: 'json',
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

  /**
   * 按章纲批量生成实体并自动编排到本章列，返回编排结果供后续 create-flow 注入。
   *
   * 不在此方法内调 orchestrator（由路由层在同一 SSE 流内衔接 createChapterWithFlow）。
   * 仅依赖 store（落库）+ generate（调 LLM 生成字段）。
   */
  async generateAndArrange(
    projectId: string,
    chapterNumber: number,
    outline: string,
    onProgress?: (event: { phase: string; message: string; data?: unknown }) => void,
  ): Promise<ArrangedEntity> {
    onProgress?.({ phase: 'analyzing', message: '分析章纲，规划所需实体...' })

    const plan = await this.planEntitiesFromOutline(projectId, outline)
    onProgress?.({
      phase: 'planned',
      message: `规划：${plan.characters.length} 角色 / ${plan.conflicts.length} 冲突 / ${plan.foreshadows.length} 伏笔`,
      data: plan,
    })

    const characterIds: string[] = []
    const conflictIds: string[] = []
    const foreshadowIds: string[] = []

    try {
      for (const spec of plan.characters) {
        onProgress?.({ phase: 'generating', message: `生成角色：${spec.coreStyle}` })
        const gen = await this.generate(projectId, 'character', spec.coreStyle, onProgress)
        if (gen.type !== 'character') continue
        const created = this.store.createCharacter({
          id: randomUUID(),
          projectId,
          name: gen.data.name,
          description: gen.data.description,
          identity: gen.data.identity,
          personality: gen.data.personality,
          appearance: gen.data.appearance,
          currentState: gen.data.currentState,
          currentGoal: gen.data.currentGoal,
          currentPressure: gen.data.currentPressure,
          secret: gen.data.secret,
          arcStage: gen.data.arcStage,
          arcHistory: '[]',
          speechStyle: gen.data.speechStyle,
          isProtagonist: false,
        })
        characterIds.push(created.id)
        this.store.createCharacterHistory({
          projectId,
          characterId: created.id,
          chapterId: null,
          chapterNumber,
          fieldName: 'currentState',
          oldValue: null,
          newValue: '本章首次出场',
          reason: `AI编排：${outline.slice(0, 50)}`,
        })
      }

      for (const spec of plan.conflicts) {
        onProgress?.({ phase: 'generating', message: `生成冲突：${spec.coreStyle}` })
        const gen = await this.generate(projectId, 'conflict', spec.coreStyle, onProgress)
        if (gen.type !== 'conflict') continue
        const created = this.store.createConflict({
          id: randomUUID(),
          projectId,
          description: gen.data.description,
          type: gen.data.type,
          intensity: gen.data.intensity,
          stage: gen.data.stage,
          participants: gen.data.participants,
          firstChapter: chapterNumber,
          lastChapter: null,
          tier: gen.data.tier,
        })
        conflictIds.push(created.id)
      }

      for (const spec of plan.foreshadows) {
        onProgress?.({ phase: 'generating', message: `生成伏笔：${spec.coreStyle}` })
        const gen = await this.generate(projectId, 'foreshadow', spec.coreStyle, onProgress)
        if (gen.type !== 'foreshadow') continue
        const created = this.store.createForeshadow({
          id: randomUUID(),
          projectId,
          description: gen.data.description,
          category: gen.data.category,
          status: gen.data.status,
          firstChapter: chapterNumber,
          lastChapter: null,
          recoverByChapter: null,
          linkedCharacters: gen.data.linkedCharacters,
          linkedClues: gen.data.linkedClues,
        })
        foreshadowIds.push(created.id)
      }
    } catch (err) {
      // 反向顺序 best-effort 清理已落库实体，避免半编排脏数据污染后续 create-flow
      for (const id of foreshadowIds) {
        try {
          this.store.deleteForeshadow(id)
        } catch { /* best-effort 清理，忽略单个删除失败 */ }
      }
      for (const id of conflictIds) {
        try {
          this.store.deleteConflict(id)
        } catch { /* best-effort 清理，忽略单个删除失败 */ }
      }
      for (const id of characterIds) {
        try {
          this.store.deleteCharacterHistoryByCharacter(id)
          this.store.deleteCharacter(id)
        } catch { /* best-effort 清理，忽略单个删除失败 */ }
      }
      const rolledBack = characterIds.length + conflictIds.length + foreshadowIds.length
      this.context.logger.error(
        {
          err,
          created: {
            characters: characterIds.length,
            conflicts: conflictIds.length,
            foreshadows: foreshadowIds.length,
          },
        },
        `generateAndArrange 失败，已回滚 ${rolledBack} 个实体`,
      )
      throw err
    }

    onProgress?.({ phase: 'arranged', message: '编排完成，准备生成正文' })
    return { characterIds, conflictIds, foreshadowIds }
  }

  /**
   * 调用 LLM 解析章纲，产出待生成实体的 coreStyle 清单。
   *
   * 复用 extractJsonBlock / ensureString 工具函数解析返回。
   * 使用 promptStream（与 generate 一致）以保持 Session API 调用模式统一。
   */
  private async planEntitiesFromOutline(
    projectId: string,
    outline: string,
  ): Promise<{
    characters: { coreStyle: string }[]
    conflicts: { coreStyle: string }[]
    foreshadows: { coreStyle: string }[]
  }> {
    const systemPrompt = this.promptBuilder.buildSystemPrompt(projectId, 'character-generator')
    const userPrompt = [
      '你是小说实体规划助手。根据以下章纲，规划本章需要哪些实体（只列本章新引入的）。',
      '返回严格 JSON，格式：',
      '{"characters":[{"coreStyle":"一句话描述"}],"conflicts":[{"coreStyle":"..."}],"foreshadows":[{"coreStyle":"..."}]}',
      '',
      '章纲：',
      outline,
    ].join('\n')

    const session = await this.context.createSession({
      systemPrompt,
      userMessage: userPrompt,
      responseFormat: 'json',
    })

    try {
      let result = ''
      const full = await session.promptStream((delta) => {
        result += delta
      })
      // 优先使用流式累积结果，回退到 promptStream 返回值
      const text = result || full
      let json: Record<string, unknown> | null
      json = repairAndParseJson(text)
      if (!json) {
        this.context.logger.warn(
          { rawTextPreview: text.slice(0, 200) },
          'planEntitiesFromOutline JSON 解析失败（可能被截断），使用空 plan 兜底',
        )
        return { characters: [], conflicts: [], foreshadows: [] }
      }
      return {
        characters: Array.isArray(json.characters)
          ? json.characters
              .map((c: unknown) => ({ coreStyle: ensureString((c as { coreStyle?: unknown })?.coreStyle, '新角色') }))
          : [],
        conflicts: Array.isArray(json.conflicts)
          ? json.conflicts
              .map((c: unknown) => ({ coreStyle: ensureString((c as { coreStyle?: unknown })?.coreStyle, '新冲突') }))
          : [],
        foreshadows: Array.isArray(json.foreshadows)
          ? json.foreshadows
              .map((f: unknown) => ({ coreStyle: ensureString((f as { coreStyle?: unknown })?.coreStyle, '新伏笔') }))
          : [],
      }
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
    const parsed = repairAndParseJson(text)
    if (parsed) {
      try {
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
          `解析 LLM 返回的 ${this.kindLabel(kind)} 字段失败，回退到模板`,
        )
      }
    } else {
      this.context.logger.warn(
        { kind, textPreview: text.slice(0, 200) },
        `解析 LLM 返回的 ${this.kindLabel(kind)} JSON 失败（可能被截断），回退到模板`,
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
