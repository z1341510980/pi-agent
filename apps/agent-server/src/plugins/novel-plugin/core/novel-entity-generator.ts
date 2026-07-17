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
import {
  FORESHADOW_ADMISSION_PROMPT,
  isAdmissibleNewForeshadow,
  selectAdmissibleNewForeshadows,
  type ForeshadowAdmissionFields,
} from './foreshadow-policy.js'
import {
  addLlmUsage,
  extractLlmUsageFromMessage,
  hasLlmUsage,
  type LlmUsageSnapshot,
} from './agent-run-utils.js'
import type {
  ArrangedEntity,
  CharacterFunctionEntry,
  PlotFunction,
  ChapterSpan,
  NovelAgentLogStatus,
  NovelCharacter,
  NovelConflict,
  NovelForeshadow,
  NovelFaction,
  NovelLocation,
  NovelWorldElement,
} from './types.js'

type EntityPlan = {
  characters: Array<{ coreStyle: string; plotFunction?: PlotFunction; functionNote?: string }>
  conflicts: { coreStyle: string }[]
  foreshadows: Array<{ coreStyle: string; chapterAction?: unknown } & ForeshadowAdmissionFields>
  factions: { coreStyle: string }[]
  locations: { coreStyle: string }[]
}

type EntityPlanLogContext = {
  systemPrompt: string
  userMessage: string
  rawResult: string
  status: 'success' | 'error'
  error: string
  usage?: LlmUsageSnapshot
}

type EntityPlanResult = {
  plan: EntityPlan
  logContext: EntityPlanLogContext
}

type BatchPlanSpec = { coreStyle: string }

type BatchGenerationRun = {
  generated: Map<object, GeneratedEntity>
  itemCount: number
  batchCount: number
  retryCount: number
  fallbackCount: number
  unbatchedGenerationCount: number
  usage?: LlmUsageSnapshot
}

type BatchRequestItem = {
  index: number
  coreStyle: string
}

type BatchRequestResult = {
  generated: Map<number, GeneratedEntity>
  failedIndexes: number[]
  usage?: LlmUsageSnapshot
}

// ── 生成结果类型 ──

/** character 生成结果（与 NovelCharacterGenerator.GeneratedCharacter 一致） */
export type GeneratedCharacter = Pick<
  NovelCharacter,
  'name' | 'description' | 'identity' | 'personality' | 'appearance'
  | 'currentState' | 'currentGoal' | 'currentPressure' | 'secret'
  | 'arcStage' | 'speechStyle'
  | 'longTermDesire' | 'plotRole' | 'removalImpact'
>

export type GeneratedConflict = Pick<
  NovelConflict,
  'description' | 'type' | 'intensity' | 'stage' | 'tier' | 'participants'
  | 'climaxChapter' | 'climaxType' | 'stakes' | 'twistPotential'
  | 'plotFunction' | 'progressionMode'
>

export type GeneratedForeshadow = Pick<
  NovelForeshadow,
  'description' | 'category' | 'status' | 'linkedCharacters' | 'linkedClues'
  | 'plantMethod' | 'recoverMethod'
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

