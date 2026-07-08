/**
 * NovelMemoryGenerator：记忆 Agent 的结构化 LLM 调用实现
 *
 * 替代原 Memory Agent 的"LLM 工具循环"模式（18 个工具、易不收敛、300s 超时），
 * 改为与 character-generator / entity-generator 一致的技术方案：
 * - 单次 LLM 调用，输入章节正文 + 当前实体状态
 * - LLM 输出结构化 JSON 变更列表
 * - 代码遍历 JSON，调用 store API 批量应用变更
 *
 * 优势：
 * 1. 一次 LLM 调用即可完成（~30s 而非 300s 的工具循环）
 * 2. 不会陷入工具调用循环无法收敛
 * 3. 与 character-generator / entity-generator 技术栈统一
 * 4. LLM 输出可控、可解析、可流式推送进度
 *
 * 与 NovelOrchestrator 的协作：
 * - orchestrator 在 Memory 阶段调用 generator.generate()
 * - generator 应用变更后返回 summary
 * - orchestrator 的 recordMemoryEvents 仍通过前后状态对比捕获记忆事件
 *   （不依赖 generator 内部如何应用变更，只要 store 状态变化即可被对比逻辑捕获）
 */

import { randomUUID } from 'node:crypto'
import type { PluginContext } from '../../../core/plugin/plugin-types.js'
import type { NovelPromptBuilder } from './prompt-builder.js'
import type { PromptManager } from './prompt-manager.js'
import type { NovelStore } from './novel-store.js'
import type { NovelEngine } from './novel-engine.js'
import type {
  NovelCharacter,
  NovelConflict,
  NovelForeshadow,
  NovelFaction,
  NovelLocation,
  NovelRelationship,
  RelationChange,
} from './types.js'

// ── 进度事件 ──

export interface MemoryGenerationProgressEvent {
  phase: 'preparing' | 'generating' | 'parsing' | 'applying' | 'completed' | 'fallback'
  message: string
  data?: unknown
}

// ── LLM 输出类型（宽松解析，字段全部可选）──

interface CharacterUpdateItem {
  name?: string
  currentState?: string
  currentGoal?: string
  currentPressure?: string
  secret?: string
  arcStage?: string
  /** 长期欲望（四层逻辑①，跨章节稳定的发动机） */
  longTermDesire?: string
  /** 删掉影响（四层逻辑④，描述该角色对剧情的不可替代性） */
  removalImpact?: string
}

interface CharacterCreateItem {
  name?: string
  description?: string
  identity?: string
  personality?: string
  appearance?: string
  currentState?: string
  currentGoal?: string
  currentPressure?: string
  secret?: string
  arcStage?: string
  speechStyle?: string
  /** 长期欲望（四层逻辑①） */
  longTermDesire?: string
  /** 角色层级（四层逻辑②：protagonist/main_opponent/supporting/function/background） */
  plotRole?: string
  /** 删掉影响（四层逻辑④） */
  removalImpact?: string
}

interface ForeshadowUpdateItem {
  description?: string
  status?: string
  // ── P2-2：伏笔埋设/回收方式 ──
  plantMethod?: string
  recoverMethod?: string
}

interface ForeshadowCreateItem {
  description?: string
  category?: string
  linkedCharacters?: string[]
  // ── P2-2：伏笔埋设/回收方式 ──
  plantMethod?: string
  recoverMethod?: string
}

interface ConflictUpdateItem {
  description?: string
  stage?: string
  intensity?: number
  // ── P2-1：冲突功能位 + 非线性推进 ──
  plotFunction?: string
  progressionMode?: string
}

interface ConflictCreateItem {
  description?: string
  type?: string
  intensity?: number
  stage?: string
  participants?: string[]
  // ── P2-1：冲突功能位 + 非线性推进 ──
  plotFunction?: string
  progressionMode?: string
}

interface RelationshipUpdateItem {
  /** 角色名匹配（与 conflictCreates.participants 同模式） */
  characterA?: string
  characterB?: string
  /** 当前阶段 */
  currentStage?: string
  /** 动态功能位 */
  dynamicRole?: string
  /** 阵营关系 */
  alignment?: string
  /** 走向 */
  trend?: string
  /** 本章关系约束提示 */
  chapterHint?: string
  /** 阶段变更原因（写入 stageHistory 的 reason） */
  changeReason?: string
}

interface RelationshipCreateItem {
  characterA?: string
  characterB?: string
  relationType?: string
  currentStage?: string
  dynamicRole?: string
  alignment?: string
  trend?: string
  chapterHint?: string
}

interface FactionUpdateItem {
  name?: string
  status?: string
  strength?: string
}

interface LocationUpdateItem {
  name?: string
  status?: string
}

