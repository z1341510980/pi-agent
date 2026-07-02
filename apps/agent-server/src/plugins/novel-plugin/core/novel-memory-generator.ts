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
  NarrativeTask,
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
}

interface ForeshadowUpdateItem {
  description?: string
  status?: string
}

interface ForeshadowCreateItem {
  description?: string
  category?: string
  linkedCharacters?: string[]
}

interface ConflictUpdateItem {
  description?: string
  stage?: string
  intensity?: number
}

interface ConflictCreateItem {
  description?: string
  type?: string
  intensity?: number
  stage?: string
  participants?: string[]
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
    const userPrompt = this.buildUserPrompt(projectId, chapterNumber, chapterContent)

    // ── 3. 构建章节上下文（SEMI 层前缀，与 runAgent 一致的三层缓存设计）──
    // 注入 prefixUserMessage 让 Memory Agent 也能命中跨章 STATIC 缓存 + 单章 SEMI 缓存。
    // 不传入 arrangedEntities：Memory 在 director→writer→reviewer 之后执行，
    // 编排约束已通过正文体现，无需重复注入。agentType 不传 'writer' 以跳过 chapter-instruction。
    const chapter = this.store.getChapter(projectId, chapterNumber)
    const narrativeTask: NarrativeTask = {
      description: chapter?.narrativeTask ?? `第 ${chapterNumber} 章创作`,
      type: 'advance_mainline',
      targetEntity: null,
      priority: 'medium',
    }
    const constraints = this.engine.buildChapterConstraints(projectId)
    const chapterContext = this.promptBuilder.buildChapterContext(
      projectId,
      chapterNumber,
      narrativeTask,
      constraints,
      undefined,
      'memory-generator',
    )

    // ── 4. 创建独立 Session 调用 LLM（单次调用，输出 JSON）──
    onProgress?.({ phase: 'generating', message: '记忆 Agent 正在分析章节状态变更...' })
    const session = await this.context.createSession({
      systemPrompt,
      prefixUserMessage: chapterContext,
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
    const stats = this.applyChanges(projectId, payload)

    const summary = payload.summary?.trim() || `已应用 ${stats.total} 项状态变更`
    onProgress?.({
      phase: 'completed',
      message: `记忆提取完成：${summary}（应用 ${stats.total} 项变更）`,
      data: { stats },
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
        ]
        parts.push(`- ${c.name}（ID: ${c.id}）: ${fields.join(' | ')}`)
      }
    }

    // 冲突
    const conflicts = this.store.listConflicts(projectId)
    if (conflicts.length > 0) {
      parts.push('\n### 冲突')
      for (const c of conflicts) {
        parts.push(`- ${c.description.slice(0, 60)}（ID: ${c.id}）: stage=${c.stage} | intensity=${c.intensity}`)
      }
    }

    // 伏笔
    const foreshadows = this.store.listForeshadowing(projectId)
    if (foreshadows.length > 0) {
      parts.push('\n### 伏笔')
      for (const f of foreshadows) {
        parts.push(`- ${f.description.slice(0, 60)}（ID: ${f.id}）: status=${f.status}`)
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

  private applyChanges(projectId: string, payload: MemoryUpdatePayload): MemoryApplyStats {
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
      if (Object.keys(patch).length === 0) continue
      this.store.updateCharacter(character.id, patch)
      stats.characterUpdatesApplied++
    }

    // ── 角色创建 ──
    for (const item of payload.characterCreates ?? []) {
      if (!item.name) continue
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
        category: ensureString(item.category, 'event'),
        status: 'planted',
        firstChapter: null,
        lastChapter: null,
        recoverByChapter: null,
        linkedCharacters: JSON.stringify(linkedCharacterIds),
        linkedClues: '[]',
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
        firstChapter: null,
        lastChapter: null,
        tier: 'secondary',
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

    stats.total =
      stats.characterUpdatesApplied + stats.characterCreatesApplied
      + stats.foreshadowUpdatesApplied + stats.foreshadowCreatesApplied
      + stats.conflictUpdatesApplied + stats.conflictCreatesApplied
      + stats.factionUpdatesApplied + stats.locationUpdatesApplied

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
      total: 0,
    }
  }
}