/** 解析并执行新伏笔准入门槛；已有伏笔复用不受“新增一条”上限影响。 */
export function normalizePlannedForeshadows(
  value: unknown,
): Array<{ coreStyle: string; chapterAction?: unknown } & ForeshadowAdmissionFields> {
  if (!Array.isArray(value)) return []
  const rawForeshadows = value.map((f: unknown) => {
    const obj = f as Record<string, unknown>
    return {
      coreStyle: ensureString(obj?.coreStyle, '新伏笔'),
      importance: obj?.importance,
      narrativeRole: obj?.narrativeRole,
      hiddenQuestion: obj?.hiddenQuestion,
      plannedPayoff: obj?.plannedPayoff,
      chapterAction: obj?.chapterAction,
    }
  })
  const validChapterActions = new Set(['plant', 'reinforce', 'reveal', 'payoff'])
  const existing = rawForeshadows.filter((f) =>
    f.coreStyle.trim().startsWith('已有：')
    && isAdmissibleNewForeshadow(f)
    && validChapterActions.has(String(f.chapterAction)),
  )
  const created = selectAdmissibleNewForeshadows(
    rawForeshadows.filter((f) => !f.coreStyle.trim().startsWith('已有：')),
  )
  return [...existing, ...created]
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
    signal?: AbortSignal,
  ): Promise<GeneratedEntity> {
    // character 委托给现有 generator（保持 prompt 一致性）
    if (entityType === 'character') {
      const data = await this.characterGenerator.generate(projectId, coreStyle, onProgress, signal)
      return { type: 'character', data }
    }

    // 其余 5 类走通用流程
    onProgress?.({ phase: 'preparing', message: `正在构建${this.kindLabel(entityType)}生成提示词...` })
    const systemPrompt = this.promptBuilder.buildSystemPrompt(projectId, 'character-generator')
    // 身份段注入 userMessage 开头（systemPrompt 不含身份段，以跨 Agent 共享 system 缓存）
    const userPrompt = this.promptBuilder.buildAgentIdentity(projectId, 'character-generator')
      + '\n\n---\n\n' + this.buildUserPrompt(entityType, coreStyle)

    onProgress?.({ phase: 'generating', message: `AI 正在生成${this.kindLabel(entityType)}设定...` })
    // 复用 novel-director 在 AgentPage 配置的 model（规划类任务角色定位最接近），
    // 未配置则走默认 Provider。
    const directorModel = this.context.subagentManager?.getAgent('novel-director')?.model
    const session = await this.context.createSession({
      systemPrompt,
      userMessage: userPrompt,
      responseFormat: 'json',
      modelId: directorModel,
      // 实体生成（冲突/伏笔/势力/地点/世界要素）涉及详细设定，LLM 耗时较长；
      // 默认 120s 不足，提到 300s 与 Memory Agent 一致
      timeoutMs: 300_000,
      signal,
    })

    try {
      let streamedText = ''
      let lastEmitTs = 0
      const result = await session.promptStream((delta) => {
        streamedText += delta
        // 节流：每 500ms 最多发一次进度，避免 token 级回调导致 SSE 事件洪泛
        const now = Date.now()
        if (now - lastEmitTs < 500) return
        lastEmitTs = now
        const partial = streamedText.slice(-200)
        onProgress?.({
          phase: 'generating',
          message: `AI 正在生成${this.kindLabel(entityType)}设定...`,
          data: { partial },
        })
      })

      onProgress?.({ phase: 'parsing', message: '正在解析生成结果...', data: { resultLength: result.length } })
      const data = this.parseResult(entityType, result, coreStyle, projectId)
      onProgress?.({ phase: 'completed', message: `${this.kindLabel(entityType)}生成完成` })
      return { type: entityType, data } as GeneratedEntity
    } catch (err) {
      if (signal?.aborted) throw err
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
   * 按章纲批量生成实体并自动编排到本章列。
   *
   * 不在此方法内调 orchestrator。编排只负责矩阵落库，正文生成由 create-flow 单独触发。
   */
  /**
   * 解析 LLM 返回的 coreStyle，判断是否指向已有实体。
   *
   * 提示词要求 LLM 在复用已有实体时写 "已有：<名字>"。
   * 返回值：
   *   - { mode: 'existing', name } → 命中已有实体，按名查重执行 upsert
   *   - { mode: 'new', coreStyle } → 全新实体，按原流程 create
   */
  private parseExistingHint(coreStyle: string): { mode: 'existing'; name: string } | { mode: 'new'; coreStyle: string } {
    // 兼容中英文冒号与"已有"/"复用"等多种写法
    const match = coreStyle.match(/^(?:已有|复用|existing)\s*[:：]\s*(.+)$/i)
    if (match) {
      const name = match[1].trim()
      if (name) return { mode: 'existing', name }
    }
    return { mode: 'new', coreStyle }
  }

  async generateAndArrange(
    projectId: string,
    chapterNumber: number,
    outline: string,
    onProgress?: (event: { phase: string; message: string; data?: unknown; detail?: Record<string, unknown> }) => void,
    source: 'outline' | 'content' = 'outline',
    signal?: AbortSignal,
  ): Promise<ArrangedEntity> {
    signal?.throwIfAborted()
    // ── 编排日志采集变量 ──
    // 与 runAgent 的日志写入模式对齐：startTime / logStatus / logError / logResult
    const startTime = Date.now()
    let logStatus: NovelAgentLogStatus = 'success'
    let logError = ''
    /** 规划阶段的 LLM 调用上下文（systemPrompt / userMessage / rawResult），由 planEntitiesFromOutline 返回 */
    let planLogContext: EntityPlanLogContext | null = null

    const isReverse = source === 'content'
    onProgress?.({ phase: 'analyzing', message: isReverse ? '分析正文，反推本章实体...' : '分析章纲，规划所需实体...' })

    const { plan, logContext } = await this.planEntitiesFromOutline(projectId, chapterNumber, outline, onProgress, source, signal)
    planLogContext = logContext
    const planningErrorMessage = logContext.status === 'error'
      ? (logContext.error || 'AI 实体规划失败')
      : ''
    const clueIds = this.store.listClues(projectId)
      .filter((clue) => clue.chapterSpans.some(
        ([start, end]) => chapterNumber >= start && chapterNumber <= end,
      ))
      .map((clue) => clue.id)

    onProgress?.({
      phase: 'planned',
      message: `规划：${plan.characters.length} 角色 / ${plan.conflicts.length} 冲突 / ${plan.foreshadows.length} 伏笔 / ${plan.factions.length} 势力 / ${plan.locations.length} 地点`,
      data: plan,
      // 携带 detail 用于前端展示规划清单气泡
      detail: {
        kind: 'arrange_plan',
        characters: plan.characters.map((s) => s.coreStyle),
        conflicts: plan.conflicts.map((s) => s.coreStyle),
        foreshadows: plan.foreshadows.map((s) => s.coreStyle),
        factions: plan.factions.map((s) => s.coreStyle),
        locations: plan.locations.map((s) => s.coreStyle),
      },
    })

    const characterIds: string[] = []
    const conflictIds: string[] = []
    const foreshadowIds: string[] = []
    const factionIds: string[] = []
    const locationIds: string[] = []
    const createdCharacterIds: string[] = []
    const createdConflictIds: string[] = []
    const createdForeshadowIds: string[] = []
    const createdFactionIds: string[] = []
    const createdLocationIds: string[] = []
    const rollbackActions: Array<() => void> = []
    /** 本章角色功能位编排（与新角色一一对应） */
    const characterFunctions: CharacterFunctionEntry[] = []
    // 收集已生成实体的描述，供 arranged 阶段详情事件使用
    const generatedCharacters: Array<{ name: string; description: string; plotFunction?: PlotFunction; functionNote?: string }> = []
    const generatedConflicts: Array<{ description: string; intensity: number; tier: string; climaxChapter?: number | null; climaxType?: string | null }> = []
    const generatedForeshadows: Array<{ description: string; category: string }> = []
    const generatedFactions: Array<{ name: string; type: string }> = []
    const generatedLocations: Array<{ name: string; type: string }> = []
    let batchGeneration: BatchGenerationRun = {
      generated: new Map(),
      itemCount: 0,
      batchCount: 0,
      retryCount: 0,
      fallbackCount: 0,
      unbatchedGenerationCount: 0,
    }

    try {
      if (planningErrorMessage) {
        throw new Error(planningErrorMessage)
      }

      batchGeneration = await this.generatePlanInBatches(projectId, plan, onProgress, signal)
      const resolveGenerated = async (
        spec: BatchPlanSpec,
        kind: EntityKind,
        coreStyle = spec.coreStyle,
      ): Promise<GeneratedEntity> => {
        const batched = batchGeneration.generated.get(spec)
        if (batched) return batched

        // 仅“已有：X”未命中项目数据时会走到这里。这类项无法提前判断，单独生成并在日志中标记。
        batchGeneration.unbatchedGenerationCount += 1
        return this.generate(projectId, kind, coreStyle, onProgress, signal)
      }

      // 预拉一次已有角色清单（按名查重），避免循环内重复查询
      // 注意：循环内 createCharacter 后需要把新角色也加入此 map，避免后续重复创建同名角色
      const existingCharacterByName = new Map<string, NovelCharacter>()
      for (const c of this.store.listCharacters(projectId)) {
        existingCharacterByName.set(c.name, c)
      }

      for (const spec of plan.characters) {
        signal?.throwIfAborted()
        const hint = this.parseExistingHint(spec.coreStyle)

        // 命中"已有：X"标记 → 优先按名查重，找到则不创建，仅追加 history 标记本章出场
        // 状态字段（currentState 等）由 create-flow 阶段的 Memory Agent 推进，编排阶段不覆盖
        if (hint.mode === 'existing') {
          const existing = existingCharacterByName.get(hint.name)
          if (existing) {
            onProgress?.({ phase: 'generating', message: `复用已有角色：${existing.name}` })
            const history = this.store.createCharacterHistory({
              projectId,
              characterId: existing.id,
              chapterId: null,
              chapterNumber,
              fieldName: 'currentState',
              oldValue: existing.currentState ?? null,
              newValue: `AI再编排：本章出场（状态保留）`,
              reason: `AI再编排：复用已有角色「${existing.name}」，${outline.slice(0, 50)}`,
            })
            rollbackActions.push(() => { this.store.deleteCharacterHistory(history.id, projectId) })
            this.context.logger.info(
              { projectId, chapterNumber, characterId: existing.id, name: existing.name },
              'generateAndArrange：复用已有角色，追加 history',
            )
            characterIds.push(existing.id)
            if (spec.plotFunction) {
              characterFunctions.push({ characterId: existing.id, function: spec.plotFunction, note: spec.functionNote })
            }
            generatedCharacters.push({
              name: existing.name,
              description: existing.description,
              plotFunction: spec.plotFunction,
              functionNote: spec.functionNote,
            })
            continue
          }
          // LLM 标注"已有：X"但项目里没找到 → 降级为新建，用 hint.name 作为 coreStyle
          onProgress?.({ phase: 'generating', message: `未找到已有角色「${hint.name}」，按新建处理...` })
          const gen = await resolveGenerated(spec, 'character', hint.name)
          if (gen.type !== 'character') continue
          await this.processNewCharacter(gen.data, projectId, chapterNumber, outline, existingCharacterByName, characterIds, createdCharacterIds, characterFunctions, generatedCharacters, spec)
          continue
        }

        // 新角色：保持原有 create 流程
        onProgress?.({ phase: 'generating', message: `生成角色：${spec.coreStyle}` })
        const gen = await resolveGenerated(spec, 'character')
        if (gen.type !== 'character') continue

        // 二次查重：LLM 可能仍生成与已有角色同名的"新角色"（即使提示词要求标注"已有"）
        const dup = existingCharacterByName.get(gen.data.name)
        if (dup) {
          onProgress?.({ phase: 'generating', message: `检测到同名角色「${gen.data.name}」，合并为已有实体` })
          const history = this.store.createCharacterHistory({
            projectId,
            characterId: dup.id,
            chapterId: null,
            chapterNumber,
            fieldName: 'currentState',
            oldValue: dup.currentState ?? null,
            newValue: gen.data.currentState ?? '本章再次出场',
            reason: `AI再编排：LLM 生成同名角色，按更新处理，${outline.slice(0, 50)}`,
          })
          rollbackActions.push(() => { this.store.deleteCharacterHistory(history.id, projectId) })
          characterIds.push(dup.id)
          if (spec.plotFunction) {
            characterFunctions.push({ characterId: dup.id, function: spec.plotFunction, note: spec.functionNote })
          }
          generatedCharacters.push({
            name: dup.name,
            description: dup.description,
            plotFunction: spec.plotFunction,
            functionNote: spec.functionNote,
          })
          continue
        }

        await this.processNewCharacter(gen.data, projectId, chapterNumber, outline, existingCharacterByName, characterIds, createdCharacterIds, characterFunctions, generatedCharacters, spec)
      }

      // ── 冲突：按描述模糊匹配已有实体 ──
      // 冲突没有独立 name 字段，用 description 前 40 字做模糊匹配
      const existingConflictByDesc = new Map<string, NovelConflict>()
      for (const c of this.store.listConflicts(projectId)) {
        existingConflictByDesc.set(c.description.slice(0, 40), c)
      }

      for (const spec of plan.conflicts) {
        signal?.throwIfAborted()
        const hint = this.parseExistingHint(spec.coreStyle)
        // "已有：xxx" → 尝试按描述前缀匹配
        if (hint.mode === 'existing') {
          const existing = existingConflictByDesc.get(hint.name.slice(0, 40))
            ?? [...existingConflictByDesc.values()].find((c) => c.description.includes(hint.name))
          if (existing) {
            onProgress?.({ phase: 'generating', message: `复用已有冲突：${existing.description.slice(0, 30)}` })
            // 扩展 chapterSpans 包含本章（如尚未包含）
            const spans = existing.chapterSpans ?? []
            const alreadyCovers = spans.some(([s, e]) => chapterNumber >= s && chapterNumber <= e)
            if (!alreadyCovers) {
              const mergedSpans: ChapterSpan[] = [...spans, [chapterNumber, chapterNumber] as ChapterSpan]
              rollbackActions.push(() => { this.store.updateConflict(existing.id, { chapterSpans: existing.chapterSpans }) })
              this.store.updateConflict(existing.id, { chapterSpans: mergedSpans })
            }
            conflictIds.push(existing.id)
            generatedConflicts.push({
              description: existing.description,
              intensity: existing.intensity,
              tier: existing.tier,
              climaxChapter: existing.climaxChapter,
              climaxType: existing.climaxType,
            })
            continue
          }
        }

        // 新冲突
        onProgress?.({ phase: 'generating', message: `生成冲突：${spec.coreStyle}` })
        const gen = await resolveGenerated(spec, 'conflict')
        if (gen.type !== 'conflict') continue
        // 二次查重
        const dupKey = gen.data.description.slice(0, 40)
        const dup = existingConflictByDesc.get(dupKey)
        if (dup) {
          onProgress?.({ phase: 'generating', message: `检测到相似冲突，合并为已有实体` })
          const spans = dup.chapterSpans ?? []
          const alreadyCovers = spans.some(([s, e]) => chapterNumber >= s && chapterNumber <= e)
          if (!alreadyCovers) {
            const mergedSpans: ChapterSpan[] = [...spans, [chapterNumber, chapterNumber] as ChapterSpan]
            rollbackActions.push(() => { this.store.updateConflict(dup.id, { chapterSpans: dup.chapterSpans }) })
            this.store.updateConflict(dup.id, { chapterSpans: mergedSpans })
          }
          conflictIds.push(dup.id)
          generatedConflicts.push({
            description: dup.description,
            intensity: dup.intensity,
            tier: dup.tier,
            climaxChapter: dup.climaxChapter,
            climaxType: dup.climaxType,
          })
          continue
        }
        const created = this.store.createConflict({
          id: randomUUID(),
          projectId,
          description: gen.data.description,
          type: gen.data.type,
          intensity: gen.data.intensity,
          stage: gen.data.stage,
          participants: gen.data.participants,
          chapterSpans: [[chapterNumber, chapterNumber]],
          tier: gen.data.tier,
          climaxChapter: gen.data.climaxChapter,
          climaxType: gen.data.climaxType,
          stakes: gen.data.stakes,
          twistPotential: gen.data.twistPotential,
          plotFunction: gen.data.plotFunction,
          progressionMode: gen.data.progressionMode,
        })
        existingConflictByDesc.set(created.description.slice(0, 40), created)
        conflictIds.push(created.id)
        createdConflictIds.push(created.id)
        generatedConflicts.push({
          description: created.description,
          intensity: created.intensity,
          tier: created.tier,
          climaxChapter: created.climaxChapter,
          climaxType: created.climaxType,
        })
      }

      // ── 伏笔：按描述模糊匹配已有实体 ──
      const existingForeshadowByDesc = new Map<string, NovelForeshadow>()
      for (const f of this.store.listForeshadowing(projectId)) {
        existingForeshadowByDesc.set(f.description.slice(0, 40), f)
      }

      for (const spec of plan.foreshadows) {
        signal?.throwIfAborted()
        const hint = this.parseExistingHint(spec.coreStyle)
        if (hint.mode === 'existing') {
          const existing = existingForeshadowByDesc.get(hint.name.slice(0, 40))
            ?? [...existingForeshadowByDesc.values()].find((f) => f.description.includes(hint.name))
          if (existing) {
            onProgress?.({ phase: 'generating', message: `复用已有伏笔：${existing.description.slice(0, 30)}` })
            // 复用已有伏笔时只为尚未埋设的旧数据补 plant；后续节点由 Memory Agent
            // 根据正文明确记录，不能把“本章复用”自动解释为连续活跃区间。
            const patch: Partial<NovelForeshadow> = { lastChapter: chapterNumber }
            if (!(existing.beats ?? []).some((beat) => beat.type === 'plant')) {
              patch.beats = [...(existing.beats ?? []), { chapter: chapterNumber, type: 'plant' }]
            }
            rollbackActions.push(() => {
              this.store.updateForeshadow(existing.id, {
                firstChapter: existing.firstChapter,
                lastChapter: existing.lastChapter,
                chapterSpans: existing.chapterSpans,
                beats: existing.beats,
              })
            })
            const updated = this.store.updateForeshadow(existing.id, patch) ?? existing
            // 同步内存 map，避免后续同名合并分支拿到旧数据
            existingForeshadowByDesc.set(existing.description.slice(0, 40), updated)
            foreshadowIds.push(existing.id)
            generatedForeshadows.push({ description: existing.description, category: existing.category })
            continue
          }
        }

        onProgress?.({ phase: 'generating', message: `生成伏笔：${spec.coreStyle}` })
        const gen = await resolveGenerated(spec, 'foreshadow')
        if (gen.type !== 'foreshadow') continue
        const dupKey = gen.data.description.slice(0, 40)
        const dup = existingForeshadowByDesc.get(dupKey)
        if (dup) {
          onProgress?.({ phase: 'generating', message: `检测到相似伏笔，合并为已有实体` })
          // 同上：只补首次 plant，不构造连续 chapterSpans。
          const patch: Partial<NovelForeshadow> = { lastChapter: chapterNumber }
          if (!(dup.beats ?? []).some((beat) => beat.type === 'plant')) {
            patch.beats = [...(dup.beats ?? []), { chapter: chapterNumber, type: 'plant' }]
          }
          rollbackActions.push(() => {
            this.store.updateForeshadow(dup.id, {
              firstChapter: dup.firstChapter,
              lastChapter: dup.lastChapter,
              chapterSpans: dup.chapterSpans,
              beats: dup.beats,
            })
          })
          const updated = this.store.updateForeshadow(dup.id, patch) ?? dup
          existingForeshadowByDesc.set(dupKey, updated)
          foreshadowIds.push(dup.id)
          generatedForeshadows.push({ description: dup.description, category: dup.category })
          continue
        }
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
          plantMethod: gen.data.plantMethod,
          recoverMethod: gen.data.recoverMethod,
          linkedInfoLayers: '[]',
          chapterSpans: [],
          beats: [{ chapter: chapterNumber, type: 'plant' }],
        })
        existingForeshadowByDesc.set(created.description.slice(0, 40), created)
        foreshadowIds.push(created.id)
        createdForeshadowIds.push(created.id)
        generatedForeshadows.push({ description: created.description, category: created.category })
      }

      // ── 势力：按名匹配已有实体 ──
      const existingFactionByName = new Map<string, NovelFaction>()
      for (const f of this.store.listFactions(projectId)) {
        existingFactionByName.set(f.name, f)
      }

      for (const spec of plan.factions) {
        signal?.throwIfAborted()
        const hint = this.parseExistingHint(spec.coreStyle)
        if (hint.mode === 'existing') {
          const existing = existingFactionByName.get(hint.name)
          if (existing) {
            onProgress?.({ phase: 'generating', message: `复用已有势力：${existing.name}` })
            // 扩展 chapterSpans 包含本章
            const spans = existing.chapterSpans ?? []
            const alreadyCovers = spans.some(([s, e]) => chapterNumber >= s && chapterNumber <= e)
            if (!alreadyCovers) {
              const mergedSpans: ChapterSpan[] = [...spans, [chapterNumber, chapterNumber] as ChapterSpan]
              rollbackActions.push(() => { this.store.updateFaction(existing.id, { chapterSpans: existing.chapterSpans }) })
              this.store.updateFaction(existing.id, { chapterSpans: mergedSpans })
            }
            factionIds.push(existing.id)
            generatedFactions.push({ name: existing.name, type: existing.type })
            continue
          }
        }

        onProgress?.({ phase: 'generating', message: `生成势力：${spec.coreStyle}` })
        const gen = await resolveGenerated(spec, 'faction')
        if (gen.type !== 'faction') continue
        const dup = existingFactionByName.get(gen.data.name)
        if (dup) {
          onProgress?.({ phase: 'generating', message: `检测到同名势力「${gen.data.name}」，合并为已有实体` })
          const spans = dup.chapterSpans ?? []
          const alreadyCovers = spans.some(([s, e]) => chapterNumber >= s && chapterNumber <= e)
          if (!alreadyCovers) {
            const mergedSpans: ChapterSpan[] = [...spans, [chapterNumber, chapterNumber] as ChapterSpan]
            rollbackActions.push(() => { this.store.updateFaction(dup.id, { chapterSpans: dup.chapterSpans }) })
            this.store.updateFaction(dup.id, { chapterSpans: mergedSpans })
          }
          factionIds.push(dup.id)
          generatedFactions.push({ name: dup.name, type: dup.type })
          continue
        }
        const created = this.store.createFaction({
          id: randomUUID(),
          projectId,
          name: gen.data.name,
          description: gen.data.description,
          type: gen.data.type,
          leaderId: null,
          ideology: gen.data.ideology,
          strength: gen.data.strength,
          resources: gen.data.resources,
          allies: gen.data.allies,
          enemies: gen.data.enemies,
          status: gen.data.status,
          chapterSpans: [[chapterNumber, chapterNumber]],
        })
        existingFactionByName.set(created.name, created)
        factionIds.push(created.id)
        createdFactionIds.push(created.id)
        generatedFactions.push({ name: created.name, type: created.type })
      }

      // ── 地点：按名匹配已有实体 ──
      const existingLocationByName = new Map<string, NovelLocation>()
      for (const l of this.store.listLocations(projectId)) {
        existingLocationByName.set(l.name, l)
      }

      for (const spec of plan.locations) {
        signal?.throwIfAborted()
        const hint = this.parseExistingHint(spec.coreStyle)
        if (hint.mode === 'existing') {
          const existing = existingLocationByName.get(hint.name)
          if (existing) {
            onProgress?.({ phase: 'generating', message: `复用已有地点：${existing.name}` })
            // 追加本章到 appearChapters（如尚未包含）
            const appears = existing.appearChapters ?? []
            const patch: Partial<NovelLocation> = {}
            if (!appears.includes(chapterNumber)) {
              patch.appearChapters = [...appears, chapterNumber]
            }
            if (existing.firstChapter == null) {
              patch.firstChapter = chapterNumber
            }
            if (Object.keys(patch).length > 0) {
              rollbackActions.push(() => {
                this.store.updateLocation(existing.id, {
                  firstChapter: existing.firstChapter,
                  appearChapters: existing.appearChapters,
                })
              })
              this.store.updateLocation(existing.id, patch)
            }
            locationIds.push(existing.id)
            generatedLocations.push({ name: existing.name, type: existing.type })
            continue
          }
        }

        onProgress?.({ phase: 'generating', message: `生成地点：${spec.coreStyle}` })
        const gen = await resolveGenerated(spec, 'location')
        if (gen.type !== 'location') continue
        const dup = existingLocationByName.get(gen.data.name)
        if (dup) {
          onProgress?.({ phase: 'generating', message: `检测到同名地点「${gen.data.name}」，合并为已有实体` })
          const appears = dup.appearChapters ?? []
          const patch: Partial<NovelLocation> = {}
          if (!appears.includes(chapterNumber)) {
            patch.appearChapters = [...appears, chapterNumber]
          }
          if (dup.firstChapter == null) {
            patch.firstChapter = chapterNumber
          }
          if (Object.keys(patch).length > 0) {
            rollbackActions.push(() => {
              this.store.updateLocation(dup.id, {
                firstChapter: dup.firstChapter,
                appearChapters: dup.appearChapters,
              })
            })
            this.store.updateLocation(dup.id, patch)
          }
          locationIds.push(dup.id)
          generatedLocations.push({ name: dup.name, type: dup.type })
          continue
        }
        const created = this.store.createLocation({
          id: randomUUID(),
          projectId,
          name: gen.data.name,
          description: gen.data.description,
          type: gen.data.type,
          parentId: null,
          factionId: null,
          significance: gen.data.significance,
          status: gen.data.status,
          firstChapter: chapterNumber,
          appearChapters: [chapterNumber],
        })
        existingLocationByName.set(created.name, created)
        locationIds.push(created.id)
        createdLocationIds.push(created.id)
        generatedLocations.push({ name: created.name, type: created.type })
      }
    } catch (err) {
      // 标记日志状态为失败，供 finally 块写入日志使用
      logStatus = 'error'
      logError = err instanceof Error ? err.message : String(err)
      // 反向顺序 best-effort 清理本次写入，避免半编排脏数据污染矩阵。
      // 注意：只删除本次新建实体，复用实体只撤销本次追加的 history/span/appearChapters。
      for (const rollback of rollbackActions.reverse()) {
        try {
          rollback()
        } catch { /* best-effort 清理，忽略单个撤销失败 */ }
      }
      for (const id of createdLocationIds) {
        try {
          this.store.deleteLocation(id)
        } catch { /* best-effort 清理，忽略单个删除失败 */ }
      }
      for (const id of createdFactionIds) {
        try {
          this.store.deleteFaction(id)
        } catch { /* best-effort 清理，忽略单个删除失败 */ }
      }
      for (const id of createdForeshadowIds) {
        try {
          this.store.deleteForeshadow(id)
        } catch { /* best-effort 清理，忽略单个删除失败 */ }
      }
      for (const id of createdConflictIds) {
        try {
          this.store.deleteConflict(id)
        } catch { /* best-effort 清理，忽略单个删除失败 */ }
      }
      for (const id of createdCharacterIds) {
        try {
          this.store.deleteCharacterHistoryByCharacter(id)
          this.store.deleteCharacter(id)
        } catch { /* best-effort 清理，忽略单个删除失败 */ }
      }
      const rolledBack = createdCharacterIds.length + createdConflictIds.length + createdForeshadowIds.length + createdFactionIds.length + createdLocationIds.length
      this.context.logger.error(
        {
          err,
          created: {
            characters: createdCharacterIds.length,
            conflicts: createdConflictIds.length,
            foreshadows: createdForeshadowIds.length,
            factions: createdFactionIds.length,
            locations: createdLocationIds.length,
          },
        },
        `generateAndArrange 失败，已回滚 ${rolledBack} 个新建实体并撤销复用实体变更`,
      )
      throw err
    } finally {
      // ── 持久化编排日志（agent_type='arranger'）──
      // 参考 runAgent 的日志写入模式（novel-orchestrator.ts line 691），
      // 把编排的完整输入输出写入 novel_agent_logs，让用户能在 Agent 日志面板审计编排流程。
      // fire-and-forget：日志写入失败不影响主流程
      try {
        const logResultStr = JSON.stringify({
          // 规划阶段：LLM 看到的输入 + 原始输出
          planning: {
            systemPromptPreview: planLogContext?.systemPrompt.slice(0, 500) ?? '',
            userMessage: planLogContext?.userMessage ?? '',
            rawLlmOutput: planLogContext?.rawResult ?? '',
            planningStatus: planLogContext?.status ?? 'unknown',
            planningError: planLogContext?.error ?? '',
          },
          // 执行阶段：实际生成/复用的实体清单
          execution: {
            characters: generatedCharacters,
            conflicts: generatedConflicts,
            foreshadows: generatedForeshadows,
            factions: generatedFactions,
            locations: generatedLocations,
          },
          batchGeneration: {
            itemCount: batchGeneration.itemCount,
            batchCount: batchGeneration.batchCount,
            retryCount: batchGeneration.retryCount,
            fallbackCount: batchGeneration.fallbackCount,
            unbatchedGenerationCount: batchGeneration.unbatchedGenerationCount,
            capturedUsage: batchGeneration.usage ?? null,
          },
          // 汇总计数
          summary: {
            characterCount: characterIds.length,
            conflictCount: conflictIds.length,
            foreshadowCount: foreshadowIds.length,
            factionCount: factionIds.length,
            locationCount: locationIds.length,
            characterFunctionCount: characterFunctions.length,
          },
        }, null, 2)
        let capturedUsage = planLogContext?.usage
        if (batchGeneration.usage) capturedUsage = addLlmUsage(capturedUsage, batchGeneration.usage)
        // 正常批次路径使用 session 事件中的精确 usage。只有“已有实体未命中”触发旧单项生成时，
        // 才回退到时间窗账本，避免漏记这部分 token。
        const usageFromLedger = batchGeneration.unbatchedGenerationCount > 0 || !hasLlmUsage(capturedUsage)
          ? this.readUsageFromLedgerWindow(startTime, Date.now())
          : undefined
        const usageForLog = usageFromLedger ?? (hasLlmUsage(capturedUsage) ? capturedUsage : undefined)

        this.store.insertAgentLog({
          projectId,
          chapterNumber,
          agentType: 'arranger',
          agentName: '编排',
          displayAgentType: 'arranger',
          displayAgentName: '编排',
          phase: 'arranging',
          systemPrompt: planLogContext?.systemPrompt ?? '',
          // chapterContext 留空：编排阶段不依赖 chapterContext，相关上下文已在 userMessage 中
          chapterContext: '',
          userMessage: planLogContext?.userMessage ?? '',
          taskInput: outline,
          userInstructions: [],
          tools: [],
          toolNames: [],
          result: logResultStr,
          resultLength: logResultStr.length,
          durationMs: Date.now() - startTime,
          status: logStatus,
          error: logError,
          sessionId: '',
          inputTokens: usageForLog?.inputTokens ?? 0,
          outputTokens: usageForLog?.outputTokens ?? 0,
          cacheReadTokens: usageForLog?.cacheReadTokens ?? 0,
          cacheWriteTokens: usageForLog?.cacheWriteTokens ?? 0,
          llmProvider: usageForLog?.llmProvider ?? '',
          llmModel: usageForLog?.llmModel ?? '',
        })
      } catch (logErr) {
        // 日志写入失败不影响主流程
        this.context.logger.warn(
          { projectId, chapterNumber, err: logErr },
          '编排日志写入失败',
        )
      }
    }

    onProgress?.({
      phase: 'arranged',
      message: '编排完成，实体已落入矩阵',
      // 携带 detail 用于前端展示编排完成清单气泡
      detail: {
        kind: 'arrange_result',
        characters: generatedCharacters,
        conflicts: generatedConflicts,
        foreshadows: generatedForeshadows,
        factions: generatedFactions,
        locations: generatedLocations,
      },
    })
    this.context.logger.info(
      { projectId, chapterNumber, characters: characterIds.length, conflicts: conflictIds.length, foreshadows: foreshadowIds.length, clues: clueIds.length, factions: factionIds.length, locations: locationIds.length, characterFunctions: characterFunctions.length },
      'generateAndArrange 完成：实体已落库',
    )
    return {
      characterIds,
      conflictIds,
      foreshadowIds,
      clueIds,
      factionIds,
      locationIds,
      characterFunctions: characterFunctions.length > 0 ? characterFunctions : undefined,
    }
  }

  /**
   * 创建全新角色 + 追加 characterHistory + 更新查重 map + 推入结果数组
   *
   * 抽出此方法是因为：① LLM 标注"已有：X"但项目里没找到 → 降级为新建；
   * ② 二次查重未命中 → 走标准新建流程。两处逻辑完全一致，避免重复。
   */
  private async processNewCharacter(
    data: GeneratedCharacter,
    projectId: string,
    chapterNumber: number,
    outline: string,
    existingByName: Map<string, NovelCharacter>,
    characterIds: string[],
    createdCharacterIds: string[],
    characterFunctions: CharacterFunctionEntry[],
    generatedCharacters: Array<{ name: string; description: string; plotFunction?: PlotFunction; functionNote?: string }>,
    spec: { coreStyle: string; plotFunction?: PlotFunction; functionNote?: string },
  ): Promise<void> {
    const created = this.store.createCharacter({
      id: randomUUID(),
      projectId,
      name: data.name,
      description: data.description,
      identity: data.identity,
      personality: data.personality,
      appearance: data.appearance,
      currentState: data.currentState,
      currentGoal: data.currentGoal,
      currentPressure: data.currentPressure,
      secret: data.secret,
      arcStage: data.arcStage,
      arcHistory: '[]',
      speechStyle: data.speechStyle,
      isProtagonist: false,
      longTermDesire: data.longTermDesire,
      plotRole: data.plotRole,
      removalImpact: data.removalImpact,
    })
    existingByName.set(created.name, created)  // 加入 map 避免后续重复创建同名角色
    characterIds.push(created.id)
    createdCharacterIds.push(created.id)
    if (spec.plotFunction) {
      characterFunctions.push({ characterId: created.id, function: spec.plotFunction, note: spec.functionNote })
    }
    generatedCharacters.push({
      name: created.name,
      description: created.description,
      plotFunction: spec.plotFunction,
      functionNote: spec.functionNote,
    })
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

  /**
   * 调用 LLM 解析章纲，产出待生成实体的 coreStyle 清单。
   *
   * 复用 extractJsonBlock / ensureString 工具函数解析返回。
   * 使用 promptStream（与 generate 一致）以保持 Session API 调用模式统一。
   */
  private async planEntitiesFromOutline(
    projectId: string,
    chapterNumber: number,
    outline: string,
    onProgress?: (event: { phase: string; message: string; data?: unknown; detail?: Record<string, unknown> }) => void,
    source: 'outline' | 'content' = 'outline',
    signal?: AbortSignal,
  ): Promise<EntityPlanResult> {
    const systemPrompt = this.promptBuilder.buildSystemPrompt(projectId, 'character-generator')

    // ── 收集已有实体清单，避免重复生成 ──
    // LLM 看到已有角色后，可以决定：
    //   1. 复用（返回的 coreStyle 中明确指向已有角色名）
    //   2. 真正新增（章纲确实需要新角色）
    // 生成阶段会按名查重执行 upsert，这里仅提供"已有什么"作为决策上下文
    const existingCharacters = this.store.listCharacters(projectId)
    const existingConflicts = this.store.listConflicts(projectId)
    // 已回收/废弃伏笔不再参与新章节编排，避免把已结清叙事债务重新当成待推进事项。
    const existingForeshadows = this.store.listForeshadowing(projectId)
      .filter((foreshadow) => foreshadow.status !== 'recovered' && foreshadow.status !== 'abandoned')
    const existingFactions = this.store.listFactions(projectId)
    const existingLocations = this.store.listLocations(projectId)

    // ── 收集三层大纲：项目大纲 + 卷纲 + 章纲 ──
    // ⚠️ 历史问题：之前只传 chapter.outline，LLM 看不到项目整体大纲和当前卷的卷纲，
    // 无法理解这一章在全局的位置，导致编排的实体与设定不符。
    // 现在把三层大纲都注入 prompt，让 LLM 在完整上下文下规划。
    const project = this.store.getProject(projectId)
    const projectOutline = project?.outline?.trim() ?? ''
    const chapter = this.store.getChapter(projectId, chapterNumber)
    const volumeOutline = (() => {
      if (!chapter?.volumeId) return ''
      const vol = this.store.getVolume(chapter.volumeId)
      return vol?.outline?.trim() ?? ''
    })()

    const formatExistingList = (
      items: Array<{ name?: string; description?: string }>,
      fallbackLabel: string,
    ): string => {
      if (items.length === 0) return `（暂无${fallbackLabel}）`
      // 旧实现把项目内全部实体描述原样塞进规划 prompt，项目变大后会让
      // 每次 ai-arrange/reverse-arrange 的输入 token 随历史线性膨胀。
      // 保留稳定排序后的前缀条目，超出预算的实体仍可在生成阶段按名查重。
      const maxChars = 5000
      const lines: string[] = []
      let usedChars = 0
      const stableItems = [...items].sort((a, b) =>
        (a.name ?? a.description ?? '').localeCompare(b.name ?? b.description ?? ''),
      )
      for (const [index, it] of stableItems.entries()) {
        const line = `${index + 1}. ${it.name ?? fallbackLabel}${it.description ? `：${it.description.slice(0, 100)}` : ''}`
        if (usedChars + line.length > maxChars) break
        lines.push(line)
        usedChars += line.length + 1
      }
      if (lines.length < stableItems.length) {
        lines.push(`...其余 ${stableItems.length - lines.length} 个${fallbackLabel}省略，生成阶段会继续按名称/描述查重`)
      }
      return lines.join('\n')
    }

    // ── 根据 source 构建不同的 userPrompt ──
    // source='outline': 从章纲编排实体（原有逻辑）
    // source='content': 从已写好的正文反推实体（新功能）
    const isReverse = source === 'content'
    const sourceInstruction = isReverse
      ? '你是小说实体反推助手。根据以下已写好的章节正文，反推本章涉及哪些实体（角色/冲突/伏笔/势力/地点），包括已有实体和新出现的实体。'
      : '你是小说实体规划助手。根据以下三层大纲（项目大纲 + 卷纲 + 章纲），规划本章需要哪些实体（包括已有 + 新增）。'

    const userPrompt = [
      sourceInstruction,
      '',
      FORESHADOW_ADMISSION_PROMPT,
      '',
      isReverse
        ? '【三层上下文（项目大纲提供全局设定背景，卷纲提供当前卷走向，正文是反推的唯一依据）】'
        : '【三层大纲（按重要性递减，章纲最具体必须严格遵循，项目大纲提供全局设定背景）】',
      '',
      '### 项目大纲（全局设定背景）',
      projectOutline || '（未填写）',
      '',
      '### 卷纲（当前卷主题与走向）',
      volumeOutline || '（未填写）',
      '',
      isReverse
        ? `### 章节正文（反推依据 - 从中提取本章涉及的所有实体）`
        : '### 章纲（本章具体内容 - 必须严格遵循）',
      outline,
      '',
      '【已有实体清单（重要 - 复用优先）】',
      '以下是项目里已经存在的实体。**本章需要的实体如果已在清单中，必须复用，不要新建同名/同描述的实体**。',
      '',
      '复用写法（coreStyle 字段）：',
      '- 角色/势力/地点（有独立 name 字段）：写 "已有：<name>"，如 "已有：林墨"、"已有：国安总局"',
      '- 冲突/伏笔（无 name 字段，只有 description）：写 "已有：<描述前 40 字>"，',
      '  必须原样复制下方清单中的描述前 40 字（后端按前 40 字匹配）',
      '- 新增实体：写一句话描述其核心特征（不要加"已有："前缀）',
      '',
      '**关键**：返回的数组要包含"本章需要登场的所有实体"，不要因为是已有就跳过。',
      '空数组意味着"本章不需要任何该类实体"。',
      '如果本章不需要新增某类实体且已有实体都不延续到本章，返回空数组。',
      '',
      `### 已有角色（${existingCharacters.length}）`,
      formatExistingList(existingCharacters.map((c) => ({ name: c.name, description: c.description })), '角色'),
      '',
      `### 已有冲突（${existingConflicts.length}）`,
      formatExistingList(existingConflicts.map((c) => ({ name: undefined, description: c.description })), '冲突'),
      '',
      `### 已有伏笔（${existingForeshadows.length}）`,
      formatExistingList(existingForeshadows.map((f) => ({ name: undefined, description: f.description })), '伏笔'),
      '',
      `### 已有势力（${existingFactions.length}）`,
      formatExistingList(existingFactions.map((f) => ({ name: f.name, description: f.description })), '势力'),
      '',
      `### 已有地点（${existingLocations.length}）`,
      formatExistingList(existingLocations.map((l) => ({ name: l.name, description: l.description })), '地点'),
      '',
      '【返回格式】',
      '返回严格 JSON：',
      '{"characters":[{"coreStyle":"已有：林墨","plotFunction":"open_phase","functionNote":"功能位具体描述"}],"conflicts":[{"coreStyle":"已有：主角今日必须凑齐定额镇魔石料，否则将被逐出大阵庇护范围，暴露于"}],"foreshadows":[{"coreStyle":"已有：父亲遗物上的编号","importance":"critical","narrativeRole":"dark_line","hiddenQuestion":"父亲真正因何死亡","plannedPayoff":"在查到旧案主谋时揭示编号来源并回收","chapterAction":"reinforce"}],"factions":[{"coreStyle":"已有：国安总局"}],"locations":[{"coreStyle":"已有：国安总局指挥大厅"}]}',
      '所有伏笔都必须返回 importance、narrativeRole、hiddenQuestion、plannedPayoff。复用已有伏笔还必须返回本章实际动作 chapterAction=plant|reinforce|reveal|payoff；缺少任一项都会被过滤。',
      '',
      '【角色功能位编排（重要，避免工具人化）】',
      '每个返回的角色（无论已有/新增）必须指定 plotFunction（从以下 7 个枚举选一）：',
      '- provide_resource: 提供资源（信息/物品/人脉/能力）',
      '- create_obstacle: 制造阻碍（直接拦主角或制造麻烦）',
      '- amplify_conflict: 放大冲突（让现有冲突升级或暴露）',
      '- open_phase: 打开新阶段（引入新场景/新角色/新规则）',
      '- change_judgment: 改变主角判断（让主角重新评估或转变想法）',
      '- advance_relationship: 推进感情线（让某段关系发生质变）',
      '- reveal_world_rule: 暴露世界规则（通过他展示世界运作方式）',
      'functionNote 用一句话说明该功能位在本章具体如何执行（如"通过透露边关军情让主角判断转变"）。',
      '不允许两个角色承担相同功能位。如果出现重复，合并或换一个功能位。',
      '',
      '【输出约束（必须遵守）】',
      '1. 所有输出的文本字段（coreStyle / functionNote / description 等）绝不使用破折号"——"。转折用句号分割独立句，补充说明用逗号，列举用顿号，悬念收尾用省略号。',
      '2. 复用已有实体时，如原描述含破折号，规划时也不要在新字段中引入破折号。',
      '',
      '请基于上方' + (isReverse ? '正文反推实体' : '三层大纲规划实体') + '。',
    ].join('\n')

    this.context.logger.info(
      { projectId, outlineLength: outline.length, existingCounts: {
        characters: existingCharacters.length,
        conflicts: existingConflicts.length,
        foreshadows: existingForeshadows.length,
        factions: existingFactions.length,
        locations: existingLocations.length,
      } },
      'planEntitiesFromOutline 开始：调用 LLM 规划实体（已传入已有实体清单）',
    )
    onProgress?.({ phase: 'planning', message: 'AI 正在规划本章实体...' })

    // 复用 novel-director 在 AgentPage 配置的 model（规划类任务角色定位最接近），
    // 未配置则走默认 Provider。
    const directorModel = this.context.subagentManager?.getAgent('novel-director')?.model
    const session = await this.context.createSession({
      systemPrompt,
      // 身份段注入 userMessage 开头（systemPrompt 不含身份段，以跨 Agent 共享 system 缓存）
      userMessage: this.promptBuilder.buildAgentIdentity(projectId, 'character-generator')
        + '\n\n---\n\n' + userPrompt,
      responseFormat: 'json',
      modelId: directorModel,
      // 规划阶段可能生成大量 JSON（多个实体），LLM 耗时较长；
      // 默认 120s 不足以完成复杂章纲的规划，提到 300s 与 Memory Agent 一致
      timeoutMs: 300_000,
      signal,
    })
    let capturedUsage: LlmUsageSnapshot | undefined
    const unsubscribeUsage = session.subscribe((event: Record<string, unknown>) => {
      if (event.type !== 'message_end') return
      const msg = (event as { message?: Record<string, unknown> }).message
      if (!msg || msg.role !== 'assistant') return
      const usage = extractLlmUsageFromMessage(msg)
      if (usage) capturedUsage = addLlmUsage(capturedUsage, usage)
    })

    try {
      let result = ''
      let deltaCount = 0
      let text = ''
      try {
        const full = await session.promptStream((delta) => {
          result += delta
          deltaCount++
          // 流式推送进度（每 5 个 delta 推一次，避免事件过密），让前端知道 LLM 在工作
          if (deltaCount % 5 === 0) {
            onProgress?.({
              phase: 'planning',
              message: `AI 正在规划本章实体... 已生成 ${result.length} 字符`,
            })
          }
        })
        // 优先使用流式累积结果，回退到 promptStream 返回值
        text = result || full
      } catch (llmErr) {
        if (signal?.aborted) throw llmErr
        // LLM 调用失败：返回空 plan + 错误日志上下文，让 generateAndArrange 能写入失败日志
        const errMsg = llmErr instanceof Error ? llmErr.message : String(llmErr)
        this.context.logger.error(
          { projectId, err: llmErr, resultLength: result.length },
          'planEntitiesFromOutline LLM 调用失败',
        )
        const emptyPlan = { characters: [] as Array<{ coreStyle: string; plotFunction?: PlotFunction; functionNote?: string }>, conflicts: [], foreshadows: [], factions: [], locations: [] }
        return {
          plan: emptyPlan,
          logContext: {
            systemPrompt,
            userMessage: userPrompt,
            rawResult: result,
            status: 'error',
            error: `LLM 调用失败：${errMsg}`,
            usage: capturedUsage,
          },
        }
      }
      this.context.logger.info(
        { projectId, resultLength: text.length, deltaCount },
        'planEntitiesFromOutline LLM 调用完成，开始解析 JSON',
      )
      let json: Record<string, unknown> | null
      json = repairAndParseJson(text)
      if (!json) {
        this.context.logger.warn(
          { rawTextPreview: text.slice(0, 200) },
          'planEntitiesFromOutline JSON 解析失败（可能被截断），使用空 plan 兜底',
        )
        const emptyPlan = { characters: [] as Array<{ coreStyle: string; plotFunction?: PlotFunction; functionNote?: string }>, conflicts: [], foreshadows: [], factions: [], locations: [] }
        return {
          plan: emptyPlan,
          logContext: {
            systemPrompt,
            userMessage: userPrompt,
            rawResult: text,
            status: 'error',
            error: 'JSON 解析失败（可能被截断），使用空 plan 兜底',
            usage: capturedUsage,
          },
        }
      }
      const validPlotFunctions: PlotFunction[] = [
        'provide_resource', 'create_obstacle', 'amplify_conflict',
        'open_phase', 'change_judgment', 'advance_relationship', 'reveal_world_rule',
      ]
      const plan = {
        characters: Array.isArray(json.characters)
          ? json.characters
              .map((c: unknown) => {
                const obj = c as { coreStyle?: unknown; plotFunction?: unknown; functionNote?: unknown }
                const coreStyle = ensureString(obj?.coreStyle, '新角色')
                const plotFunction = typeof obj?.plotFunction === 'string'
                  && validPlotFunctions.includes(obj.plotFunction as PlotFunction)
                  ? obj.plotFunction as PlotFunction
                  : undefined
                const functionNote = typeof obj?.functionNote === 'string' && obj.functionNote.trim()
                  ? obj.functionNote.trim()
                  : undefined
                return { coreStyle, plotFunction, functionNote }
              })
          : [],
        conflicts: Array.isArray(json.conflicts)
          ? json.conflicts
              .map((c: unknown) => ({ coreStyle: ensureString((c as { coreStyle?: unknown })?.coreStyle, '新冲突') }))
          : [],
        foreshadows: normalizePlannedForeshadows(json.foreshadows),
        factions: Array.isArray(json.factions)
          ? json.factions
              .map((f: unknown) => ({ coreStyle: ensureString((f as { coreStyle?: unknown })?.coreStyle, '新势力') }))
          : [],
        locations: Array.isArray(json.locations)
          ? json.locations
              .map((l: unknown) => ({ coreStyle: ensureString((l as { coreStyle?: unknown })?.coreStyle, '新地点') }))
          : [],
      }
      this.context.logger.info(
        { projectId, characters: plan.characters.length, conflicts: plan.conflicts.length, foreshadows: plan.foreshadows.length, factions: plan.factions.length, locations: plan.locations.length },
        'planEntitiesFromOutline 解析完成',
      )
      return {
        plan,
        logContext: {
          systemPrompt,
          userMessage: userPrompt,
          rawResult: text,
          status: 'success',
          error: '',
          usage: capturedUsage,
        },
      }
    } finally {
      unsubscribeUsage()
      session.dispose()
    }
  }

  /**
   * 将规划中的新实体按类型分批生成。已有实体提示不进入批次，避免为可复用数据消耗 token。
   * 每批最多 4 项；无效项只重试自身，第二次仍失败才使用本地模板。
   */
  private async generatePlanInBatches(
    projectId: string,
    plan: EntityPlan,
    onProgress?: (event: { phase: string; message: string; data?: unknown }) => void,
    signal?: AbortSignal,
  ): Promise<BatchGenerationRun> {
    const run: BatchGenerationRun = {
      generated: new Map(),
      itemCount: 0,
      batchCount: 0,
      retryCount: 0,
      fallbackCount: 0,
      unbatchedGenerationCount: 0,
    }
    const groups: Array<{ kind: EntityKind; specs: BatchPlanSpec[] }> = [
      { kind: 'character', specs: plan.characters },
      { kind: 'conflict', specs: plan.conflicts },
      { kind: 'foreshadow', specs: plan.foreshadows },
      { kind: 'faction', specs: plan.factions },
      { kind: 'location', specs: plan.locations },
    ]
    const batchSize = 4

    for (const { kind, specs } of groups) {
      signal?.throwIfAborted()
      const candidates = specs.filter((spec) => this.parseExistingHint(spec.coreStyle).mode === 'new')
      run.itemCount += candidates.length

      for (let offset = 0; offset < candidates.length; offset += batchSize) {
        const chunk = candidates.slice(offset, offset + batchSize)
        const requestItems = chunk.map((spec, index) => ({ index, coreStyle: spec.coreStyle }))
        run.batchCount += 1
        onProgress?.({
          phase: 'generating',
          message: `批量生成${this.kindLabel(kind)}：第 ${Math.floor(offset / batchSize) + 1} 批，共 ${chunk.length} 项`,
          data: { entityType: kind, batchSize: chunk.length, maxBatchSize: batchSize },
        })

        const batch = await this.generateEntityBatch(projectId, kind, requestItems, onProgress, false, signal)
        if (batch.usage) run.usage = addLlmUsage(run.usage, batch.usage)

        for (const [index, entity] of batch.generated) {
          const spec = chunk[index]
          if (spec) run.generated.set(spec, entity)
        }

        for (const failedIndex of batch.failedIndexes) {
          const spec = chunk[failedIndex]
          if (!spec) continue
          run.retryCount += 1
          onProgress?.({
            phase: 'generating',
            message: `${this.kindLabel(kind)}批次第 ${failedIndex + 1} 项校验失败，正在单独重试`,
            data: { entityType: kind, coreStyle: spec.coreStyle },
          })

          const retry = await this.generateEntityBatch(
            projectId,
            kind,
            [{ index: 0, coreStyle: spec.coreStyle }],
            onProgress,
            true,
            signal,
          )
          if (retry.usage) run.usage = addLlmUsage(run.usage, retry.usage)
          const retriedEntity = retry.generated.get(0)
          if (retriedEntity) {
            run.generated.set(spec, retriedEntity)
            continue
          }

          run.fallbackCount += 1
          run.generated.set(spec, {
            type: kind,
            data: this.buildBatchTemplate(kind, spec.coreStyle),
          } as GeneratedEntity)
          this.context.logger.error(
            { projectId, entityType: kind, coreStylePreview: spec.coreStyle.slice(0, 80) },
            '实体批量生成单项重试仍失败，使用模板兜底',
          )
        }
      }
    }

    this.context.logger.info(
      {
        projectId,
        itemCount: run.itemCount,
        batchCount: run.batchCount,
        retryCount: run.retryCount,
        fallbackCount: run.fallbackCount,
        usage: run.usage,
      },
      '实体批量生成完成',
    )
    return run
  }

  private async generateEntityBatch(
    projectId: string,
    kind: EntityKind,
    items: BatchRequestItem[],
    onProgress: ((event: { phase: string; message: string; data?: unknown }) => void) | undefined,
    isRetry: boolean,
    signal?: AbortSignal,
  ): Promise<BatchRequestResult> {
    let capturedUsage: LlmUsageSnapshot | undefined
    const failedResult = (): BatchRequestResult => ({
      generated: new Map(),
      failedIndexes: items.map((item) => item.index),
      usage: capturedUsage,
    })

    try {
      const systemPrompt = this.promptBuilder.buildSystemPrompt(projectId, 'character-generator')
      const userMessage = this.promptBuilder.buildAgentIdentity(projectId, 'character-generator')
        + '\n\n---\n\n' + this.buildBatchUserPrompt(kind, items)
      // 复用 novel-director 在 AgentPage 配置的 model（规划类任务角色定位最接近），
      // 未配置则走默认 Provider。
      const directorModel = this.context.subagentManager?.getAgent('novel-director')?.model
      const session = await this.context.createSession({
        systemPrompt,
        userMessage,
        responseFormat: 'json',
        modelId: directorModel,
        timeoutMs: 300_000,
        signal,
      })
      const unsubscribeUsage = session.subscribe((event: Record<string, unknown>) => {
        if (event.type !== 'message_end') return
        const message = (event as { message?: Record<string, unknown> }).message
        if (!message || message.role !== 'assistant') return
        const usage = extractLlmUsageFromMessage(message)
        if (usage) capturedUsage = addLlmUsage(capturedUsage, usage)
      })

      try {
        let streamedText = ''
        let lastEmitTs = 0
        const full = await session.promptStream((delta) => {
          streamedText += delta
          const now = Date.now()
          if (now - lastEmitTs < 500) return
          lastEmitTs = now
          onProgress?.({
            phase: 'generating',
            message: `${isRetry ? '单项重试' : '批量生成'}${this.kindLabel(kind)}中...`,
            data: { entityType: kind, partial: streamedText.slice(-200) },
          })
        })
        const text = streamedText || full
        const parsed = repairAndParseJson(text)
        const resultItems = parsed && Array.isArray(parsed.items) ? parsed.items : []
        const generated = new Map<number, GeneratedEntity>()

        for (const rawItem of resultItems) {
          if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue
          const item = rawItem as Record<string, unknown>
          const index = typeof item.index === 'number' && Number.isInteger(item.index) ? item.index : -1
          if (!items.some((request) => request.index === index) || generated.has(index)) continue
          const data = item.result ?? item.data
          if (!this.isValidBatchItem(kind, data)) continue
          const coreStyle = items.find((request) => request.index === index)?.coreStyle ?? ''
          generated.set(index, {
            type: kind,
            data: this.parseBatchItem(kind, data, coreStyle, projectId),
          } as GeneratedEntity)
        }

        const failedIndexes = items
          .map((item) => item.index)
          .filter((index) => !generated.has(index))
        if (failedIndexes.length > 0) {
          this.context.logger.warn(
            {
              projectId,
              entityType: kind,
              isRetry,
              requestedCount: items.length,
              validCount: generated.size,
              failedIndexes,
              resultLength: text.length,
            },
            '实体批量生成存在未通过逐项校验的结果',
          )
        } else {
          this.context.logger.info(
            {
              projectId,
              entityType: kind,
              isRetry,
              itemCount: items.length,
              resultLength: text.length,
              usage: capturedUsage,
            },
            '实体批量生成请求完成',
          )
        }
        return { generated, failedIndexes, usage: capturedUsage }
      } finally {
        unsubscribeUsage()
        session.dispose()
      }
    } catch (err) {
      if (signal?.aborted) throw err
      this.context.logger.error(
        { projectId, entityType: kind, isRetry, itemCount: items.length, err },
        '实体批量生成请求失败',
      )
      return failedResult()
    }
  }

  private buildBatchUserPrompt(kind: EntityKind, items: BatchRequestItem[]): string {
    return [
      `一次生成 ${items.length} 个${this.kindLabel(kind)}。每个输入项必须独立处理，不得混合设定。`,
      '',
      '【输入项】',
      JSON.stringify(items),
      '',
      '【单项字段规则】',
      this.batchFieldRules(kind),
      '',
      '【返回格式】',
      '只返回一个 JSON 对象，格式为：{"items":[{"index":0,"result":{}}]}。',
      'items 必须覆盖每个输入 index，顺序与输入一致。result 必须包含该类型要求的全部字段。',
      '文本字段禁止使用 U+2013、U+2014、U+2015 长横线。转折改用句号，补充说明改用逗号。',
    ].join('\n')
  }

  private batchFieldRules(kind: EntityKind): string {
    switch (kind) {
      case 'character':
        return [
          'name、description、identity、personality、appearance、currentState、currentGoal、currentPressure、secret、arcStage、speechStyle、longTermDesire、plotRole、removalImpact。',
          'plotRole: protagonist/main_opponent/supporting/function/background。arcStage: setup/rising/climax/falling/resolution。longTermDesire 是跨章节稳定欲望，currentGoal 是短期目标。',
        ].join('\n')
      case 'conflict':
        return [
          'description、type、intensity、stage、tier、participants、climaxChapter、climaxType、stakes、twistPotential、plotFunction、progressionMode。',
          'type: inner/relationship/faction/interest/moral/identity/emotional/world_rule/survival。stage: latent/emerging/escalating/erupting/reversing/resolved/transformed。tier: main/secondary/goal。',
          'climaxType: emotional/fate/character/combat/theme/composite。plotFunction: provide_resource/create_obstacle/amplify_conflict/open_phase/change_judgment/advance_relationship/reveal_world_rule。progressionMode: linear/mutation/stagnation/regression/reversal。',
          'intensity 为 1-10 整数，twistPotential 为 0-10 整数，participants 为角色姓名数组；无高潮时 climaxChapter 和 climaxType 为 null。',
        ].join('\n')
      case 'foreshadow':
        return [
          'description、category、status、linkedCharacters、linkedClues、plantMethod、recoverMethod。',
          'category: item/spoken/event/identity/secret/prophecy/promise/quote。status: planned/planted/reinforced/partially_revealed/recovering/recovered/abandoned。plantMethod: explicit/implicit/indirect。recoverMethod: explicit/implicit/reverse/progressive。',
        ].join('\n')
      case 'faction':
        return 'name、description、type、ideology、strength、resources、allies、enemies、status。type: organization/sect/kingdom/family/guild/cult。strength: weak/medium/strong/overwhelming。status: active/declined/destroyed/hidden。resources、allies、enemies 为字符串数组。'
      case 'location':
        return 'name、description、type、significance、status。type: continent/country/city/building/dungeon/region/wilderness。significance: minor/moderate/major/critical。status: normal/destroyed/changed/hidden。'
      case 'world_element':
        return 'category、name、description、attributes。category: power_system/history/culture/religion/technology/economy/geography。attributes 为 JSON 对象。'
    }
  }

  private isValidBatchItem(kind: EntityKind, value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const item = value as Record<string, unknown>
    const requiredFields: Record<EntityKind, string[]> = {
      character: ['name', 'description', 'identity', 'personality', 'appearance', 'currentState', 'currentGoal', 'currentPressure', 'secret', 'arcStage', 'speechStyle', 'longTermDesire', 'plotRole', 'removalImpact'],
      conflict: ['description', 'type', 'intensity', 'stage', 'tier', 'participants', 'climaxChapter', 'climaxType', 'stakes', 'twistPotential', 'plotFunction', 'progressionMode'],
      foreshadow: ['description', 'category', 'status', 'linkedCharacters', 'linkedClues', 'plantMethod', 'recoverMethod'],
      faction: ['name', 'description', 'type', 'ideology', 'strength', 'resources', 'allies', 'enemies', 'status'],
      location: ['name', 'description', 'type', 'significance', 'status'],
      world_element: ['category', 'name', 'description', 'attributes'],
    }
    if (!requiredFields[kind].every((field) => Object.prototype.hasOwnProperty.call(item, field))) return false

    const identityField = kind === 'conflict' || kind === 'foreshadow' ? 'description' : 'name'
    if (typeof item[identityField] !== 'string' || !item[identityField].trim()) return false
    if (kind === 'conflict' && !Number.isFinite(Number(item.intensity))) return false
    if (kind === 'world_element' && (typeof item.attributes !== 'object' || item.attributes == null || Array.isArray(item.attributes))) return false
    return true
  }

  private parseBatchItem(
    kind: EntityKind,
    item: Record<string, unknown>,
    coreStyle: string,
    projectId: string,
  ): GeneratedEntity['data'] {
    if (kind !== 'character') {
      return this.parseResult(kind, JSON.stringify(item), coreStyle, projectId)
    }

    const validPlotRoles: NovelCharacter['plotRole'][] = ['protagonist', 'main_opponent', 'supporting', 'function', 'background']
    return {
      name: ensureString(item.name, '未命名角色'),
      description: ensureString(item.description, ''),
      identity: ensureString(item.identity, ''),
      personality: ensureString(item.personality, ''),
      appearance: ensureString(item.appearance, ''),
      currentState: ensureString(item.currentState, ''),
      currentGoal: ensureString(item.currentGoal, ''),
      currentPressure: ensureString(item.currentPressure, ''),
      secret: ensureString(item.secret, ''),
      arcStage: ensureString(item.arcStage, 'setup'),
      speechStyle: ensureString(item.speechStyle, ''),
      longTermDesire: ensureString(item.longTermDesire, ''),
      plotRole: validPlotRoles.includes(item.plotRole as NovelCharacter['plotRole'])
        ? item.plotRole as NovelCharacter['plotRole']
        : 'supporting',
      removalImpact: ensureString(item.removalImpact, '暂无关键影响'),
    }
  }

  private buildBatchTemplate(kind: EntityKind, coreStyle: string): GeneratedEntity['data'] {
    if (kind !== 'character') return this.buildTemplate(kind, coreStyle)
    const trimmed = coreStyle.trim()
    const nameSeed = trimmed.slice(0, 4).replace(/[^\u4e00-\u9fa5a-zA-Z]/g, '')
    return {
      name: nameSeed.length >= 2 ? `${nameSeed}（待定）` : '未命名角色',
      description: `基于“${trimmed.slice(0, 30)}”生成的占位角色`,
      identity: '身份背景待补充',
      personality: '性格特征待补充',
      appearance: '外貌描写待补充',
      currentState: '初始状态，待发展',
      currentGoal: '当前目标待补充',
      currentPressure: '当前压力待补充',
      secret: '隐藏秘密待补充',
      arcStage: 'setup',
      speechStyle: '说话风格待补充',
      longTermDesire: '长期欲望待补充',
      plotRole: 'supporting',
      removalImpact: '暂无关键影响',
    }
  }

  private readUsageFromLedgerWindow(startTime: number, endTime: number): LlmUsageSnapshot | undefined {
    try {
      const rows = this.context.db.prepare(`
        SELECT provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, timestamp
        FROM usage_records
        WHERE timestamp >= ? AND timestamp <= ?
        ORDER BY timestamp ASC
      `).all(startTime - 500, endTime + 500) as Array<{
        provider: string
        model: string
        input_tokens: number
        output_tokens: number
        cache_read_tokens: number | null
        cache_write_tokens: number | null
        timestamp: number
      }>
      if (rows.length === 0) return undefined

      const latest = rows[rows.length - 1]
      const usage = rows.reduce<LlmUsageSnapshot>((sum, row) => ({
        inputTokens: sum.inputTokens + (row.input_tokens ?? 0),
        outputTokens: sum.outputTokens + (row.output_tokens ?? 0),
        cacheReadTokens: sum.cacheReadTokens + (row.cache_read_tokens ?? 0),
        cacheWriteTokens: sum.cacheWriteTokens + (row.cache_write_tokens ?? 0),
        llmProvider: row.provider || sum.llmProvider,
        llmModel: row.model || sum.llmModel,
      }), {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        llmProvider: latest.provider ?? '',
        llmModel: latest.model ?? '',
      })

      return hasLlmUsage(usage) ? usage : undefined
    } catch (err) {
      this.context.logger.debug({ err }, '编排 AgentLog usage 回填失败')
      return undefined
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
        '- participants: 参与者角色名数组（JSON 数组，每个元素是角色的完整姓名，如 ["林墨","苏晚"]）',
        '    注意：必须填角色名而非描述；如该冲突暂未涉及具体角色，可填空数组 []',
        '- climaxChapter: 冲突预计爆发（高潮）章节号，正整数；若该冲突无明确高潮章节则填 null',
        '- climaxType: 高潮类型，从以下枚举中选择一个：emotional/fate/character/combat/theme/composite；无高潮章节则填 null',
        '- stakes: 赌注（一句话描述失败代价，无则填空字符串）',
        '- twistPotential: 突转潜力，0-10 的整数（≥7 表示适合安排突转）',
        '- plotFunction: 剧情功能位，从以下枚举中选择一个（决定本章冲突推动什么剧情）：',
        '    - amplify_conflict: 放大冲突（让冲突升级到更高强度）',
        '    - open_phase: 打开新阶段（开启下一段故事，新场景/新势力登场）',
        '    - reveal_world_rule: 暴露世界规则（通过冲突展现世界运作方式）',
        '    - change_judgment: 改变主角判断（让主角重新评估或转变想法）',
        '    - provide_resource: 提供资源（冲突中获得关键资源/情报）',
        '    - create_obstacle: 制造障碍（冲突成为主角前进的阻力）',
        '    - advance_relationship: 推进关系（冲突导致某段关系发生质变）',
        '- progressionMode: 推进模式，从以下枚举中选择一个（决定冲突如何发展）：',
        '    - linear: 线性推进（latent→emerging→escalating→erupting→reversing→resolved）',
        '    - mutation: 突变（latent 直接 erupting，跳过多阶）',
        '    - stagnation: 停滞（保持当前阶段，仅强度变化，适合潜伏长冲突）',
        '    - regression: 降级（回退一阶，因外部干预或形势缓和）',
        '    - reversal: 反复（resolved 重新 emerging，旧仇重燃）',
        '',
        '【输出约束（必须遵守）】',
        '所有输出的文本字段绝不使用破折号"——"。转折用句号分割独立句，补充说明用逗号，列举用顿号，悬念收尾用省略号。',
      ].join('\n'),
      foreshadow: () => [
        '请根据以下核心描述，生成一个完整的伏笔设定。',
        '',
        FORESHADOW_ADMISSION_PROMPT,
        '',
        '【核心描述】',
        coreStyle,
        '',
        '【输出要求】',
        '请返回 JSON 格式，包含以下字段：',
        '- description: 伏笔的一句话描述',
        '- category: 伏笔类别，从以下枚举中选择一个（不同类别有不同回收规律）：',
        '    - item: 物品（物品再次出现时回收）',
        '    - spoken: 言语（在说出者面前应验时回收）',
        '    - event: 事件（事件触发时回收）',
        '    - identity: 身份（身份揭晓时回收）',
        '    - secret: 秘密（秘密暴露时回收）',
        '    - prophecy: 预言（兑现时回收）',
        '    - promise: 承诺（在承诺人面前兑现时回收）',
        '    - quote: 台词（台词应验时回收）',
        '- status: 伏笔当前状态，从以下枚举中选择一个：planned/planted/reinforced/partially_revealed/recovering/recovered/abandoned',
        '- linkedCharacters: 关联角色描述（字符串，可多个，逗号分隔）',
        '- linkedClues: 关联线索描述（字符串，可多个，逗号分隔）',
        '- plantMethod: 埋设方式，从以下枚举中选择一个（指导埋设时的手法）：',
        '    - explicit: 明写（直接点破，读者立刻知道是伏笔）',
        '    - implicit: 暗写（藏在对话或动作里，读者需要细品）',
        '    - indirect: 侧写（通过他人视角提及，间接埋设）',
        '- recoverMethod: 回收方式，从以下枚举中选择一个（指导回收时的手法）：',
        '    - explicit: 明回收（直接点破，与埋设呼应）',
        '    - implicit: 暗回收（让读者自己悟，不点破）',
        '    - reverse: 反向回收（与埋设相反，制造反转）',
        '    - progressive: 递进回收（多次点破，逐步释放）',
        '',
        '【输出约束（必须遵守）】',
        '所有输出的文本字段绝不使用破折号"——"。转折用句号分割独立句，补充说明用逗号，列举用顿号，悬念收尾用省略号。',
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
        '',
        '【输出约束（必须遵守）】',
        '所有输出的文本字段绝不使用破折号"——"。转折用句号分割独立句，补充说明用逗号，列举用顿号，悬念收尾用省略号。',
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
        '',
        '【输出约束（必须遵守）】',
        '所有输出的文本字段绝不使用破折号"——"。转折用句号分割独立句，补充说明用逗号，列举用顿号，悬念收尾用省略号。',
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
        '',
        '【输出约束（必须遵守）】',
        '所有输出的文本字段绝不使用破折号"——"。转折用句号分割独立句，补充说明用逗号，列举用顿号，悬念收尾用省略号。',
      ].join('\n'),
    }
    return builders[kind as Exclude<EntityKind, 'character'>]()
  }

  private parseResult(kind: EntityKind, text: string, coreStyle: string, projectId?: string): GeneratedEntity['data'] {
    const parsed = repairAndParseJson(text)
    if (parsed) {
      try {
        switch (kind) {
          case 'conflict':
            return this.parseConflict(parsed, projectId)
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
        return this.buildTemplate(kind, coreStyle) as GeneratedEntity['data']
      }
    } else {
      this.context.logger.warn(
        { kind, textPreview: text.slice(0, 200) },
        `解析 LLM 返回的 ${this.kindLabel(kind)} JSON 失败（可能被截断），回退到模板`,
      )
      return this.buildTemplate(kind, coreStyle) as GeneratedEntity['data']
    }
  }

  /**
   * 解析冲突字段
   *
   * @param projectId 用于把 participants 名字解析为角色 ID（如果未传则保留原始字符串数组）
   *
   * participants 格式统一：
   * - LLM 输出：JSON 数组（如 ["林墨","苏晚"]）或逗号分隔字符串（旧格式兜底）
   * - 解析后：调用 ensureStringArray 得到 string[]（角色名）
   * - 若传入 projectId：查询项目角色列表，按名字精确匹配得到 characterId[]
   *   匹配失败的名字记录到日志但不阻塞（保留已匹配的 IDs）
   * - 最终 JSON.stringify(ids) 落库，与路由层 / 工具层 / Memory Agent 保持一致
   *
   * plotFunction / progressionMode（四层逻辑③：功能层）：
   * - LLM 输出英文枚举字符串
   * - 用 VALID_xxx 数组校验后赋值，无效值回退到 undefined / 'linear'
   *   不抛错（让 store 层 rowToConflict 在写入 NULL 时再兜底）
   */
  private parseConflict(p: Record<string, unknown>, projectId?: string): GeneratedConflict {
    const validTypes = ['inner', 'relationship', 'faction', 'interest', 'moral', 'identity', 'emotional', 'world_rule', 'survival']
    const validStages = ['latent', 'emerging', 'escalating', 'erupting', 'reversing', 'resolved', 'transformed']
    const validTiers = ['main', 'secondary', 'goal']
    const validClimaxTypes = ['emotional', 'fate', 'character', 'combat', 'theme', 'composite']
    const climaxChapterRaw = p.climaxChapter
    const climaxChapter = typeof climaxChapterRaw === 'number' && Number.isFinite(climaxChapterRaw) && climaxChapterRaw > 0
      ? climaxChapterRaw
      : null

    // participants：先抽取角色名数组，再解析为 characterId[]（如有 projectId）
    const participantNames = ensureStringArray(p.participants)
    const participantIds = this.resolveParticipantIds(participantNames, projectId)
    const participantsJson = JSON.stringify(participantIds)

    // plotFunction / progressionMode：枚举校验后赋值，无效值不抛错（让 store 层 normalize 兜底）
    const validPlotFunctions = ['provide_resource', 'create_obstacle', 'amplify_conflict', 'open_phase', 'change_judgment', 'advance_relationship', 'reveal_world_rule']
    const validProgressionModes = ['linear', 'mutation', 'stagnation', 'regression', 'reversal']
    const plotFunction = validPlotFunctions.includes(p.plotFunction as string)
      ? (p.plotFunction as GeneratedConflict['plotFunction'])
      : undefined
    const progressionMode = validProgressionModes.includes(p.progressionMode as string)
      ? (p.progressionMode as GeneratedConflict['progressionMode'])
      : undefined

    return {
      description: ensureString(p.description, ''),
      type: (validTypes.includes(p.type as string) ? p.type : 'relationship') as NovelConflict['type'],
      intensity: ensureNumber(p.intensity, 5, 1, 10),
      stage: (validStages.includes(p.stage as string) ? p.stage : 'emerging') as NovelConflict['stage'],
      tier: (validTiers.includes(p.tier as string) ? p.tier : 'secondary') as NovelConflict['tier'],
      participants: participantsJson,
      climaxChapter,
      climaxType: (validClimaxTypes.includes(p.climaxType as string) ? p.climaxType : null) as NovelConflict['climaxType'],
      stakes: typeof p.stakes === 'string' && p.stakes.trim() ? p.stakes.trim() : null,
      twistPotential: typeof p.twistPotential === 'number' && Number.isFinite(p.twistPotential)
        ? Math.max(0, Math.min(10, Math.round(p.twistPotential)))
        : undefined,
      plotFunction,
      progressionMode,
    }
  }

  /**
   * 把参与者名字列表解析为 characterId 列表
   *
   * - 无 projectId：直接返回原始名字（让前端可看到名字，落库时由调用方处理）
   *   注意：当前调用方（generate）已传 projectId，此分支仅作向后兼容
   * - 有 projectId：listCharacters 后按 name 精确匹配（大小写敏感）
   *   未匹配的名字记录 warn 但不抛错，避免 LLM 输出小瑕疵导致整次生成失败
   * - 同名冲突：取首个匹配（项目内同名字符色属于配置问题，不在解析层处理）
   */
  private resolveParticipantIds(names: string[], projectId?: string): string[] {
    if (!projectId || names.length === 0) return []
    const characters = this.store.listCharacters(projectId)
    const resolved: string[] = []
    const unmatched: string[] = []
    for (const name of names) {
      const matched = characters.find((c) => c.name === name)
      if (matched) {
        resolved.push(matched.id)
      } else {
        unmatched.push(name)
      }
    }
    if (unmatched.length > 0) {
      this.context.logger.warn(
        { projectId, unmatched, totalNames: names.length, resolvedCount: resolved.length },
        '冲突参与者名字解析：部分名字未匹配到角色 ID（已忽略，仅保留匹配项）',
      )
    }
    return resolved
  }

  private parseForeshadow(p: Record<string, unknown>): GeneratedForeshadow {
    const validStatus = ['planned', 'planted', 'reinforced', 'partially_revealed', 'recovering', 'recovered', 'abandoned']
    // 四层逻辑③：category 改为枚举校验 + 中文旧值兼容
    const validCategories: GeneratedForeshadow['category'][] = ['item', 'spoken', 'event', 'identity', 'secret', 'prophecy', 'promise', 'quote']
    const categoryCnMap: Record<string, GeneratedForeshadow['category']> = {
      '物品': 'item', '言语': 'spoken', '事件': 'event', '身份': 'identity',
      '秘密': 'secret', '预言': 'prophecy', '承诺': 'promise', '台词': 'quote',
    }
    const rawCategory = ensureString(p.category, '')
    const lowerCategory = rawCategory.toLowerCase()
    const category: GeneratedForeshadow['category'] = validCategories.includes(rawCategory as GeneratedForeshadow['category'])
      ? rawCategory as GeneratedForeshadow['category']
      : (categoryCnMap[rawCategory]
          ?? (validCategories.includes(lowerCategory as GeneratedForeshadow['category'])
            ? lowerCategory as GeneratedForeshadow['category']
            : 'item'))

    // plantMethod / recoverMethod：枚举校验，无效值回退到 undefined
    const validPlantMethods: GeneratedForeshadow['plantMethod'][] = ['explicit', 'implicit', 'indirect']
    const validRecoverMethods: GeneratedForeshadow['recoverMethod'][] = ['explicit', 'implicit', 'reverse', 'progressive']
    const plantMethod = validPlantMethods.includes(p.plantMethod as GeneratedForeshadow['plantMethod'])
      ? (p.plantMethod as GeneratedForeshadow['plantMethod'])
      : undefined
    const recoverMethod = validRecoverMethods.includes(p.recoverMethod as GeneratedForeshadow['recoverMethod'])
      ? (p.recoverMethod as GeneratedForeshadow['recoverMethod'])
      : undefined

    return {
      description: ensureString(p.description, ''),
      category,
      status: (validStatus.includes(p.status as string) ? p.status : 'planted') as NovelForeshadow['status'],
      linkedCharacters: ensureString(p.linkedCharacters, ''),
      linkedClues: ensureString(p.linkedClues, ''),
      plantMethod,
      recoverMethod,
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
          climaxChapter: null,
          climaxType: null,
          stakes: null,
          twistPotential: undefined,
          // 与 parseConflict 输出一致：JSON.stringify(string[]) 形式
          participants: '[]',
          // 四层逻辑③：默认不指定功能位与推进模式，由 store 层 normalize 兜底（linear）
          plotFunction: undefined,
          progressionMode: undefined,
        }
      case 'foreshadow':
        return {
          description: trimmed || '未命名伏笔',
          // 与 parseForeshadow 一致：新枚举值（默认 item 物品）
          category: 'item',
          status: 'planned',
          linkedCharacters: '',
          linkedClues: '',
          plantMethod: undefined,
          recoverMethod: undefined,
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