interface MemoryUpdatePayload {
  characterUpdates?: CharacterUpdateItem[]
  characterCreates?: CharacterCreateItem[]
  foreshadowUpdates?: ForeshadowUpdateItem[]
  foreshadowCreates?: ForeshadowCreateItem[]
  conflictUpdates?: ConflictUpdateItem[]
  conflictCreates?: ConflictCreateItem[]
  factionUpdates?: FactionUpdateItem[]
  locationUpdates?: LocationUpdateItem[]
  // ── 四层逻辑②：关系层 Memory Agent 支持 ──
  relationshipUpdates?: RelationshipUpdateItem[]
  relationshipCreates?: RelationshipCreateItem[]
  summary?: string
}

// ── 应用结果统计 ──

export interface MemoryApplyStats {
  characterUpdatesApplied: number
  characterCreatesApplied: number
  foreshadowUpdatesApplied: number
  foreshadowCreatesApplied: number
  conflictUpdatesApplied: number
  conflictCreatesApplied: number
  factionUpdatesApplied: number
  locationUpdatesApplied: number
  relationshipUpdatesApplied: number
  relationshipCreatesApplied: number
  total: number
}

export interface MemoryGenerationResult {
  /** LLM 生成的本章状态变更简述 */
  summary: string
  /** 应用统计 */
  stats: MemoryApplyStats
}

/** 将任意 LLM 输出值安全转为 string，防止数组/对象传到 SQLite */
function ensureString(value: unknown, defaultValue: string): string {
  if (typeof value === 'string') return value
  if (value == null) return defaultValue
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** 安全转 number */
function ensureNumber(value: unknown, defaultValue: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return defaultValue
}

export class NovelMemoryGenerator {
  constructor(
    private promptBuilder: NovelPromptBuilder,
    private promptManager: PromptManager,
    private context: PluginContext,
    private store: NovelStore,
    private engine: NovelEngine,
  ) {}

  /**
   * 从章节正文中提取状态变更并应用到故事状态系统
   *
   * @param projectId 项目 ID
   * @param chapterNumber 章节号
   * @param chapterContent 章节正文
   * @param onProgress 进度回调（用于 SSE 推送）
   * @returns 状态变更简述 + 应用统计
   */
  async generate(
    projectId: string,
    chapterNumber: number,
    chapterContent: string,
    onProgress?: (event: MemoryGenerationProgressEvent) => void,
  ): Promise<MemoryGenerationResult> {
    // ── 1. 构建系统提示词（与 character-generator 一致的技术栈）──
    // agentType 使用 'memory-generator'，promptBuilder 通过 role-memory-generator 模板加载角色定义
    onProgress?.({ phase: 'preparing', message: '正在构建记忆提取提示词...' })
    const systemPrompt = this.promptBuilder.buildSystemPrompt(projectId, 'memory-generator')

    // ── 2. 构建用户消息：章节正文 + 当前实体状态 ──
    // ⚠️ Token 优化：Memory 的任务是"从章节正文中提取状态变更"，只需要：
    //   - 章节正文（已在 userPrompt 中）
    //   - 当前实体状态（已在 userPrompt 中通过 getCurrentEntityState 注入）
    //   - system_prompt（system-base.md + role-memory-generator.md，含全局铁律）
    // 不需要注入 chapterContext（章节信息 + 约束 + 故事状态 + 摘要 + 因果链），
    // 这些对"状态变更提取"无用，且会让 Memory 的输入膨胀 10K+ 字符。
    // 预期节省 ~10K 字符 / 7K tokens。
    const userPrompt = this.buildUserPrompt(projectId, chapterNumber, chapterContent)

    // ── 3. 创建独立 Session 调用 LLM（单次调用，输出 JSON）──
    onProgress?.({ phase: 'generating', message: '记忆 Agent 正在分析章节状态变更...' })
    const session = await this.context.createSession({
      systemPrompt,
      // 不注入 prefixUserMessage（chapterContext）：Memory 不需要章节上下文，
      // 只需要章节正文 + 当前实体状态（均在 userMessage 中）
      userMessage: userPrompt,
      responseFormat: 'json',
      // 记忆提取需要分析整章正文 + 全量实体状态，LLM 耗时较长
      // 但远低于工具循环模式的 300s（单次调用通常 30-60s）
      timeoutMs: 300_000,
    })

    let payload: MemoryUpdatePayload
    try {
      let streamedText = ''
      const result = await session.promptStream((delta) => {
        streamedText += delta
        const partial = streamedText.slice(-200)
        onProgress?.({
          phase: 'generating',
          message: '记忆 Agent 正在分析章节状态变更...',
          data: { partial },
        })
      })

      this.context.logger.info(
        {
          projectId,
          chapterNumber,
          resultLength: result.length,
        },
        '记忆 Agent LLM 调用完成',
      )

      // ── 4. 解析 JSON ──
      onProgress?.({ phase: 'parsing', message: '正在解析变更列表...' })
      payload = this.parseResult(result)
    } catch (err) {
      this.context.logger.error(
        { projectId, chapterNumber, err },
        '记忆 Agent LLM 调用失败，回退到空变更',
      )
      onProgress?.({ phase: 'fallback', message: '记忆 Agent 调用失败，跳过状态更新' })
      return {
        summary: '记忆提取失败，未应用状态变更',
        stats: this.emptyStats(),
      }
    } finally {
      session.dispose()
    }

    // ── 5. 应用变更到 store ──
    onProgress?.({ phase: 'applying', message: '正在应用状态变更到故事系统...' })
    const stats = this.applyChanges(projectId, payload, chapterNumber)

    const summary = payload.summary?.trim() || `已应用 ${stats.total} 项状态变更`
    onProgress?.({
      phase: 'completed',
      message: `记忆提取完成：${summary}（应用 ${stats.total} 项变更）`,
      data: { stats },
    })

    return { summary, stats }
  }

  /**
   * 全量校准：扫描最近 N 章正文，对比当前实体状态，修复遗漏的状态变更。
   *
   * 设计意图：
   * - Memory Agent 逐章提取状态变更，但如果 LLM 漏提取了某个变更（如角色微妙的态度转变），
   *   这个信息会永远丢失。长篇小说累积下来，状态系统会和正文越来越脱节。
   * - 每 10 章触发一次全量校准，拉取最近 5 章正文 + 当前实体状态，
   *   让 LLM 做一次"查漏补缺"式的状态提取。
   * - 复用 generate 的 LLM 调用 + JSON 解析 + applyChanges 逻辑，
   *   但 userPrompt 改为"多章对比校准"模式。
   *
   * @param projectId 项目 ID
   * @param currentChapterNumber 当前章节号（校准范围：currentChapterNumber-4 到 currentChapterNumber）
   * @param onProgress 进度回调
   */
  async runFullCalibration(
    projectId: string,
    currentChapterNumber: number,
    onProgress?: (event: MemoryGenerationProgressEvent) => void,
  ): Promise<MemoryGenerationResult> {
    const calibrationRange = 5 // 校准最近 5 章
    const startChapter = Math.max(1, currentChapterNumber - calibrationRange + 1)

    onProgress?.({ phase: 'preparing', message: `正在构建全量校准提示词（第 ${startChapter}-${currentChapterNumber} 章）...` })

    // 拉取最近 N 章正文
    const recentChapters = this.store.listRecentChapters(projectId, calibrationRange)
      .filter(ch => ch.chapterNumber >= startChapter && ch.chapterNumber <= currentChapterNumber)
      .filter(ch => ch.content && ch.content.trim().length > 50)
      .sort((a, b) => a.chapterNumber - b.chapterNumber)

    if (recentChapters.length === 0) {
      return { summary: '全量校准跳过：无可用章节正文', stats: this.emptyStats() }
    }

    // 构建校准专用 userPrompt
    const parts: string[] = []
    parts.push('## 全量状态校准')
    parts.push('')
    parts.push('你正在进行全量状态校准。以下是最近几章的正文和当前实体状态。')
    parts.push('请仔细对比正文内容与当前实体状态，找出**遗漏的状态变更**——那些在正文中发生但当前状态未反映的变化。')
    parts.push('')
    parts.push('### 校准范围')
    parts.push(`第 ${startChapter} 章 到 第 ${currentChapterNumber} 章（共 ${recentChapters.length} 章）`)
    parts.push('')

    for (const ch of recentChapters) {
      // 每章截取前 1500 字（避免 prompt 过大）
      const content = ch.content.slice(0, 1500)
      parts.push(`### 第 ${ch.chapterNumber} 章《${ch.title}》`)
      parts.push(content)
      if (ch.content.length > 1500) parts.push('...(截断)')
      parts.push('')
    }

    // 当前实体状态
    const entityState = this.getCurrentEntityState(projectId)
    if (entityState) {
      parts.push('## 当前实体状态（校准基准）')
      parts.push(entityState)
      parts.push('')
    }

    parts.push('## 输出要求')
    parts.push('请返回 JSON 格式的变更列表，只包含**遗漏的、当前状态未反映的**变更。')
    parts.push('不要重复已有状态，只补充缺失的状态变更。格式与单章提取一致。')

    const userPrompt = parts.join('\n')
    const systemPrompt = this.promptBuilder.buildSystemPrompt(projectId, 'memory-generator')

    // 创建 LLM Session
    onProgress?.({ phase: 'generating', message: '全量校准 Agent 正在分析最近章节状态...' })
    const session = await this.context.createSession({
      systemPrompt,
      userMessage: userPrompt,
      responseFormat: 'json',
      timeoutMs: 300_000,
    })

    let payload: MemoryUpdatePayload
    try {
      let streamedText = ''
      const result = await session.promptStream((delta) => {
        streamedText += delta
        const partial = streamedText.slice(-200)
        onProgress?.({
          phase: 'generating',
          message: '全量校准 Agent 正在分析最近章节状态...',
          data: { partial },
        })
      })

      this.context.logger.info(
        { projectId, currentChapterNumber, calibrationRange: recentChapters.length, resultLength: result.length },
        '全量校准 LLM 调用完成',
      )

      onProgress?.({ phase: 'parsing', message: '正在解析校准变更列表...' })
      payload = this.parseResult(result)
    } catch (err) {
      this.context.logger.error(
        { projectId, currentChapterNumber, err },
        '全量校准 LLM 调用失败',
      )
      onProgress?.({ phase: 'fallback', message: '全量校准失败，跳过' })
      return { summary: '全量校准失败', stats: this.emptyStats() }
    } finally {
      session.dispose()
    }

    // 应用校准变更
    onProgress?.({ phase: 'applying', message: '正在应用校准变更到故事系统...' })
    const stats = this.applyChanges(projectId, payload, currentChapterNumber)

    const summary = payload.summary?.trim() || `全量校准完成：应用 ${stats.total} 项遗漏变更`
    onProgress?.({
      phase: 'completed',
      message: `全量校准完成：${summary}（应用 ${stats.total} 项变更）`,
      data: { stats, calibration: true },
    })

    return { summary, stats }
  }

  // ═══════════════════════════════════════════════════════════════
  // 提示词构建
  // ═══════════════════════════════════════════════════════════════

  private buildUserPrompt(projectId: string, chapterNumber: number, chapterContent: string): string {
    const parts: string[] = []

    parts.push(`请从第 ${chapterNumber} 章中提取状态变更，按指定 JSON 格式输出。`)

    parts.push('## 章节正文\n')
    parts.push(chapterContent)

    // 当前实体状态（精简版，只含 name + 关键动态字段，避免 prompt 过大）
    const entityState = this.getCurrentEntityState(projectId)
    if (entityState) {
      parts.push('\n## 当前实体状态（用于判断变更）\n')
      parts.push(entityState)
    }

    parts.push('\n## 输出要求\n')
    parts.push('请返回 JSON 格式的变更列表，只包含发生变化的字段。不要复述章节内容，不要创作正文。')

    return parts.join('\n')
  }

  /** 获取当前实体状态的精简描述（仅含 name + 动态字段，避免 prompt 过大） */
  private getCurrentEntityState(projectId: string): string {
    const parts: string[] = []

    // 角色
    const characters = this.store.listCharacters(projectId)
    if (characters.length > 0) {
      parts.push('### 角色')
      for (const c of characters) {
        const fields = [
          `currentState: ${c.currentState || '(空)'}`,
          `currentGoal: ${c.currentGoal || '(空)'}`,
          `currentPressure: ${c.currentPressure || '(空)'}`,
          `arcStage: ${c.arcStage || '(空)'}`,
          `longTermDesire: ${c.longTermDesire || '(空)'}`,
          `plotRole: ${c.plotRole}`,
          `removalImpact: ${c.removalImpact || '(空)'}`,
        ]
        parts.push(`- ${c.name}（ID: ${c.id}）: ${fields.join(' | ')}`)
      }
    }

    // 冲突
    const conflicts = this.store.listConflicts(projectId)
    if (conflicts.length > 0) {
      parts.push('\n### 冲突')
      for (const c of conflicts) {
        const fields = [
          `stage=${c.stage}`,
          `intensity=${c.intensity}`,
          `plotFunction=${c.plotFunction ?? '(未指定)'}`,
          `progressionMode=${c.progressionMode ?? 'linear'}`,
        ]
        parts.push(`- ${c.description.slice(0, 60)}（ID: ${c.id}）: ${fields.join(' | ')}`)
      }
    }

    // 伏笔
    const foreshadows = this.store.listForeshadowing(projectId)
    if (foreshadows.length > 0) {
      parts.push('\n### 伏笔')
      for (const f of foreshadows) {
        const fields = [
          `status=${f.status}`,
          `category=${f.category}`,
          `plantMethod=${f.plantMethod ?? '(未指定)'}`,
          `recoverMethod=${f.recoverMethod ?? '(未指定)'}`,
        ]
        parts.push(`- ${f.description.slice(0, 60)}（ID: ${f.id}）: ${fields.join(' | ')}`)
      }
    }

    // 势力
    const factions = this.store.listFactions(projectId)
    if (factions.length > 0) {
      parts.push('\n### 势力')
      for (const f of factions) {
        parts.push(`- ${f.name}（ID: ${f.id}）: status=${f.status} | strength=${f.strength}`)
      }
    }

    // 地点
    const locations = this.store.listLocations(projectId)
    if (locations.length > 0) {
      parts.push('\n### 地点')
      for (const l of locations) {
        parts.push(`- ${l.name}（ID: ${l.id}）: status=${l.status}`)
      }
    }

    // 关系（四层逻辑②：让 Memory Agent 看到当前关系状态，以便判断关系变更）
    const relationships = this.store.listRelationships(projectId)
    if (relationships.length > 0) {
      const charNameMap = new Map(characters.map((c) => [c.id, c.name]))
      parts.push('\n### 关系')
      for (const r of relationships) {
        const nameA = charNameMap.get(r.characterA) ?? r.characterA
        const nameB = charNameMap.get(r.characterB) ?? r.characterB
        const fields = [
          `relationType: ${r.relationType || '(空)'}`,
          `currentStage: ${r.currentStage || '(空)'}`,
          `dynamicRole: ${r.dynamicRole || '(空)'}`,
          `alignment: ${r.alignment}`,
          `trend: ${r.trend}`,
        ]
        if (r.chapterHint) fields.push(`chapterHint: ${r.chapterHint}`)
        parts.push(`- ${nameA} ↔ ${nameB}（ID: ${r.id}）: ${fields.join(' | ')}`)
      }
    }

    return parts.join('\n')
  }

  // ═══════════════════════════════════════════════════════════════
  // JSON 解析（与 character-generator 一致的鲁棒解析）
  // ═══════════════════════════════════════════════════════════════

  private parseResult(text: string): MemoryUpdatePayload {
    // 提取 JSON：先尝试完整代码块，再处理截断的未闭合代码块
    let jsonStr: string
    const closedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (closedMatch) {
      jsonStr = closedMatch[1].trim()
    } else {
      const unclosedMatch = text.match(/```(?:json)?\s*([\s\S]*)/)
      jsonStr = unclosedMatch ? unclosedMatch[1].trim() : text.trim()
    }

    let parsed: MemoryUpdatePayload | null = null

    try {
      parsed = JSON.parse(jsonStr) as MemoryUpdatePayload
    } catch {
      // 继续
    }

    if (!parsed) {
      // 截尾补全：逐步回退尝试
      let truncated = jsonStr
      for (let i = 0; i < 5; i++) {
        const lastValid = Math.max(
          truncated.lastIndexOf(','),
          truncated.lastIndexOf('"'),
          truncated.lastIndexOf('}'),
          truncated.lastIndexOf(']'),
        )
        if (lastValid <= 0) break
        truncated = truncated.slice(0, lastValid + 1)
        truncated = truncated.replace(/,\s*$/, '')
        const opens = (truncated.match(/[{\[]/g) ?? []).length
        const closes = (truncated.match(/[}\]]/g) ?? []).length
        const needClose = opens - closes
        if (needClose <= 0) continue
        let repaired = truncated
        for (let j = 0; j < needClose; j++) repaired += '}'
        try {
          parsed = JSON.parse(repaired) as MemoryUpdatePayload
          break
        } catch {
          // 继续
        }
      }
    }

    if (!parsed || typeof parsed !== 'object') {
      this.context.logger.warn(
        { textPreview: text.slice(0, 200) },
        '记忆 Agent JSON 解析失败，使用空变更',
      )
      return {}
    }

    return parsed
  }

  // ═══════════════════════════════════════════════════════════════
  // 应用变更到 store
  // ═══════════════════════════════════════════════════════════════

  private applyChanges(projectId: string, payload: MemoryUpdatePayload, chapterNumber?: number): MemoryApplyStats {
    const stats = this.emptyStats()

    // ── 角色更新 ──
    for (const item of payload.characterUpdates ?? []) {
      const character = this.findCharacterByName(projectId, item.name)
      if (!character) {
        this.context.logger.warn(
          { name: item.name, projectId },
          '记忆 Agent：未找到要更新的角色，跳过',
        )
        continue
      }
      const patch: Partial<NovelCharacter> = {}
      if (item.currentState !== undefined) patch.currentState = ensureString(item.currentState, character.currentState)
      if (item.currentGoal !== undefined) patch.currentGoal = ensureString(item.currentGoal, character.currentGoal)
      if (item.currentPressure !== undefined) patch.currentPressure = ensureString(item.currentPressure, character.currentPressure)
      if (item.secret !== undefined) patch.secret = ensureString(item.secret, character.secret)
      if (item.arcStage !== undefined) patch.arcStage = ensureString(item.arcStage, character.arcStage)
      // 四层逻辑①④：长期欲望和删掉影响也可被 Memory Agent 更新
      if (item.longTermDesire !== undefined) patch.longTermDesire = ensureString(item.longTermDesire, character.longTermDesire)
      if (item.removalImpact !== undefined) patch.removalImpact = ensureString(item.removalImpact, character.removalImpact)
      if (Object.keys(patch).length === 0) continue
      this.store.updateCharacter(character.id, patch)
      stats.characterUpdatesApplied++
    }

    // ── 角色创建 ──
    for (const item of payload.characterCreates ?? []) {
      if (!item.name) continue
      const validPlotRoles = ['protagonist', 'main_opponent', 'supporting', 'function', 'background']
      this.store.createCharacter({
        id: randomUUID(),
        projectId,
        name: ensureString(item.name, ''),
        description: ensureString(item.description, ''),
        identity: ensureString(item.identity, ''),
        personality: ensureString(item.personality, ''),
        appearance: ensureString(item.appearance, ''),
        currentState: ensureString(item.currentState, ''),
        currentGoal: ensureString(item.currentGoal, ''),
        currentPressure: ensureString(item.currentPressure, ''),
        secret: ensureString(item.secret, ''),
        arcStage: ensureString(item.arcStage, 'introduction'),
        arcHistory: '[]',
        speechStyle: ensureString(item.speechStyle, ''),
        isProtagonist: false,
        // 四层逻辑补全字段（新建角色时也要带上）
        longTermDesire: ensureString(item.longTermDesire, ''),
        plotRole: (validPlotRoles.includes(item.plotRole ?? '') ? item.plotRole : 'supporting') as NovelCharacter['plotRole'],
        removalImpact: ensureString(item.removalImpact, '暂无关键影响'),
      })
      stats.characterCreatesApplied++
    }

    // ── 伏笔更新 ──
    for (const item of payload.foreshadowUpdates ?? []) {
      const foreshadow = this.findForeshadowByDescription(projectId, item.description)
      if (!foreshadow) {
        this.context.logger.warn(
          { description: item.description, projectId },
          '记忆 Agent：未找到要更新的伏笔，跳过',
        )
        continue
      }
      const patch: Partial<NovelForeshadow> = {}
      if (item.status !== undefined) patch.status = ensureString(item.status, foreshadow.status) as NovelForeshadow['status']
      // ── P2-2：埋设/回收方式 ──
      if (item.plantMethod !== undefined) {
        patch.plantMethod = ensureString(item.plantMethod, '') as NovelForeshadow['plantMethod']
      }
      if (item.recoverMethod !== undefined) {
        patch.recoverMethod = ensureString(item.recoverMethod, '') as NovelForeshadow['recoverMethod']
      }
      if (Object.keys(patch).length === 0) continue
      this.store.updateForeshadow(foreshadow.id, patch)
      stats.foreshadowUpdatesApplied++
    }

    // ── 伏笔创建 ──
    for (const item of payload.foreshadowCreates ?? []) {
      if (!item.description) continue
      // linkedCharacters 通过名字查找 ID
      const linkedCharacterIds = (item.linkedCharacters ?? [])
        .map((name) => this.findCharacterByName(projectId, name)?.id)
        .filter((id): id is string => !!id)
      this.store.createForeshadow({
        id: randomUUID(),
        projectId,
        description: ensureString(item.description, ''),
        category: ensureString(item.category, 'event') as NovelForeshadow['category'],
        status: 'planted',
        firstChapter: null,
        lastChapter: null,
        recoverByChapter: null,
        linkedCharacters: JSON.stringify(linkedCharacterIds),
        linkedClues: '[]',
        plantMethod: item.plantMethod as NovelForeshadow['plantMethod'],
        recoverMethod: item.recoverMethod as NovelForeshadow['recoverMethod'],
        linkedInfoLayers: '[]',
        // 迁移 055：未指定 firstChapter 时 chapterSpans 为 []（进元素池，矩阵不渲染行）
        chapterSpans: [],
      })
      stats.foreshadowCreatesApplied++
    }

    // ── 冲突更新 ──
    for (const item of payload.conflictUpdates ?? []) {
      const conflict = this.findConflictByDescription(projectId, item.description)
      if (!conflict) {
        this.context.logger.warn(
          { description: item.description, projectId },
          '记忆 Agent：未找到要更新的冲突，跳过',
        )
        continue
      }
      const patch: Partial<NovelConflict> = {}
      if (item.stage !== undefined) patch.stage = ensureString(item.stage, conflict.stage) as NovelConflict['stage']
      if (item.intensity !== undefined) {
        const intensity = ensureNumber(item.intensity, conflict.intensity)
        patch.intensity = Math.max(1, Math.min(10, intensity))
      }
      // ── P2-1：功能位 + 推进模式 ──
      if (item.plotFunction !== undefined) {
        patch.plotFunction = ensureString(item.plotFunction, '') as NovelConflict['plotFunction']
      }
      if (item.progressionMode !== undefined) {
        patch.progressionMode = ensureString(item.progressionMode, '') as NovelConflict['progressionMode']
      }
      if (Object.keys(patch).length === 0) continue
      this.store.updateConflict(conflict.id, patch)
      stats.conflictUpdatesApplied++
    }

    // ── 冲突创建 ──
    for (const item of payload.conflictCreates ?? []) {
      if (!item.description) continue
      // participants 通过名字查找 ID
      const participantIds = (item.participants ?? [])
        .map((name) => this.findCharacterByName(projectId, name)?.id)
        .filter((id): id is string => !!id)
      this.store.createConflict({
        id: randomUUID(),
        projectId,
        description: ensureString(item.description, ''),
        type: ensureString(item.type, 'interest') as NovelConflict['type'],
        intensity: Math.max(1, Math.min(10, ensureNumber(item.intensity, 5))),
        stage: ensureString(item.stage, 'emerging') as NovelConflict['stage'],
        participants: JSON.stringify(participantIds),
        chapterSpans: [],
        tier: 'secondary',
        plotFunction: item.plotFunction as NovelConflict['plotFunction'],
        progressionMode: item.progressionMode as NovelConflict['progressionMode'],
      })
      stats.conflictCreatesApplied++
    }

    // ── 势力更新 ──
    for (const item of payload.factionUpdates ?? []) {
      const faction = this.findFactionByName(projectId, item.name)
      if (!faction) {
        this.context.logger.warn(
          { name: item.name, projectId },
          '记忆 Agent：未找到要更新的势力，跳过',
        )
        continue
      }
      const patch: Partial<NovelFaction> = {}
      if (item.status !== undefined) patch.status = ensureString(item.status, faction.status) as NovelFaction['status']
      if (item.strength !== undefined) patch.strength = ensureString(item.strength, faction.strength) as NovelFaction['strength']
      if (Object.keys(patch).length === 0) continue
      this.store.updateFaction(faction.id, patch)
      stats.factionUpdatesApplied++
    }

    // ── 地点更新 ──
    for (const item of payload.locationUpdates ?? []) {
      const location = this.findLocationByName(projectId, item.name)
      if (!location) {
        this.context.logger.warn(
          { name: item.name, projectId },
          '记忆 Agent：未找到要更新的地点，跳过',
        )
        continue
      }
      const patch: Partial<NovelLocation> = {}
      if (item.status !== undefined) patch.status = ensureString(item.status, location.status) as NovelLocation['status']
      if (Object.keys(patch).length === 0) continue
      this.store.updateLocation(location.id, patch)
      stats.locationUpdatesApplied++
    }

    // ── 关系更新（四层逻辑②：让 Memory Agent 感知关系演变）──
    // LLM 通过 characterA / characterB 名字匹配关系，匹配两端的角色 ID 找到关系记录
    const validAlignments = ['ally', 'temporary_ally', 'opponent', 'temporary_opponent', 'neutral', 'pending_shift']
    const validTrends = ['stable', 'warming', 'cooling', 'breaking', 'reconciling']
    for (const item of payload.relationshipUpdates ?? []) {
      const charA = this.findCharacterByName(projectId, item.characterA)
      const charB = this.findCharacterByName(projectId, item.characterB)
      if (!charA || !charB) {
        this.context.logger.warn(
          { a: item.characterA, b: item.characterB, projectId },
          '记忆 Agent：未找到关系两端角色，跳过关系更新',
        )
        continue
      }
      // 关系是无向对：尝试两种方向匹配
      const rel = this.store.listRelationships(projectId).find(
        (r) =>
          (r.characterA === charA.id && r.characterB === charB.id)
          || (r.characterA === charB.id && r.characterB === charA.id),
      )
      if (!rel) {
        this.context.logger.warn(
          { a: charA.name, b: charB.name, projectId },
          '记忆 Agent：未找到匹配的关系记录，跳过（如需新建请用 relationshipCreates）',
        )
        continue
      }
      const patch: Partial<NovelRelationship> = {}
      if (item.currentStage !== undefined) patch.currentStage = ensureString(item.currentStage, rel.currentStage)
      if (item.dynamicRole !== undefined) patch.dynamicRole = ensureString(item.dynamicRole, rel.dynamicRole)
      if (item.alignment !== undefined) {
        const a = ensureString(item.alignment, rel.alignment)
        patch.alignment = (validAlignments.includes(a) ? a : 'neutral') as NovelRelationship['alignment']
      }
      if (item.trend !== undefined) {
        const t = ensureString(item.trend, rel.trend)
        patch.trend = (validTrends.includes(t) ? t : 'stable') as NovelRelationship['trend']
      }
      if (item.chapterHint !== undefined) patch.chapterHint = ensureString(item.chapterHint, rel.chapterHint)
      // 章节号 + 阶段变化 → 追加 stageHistory 条目
      if (chapterNumber !== undefined && item.currentStage !== undefined && item.currentStage !== rel.currentStage) {
        const history: RelationChange[] = (() => {
          try {
            const parsed = JSON.parse(rel.stageHistory)
            return Array.isArray(parsed) ? parsed : []
          } catch {
            return []
          }
        })()
        history.push({
          chapter: chapterNumber,
          fromStage: rel.currentStage,
          toStage: item.currentStage,
          reason: ensureString(item.changeReason, ''),
          timestamp: Date.now(),
        })
        patch.stageHistory = JSON.stringify(history)
        patch.lastUpdatedChapter = chapterNumber
      }
      if (Object.keys(patch).length === 0) continue
      this.store.updateRelationship(rel.id, patch)
      stats.relationshipUpdatesApplied++
    }

    // ── 关系创建 ──
    for (const item of payload.relationshipCreates ?? []) {
      const charA = this.findCharacterByName(projectId, item.characterA)
      const charB = this.findCharacterByName(projectId, item.characterB)
      if (!charA || !charB) {
        this.context.logger.warn(
          { a: item.characterA, b: item.characterB, projectId },
          '记忆 Agent：未找到关系两端角色，跳过关系创建',
        )
        continue
      }
      // 防重复：若已有同对关系则跳过
      const existing = this.store.listRelationships(projectId).find(
        (r) =>
          (r.characterA === charA.id && r.characterB === charB.id)
          || (r.characterA === charB.id && r.characterB === charA.id),
      )
      if (existing) {
        this.context.logger.warn(
          { a: charA.name, b: charB.name, projectId },
          '记忆 Agent：关系已存在，跳过创建（如需更新请用 relationshipUpdates）',
        )
        continue
      }
      this.store.createRelationship({
        id: randomUUID(),
        projectId,
        characterA: charA.id,
        characterB: charB.id,
        relationType: ensureString(item.relationType, '其他'),
        currentStage: ensureString(item.currentStage, ''),
        stageHistory: '[]',
        dynamicRole: ensureString(item.dynamicRole, ''),
        alignment: (validAlignments.includes(ensureString(item.alignment, 'neutral'))
          ? ensureString(item.alignment, 'neutral') : 'neutral') as NovelRelationship['alignment'],
        trend: (validTrends.includes(ensureString(item.trend, 'stable'))
          ? ensureString(item.trend, 'stable') : 'stable') as NovelRelationship['trend'],
        chapterHint: ensureString(item.chapterHint, ''),
        lastUpdatedChapter: chapterNumber ?? null,
      })
      stats.relationshipCreatesApplied++
    }

    stats.total =
      stats.characterUpdatesApplied + stats.characterCreatesApplied
      + stats.foreshadowUpdatesApplied + stats.foreshadowCreatesApplied
      + stats.conflictUpdatesApplied + stats.conflictCreatesApplied
      + stats.factionUpdatesApplied + stats.locationUpdatesApplied
      + stats.relationshipUpdatesApplied + stats.relationshipCreatesApplied

    return stats
  }

  // ═══════════════════════════════════════════════════════════════
  // 实体查找辅助方法（LLM 通过名字/description 片段引用实体）
  // ═══════════════════════════════════════════════════════════════

  private findCharacterByName(projectId: string, name?: string): NovelCharacter | undefined {
    if (!name) return undefined
    const characters = this.store.listCharacters(projectId)
    // 精确匹配优先
    let found = characters.find((c) => c.name === name)
    if (found) return found
    // 包含匹配（LLM 可能传入部分名字）
    found = characters.find((c) => c.name.includes(name) || name.includes(c.name))
    return found
  }

  private findForeshadowByDescription(projectId: string, description?: string): NovelForeshadow | undefined {
    if (!description) return undefined
    const foreshadows = this.store.listForeshadowing(projectId)
    // 精确匹配
    let found = foreshadows.find((f) => f.description === description)
    if (found) return found
    // 包含匹配（LLM 可能传入描述片段）
    found = foreshadows.find(
      (f) => f.description.includes(description) || description.includes(f.description.slice(0, 20)),
    )
    return found
  }

  private findConflictByDescription(projectId: string, description?: string): NovelConflict | undefined {
    if (!description) return undefined
    const conflicts = this.store.listConflicts(projectId)
    let found = conflicts.find((c) => c.description === description)
    if (found) return found
    found = conflicts.find(
      (c) => c.description.includes(description) || description.includes(c.description.slice(0, 20)),
    )
    return found
  }

  private findFactionByName(projectId: string, name?: string): NovelFaction | undefined {
    if (!name) return undefined
    const factions = this.store.listFactions(projectId)
    let found = factions.find((f) => f.name === name)
    if (found) return found
    found = factions.find((f) => f.name.includes(name) || name.includes(f.name))
    return found
  }

  private findLocationByName(projectId: string, name?: string): NovelLocation | undefined {
    if (!name) return undefined
    const locations = this.store.listLocations(projectId)
    let found = locations.find((l) => l.name === name)
    if (found) return found
    found = locations.find((l) => l.name.includes(name) || name.includes(l.name))
    return found
  }

  private emptyStats(): MemoryApplyStats {
    return {
      characterUpdatesApplied: 0,
      characterCreatesApplied: 0,
      foreshadowUpdatesApplied: 0,
      foreshadowCreatesApplied: 0,
      conflictUpdatesApplied: 0,
      conflictCreatesApplied: 0,
      factionUpdatesApplied: 0,
      locationUpdatesApplied: 0,
      relationshipUpdatesApplied: 0,
      relationshipCreatesApplied: 0,
      total: 0,
    }
  }
}
