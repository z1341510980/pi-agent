/**
 * NovelSimilarityScanner：LLM 驱动的相似实体扫描 + 字段级合并建议
 *
 * 与现有 deduplicateEntities（基于完全匹配 name/description 的快速去重）互补：
 * - deduplicateEntities：处理"完全相同"的重复（如同一角色名被录入两次）
 * - similarityScanner：处理"语义相似但表述不同"的重复（如"叶明远"和"叶明"
 *   实为同一人、不同章节录入时写法不同）
 *
 * 技术方案（与 novel-memory-generator 一致）：
 * 1. 单次 LLM 调用，输入全部 8 类实体清单（id + name/description + 关键字段）
 * 2. LLM 输出结构化 JSON：相似组 + 字段级合并建议
 * 3. scan 方法只返回报告，不落库；落库由 novel-store.mergeWithPlan 完成
 *
 * 与 novel-routes 的协作：
 * - 路由层调用 scanner.scan 推送进度 → 推送检查点 → 等待用户决策
 * - 用户 approve/revise 后调用 store.mergeWithPlan 执行字段级合并 + 关联迁移
 * - 用户 reject 时跳过合并
 *
 * 注意：scanner 只产出报告，不做任何写操作，可重复调用幂等。
 */

import type { PluginContext } from '../../../../core/plugin/plugin-types.js'
import type { NovelPromptBuilder } from '../prompting/prompt-builder.js'
import type { PromptManager } from '../prompting/prompt-manager.js'
import type { NovelStore } from '../novel-store.js'
import type {
  SimilarityGroup,
  SimilarityScanReport,
  SimilarityScanProgressEvent,
} from '../types.js'

/** 节流间隔：流式进度回调最多每 500ms 触发一次，避免 SSE 事件过载 */
const PROGRESS_THROTTLE_MS = 500

/** LLM 输出的报告（宽松解析，groups / summary 字段全可选） */
interface SimilarityScanPayload {
  groups?: SimilarityGroup[]
  summary?: string
}

export class NovelSimilarityScanner {
  constructor(
    private promptBuilder: NovelPromptBuilder,
    private promptManager: PromptManager,
    private context: PluginContext,
    private store: NovelStore,
  ) {}

  /**
   * 扫描全部 8 类实体，找出语义相似的重复项。
   *
   * 不落库，只返回 LLM 给出的合并方案。落库由调用方决定（通常在用户检查点确认后
   * 调用 store.mergeWithPlan）。
   *
   * @param projectId 项目 ID
   * @param onProgress 进度回调（用于 SSE 推送，500ms 节流）
   * @returns 相似度扫描报告
   */
  async scan(
    projectId: string,
    onProgress?: (event: SimilarityScanProgressEvent) => void,
  ): Promise<SimilarityScanReport> {
    // ── 1. 构建系统提示词（agentType='similarity-scanner' 对应 role-similarity-scanner 模板）──
    onProgress?.({ phase: 'preparing', message: '正在构建相似度扫描提示词...' })
    const systemPrompt = this.promptBuilder.buildSystemPrompt(projectId, 'similarity-scanner')

    // ── 2. 构建用户消息：注入全部 8 类实体清单 ──
    const userMessage = this.promptBuilder.buildAgentIdentity(projectId, 'similarity-scanner')
      + '\n\n---\n\n' + this.buildUserPrompt(projectId)

    // ── 3. 创建独立 Session 调用 LLM（单次调用，输出 JSON）──
    onProgress?.({ phase: 'generating', message: '相似度扫描 Agent 正在分析实体清单...' })
    const session = await this.context.createSession({
      systemPrompt,
      userMessage,
      responseFormat: 'json',
      // 实体清单可能较大，LLM 需要逐对比对，耗时较长
      timeoutMs: 300_000,
    })

    let payload: SimilarityScanPayload
    try {
      let streamedText = ''
      // 节流：避免每个 token 都触发 onProgress，导致 SSE 事件过载
      let lastProgressAt = 0
      const result = await session.promptStream((delta) => {
        streamedText += delta
        const now = Date.now()
        if (now - lastProgressAt >= PROGRESS_THROTTLE_MS) {
          lastProgressAt = now
          const partial = streamedText.slice(-200)
          onProgress?.({
            phase: 'generating',
            message: '相似度扫描 Agent 正在分析实体清单...',
            data: { partial },
          })
        }
      })

      this.context.logger.info(
        { projectId, resultLength: result.length },
        '相似度扫描 LLM 调用完成',
      )

      // ── 4. 解析 JSON ──
      onProgress?.({ phase: 'parsing', message: '正在解析相似度报告...' })
      payload = this.parseResult(result)
    } catch (err) {
      this.context.logger.error(
        { projectId, err },
        '相似度扫描 LLM 调用失败，回退到空报告',
      )
      onProgress?.({ phase: 'fallback', message: '相似度扫描失败，返回空报告' })
      return { groups: [], totalCandidates: 0 }
    } finally {
      session.dispose()
    }

    // ── 5. 整理报告（过滤无效组 + 计算 totalCandidates）──
    const groups = this.sanitizeGroups(payload.groups ?? [])
    const totalCandidates = groups.reduce((s, g) => s + g.removed.length, 0)
    onProgress?.({
      phase: 'completed',
      message: `相似度扫描完成：发现 ${groups.length} 组相似实体（共 ${totalCandidates} 个待合并）`,
      data: { groups, totalCandidates },
    })

    return { groups, totalCandidates }
  }

  // ═══════════════════════════════════════════════════════════════
  // 提示词构建：列出全部 8 类实体（id + name/description + 关键字段）
  // ═══════════════════════════════════════════════════════════════

  private buildUserPrompt(projectId: string): string {
    const parts: string[] = []
    parts.push('## 待扫描实体清单')
    parts.push('')
    parts.push('请扫描以下全部 8 类实体，找出语义相似（但名字/描述不完全相同）的重复项。')
    parts.push('每个实体都标注了 id（用于填充 keptId / removed.id / fieldMerges.fromId）。')
    parts.push('')

    // ── 角色 ──
    const characters = this.store.listCharacters(projectId)
    if (characters.length > 0) {
      parts.push('### 角色（character）')
      for (const c of characters) {
        const fields = [
          `name: ${c.name}`,
          `identity: ${c.identity || '(空)'}`,
          `description: ${c.description || '(空)'}`,
          `personality: ${c.personality || '(空)'}`,
          `appearance: ${c.appearance || '(空)'}`,
          `currentState: ${c.currentState || '(空)'}`,
          `currentGoal: ${c.currentGoal || '(空)'}`,
          `longTermDesire: ${c.longTermDesire || '(空)'}`,
          `plotRole: ${c.plotRole}`,
        ]
        parts.push(`- ID: ${c.id} | ${fields.join(' | ')}`)
      }
      parts.push('')
    }

    // ── 冲突 ──
    const conflicts = this.store.listConflicts(projectId)
    if (conflicts.length > 0) {
      parts.push('### 冲突（conflict）')
      for (const c of conflicts) {
        const fields = [
          `description: ${c.description}`,
          `type: ${c.type}`,
          `stage: ${c.stage}`,
          `intensity: ${c.intensity}`,
          `tier: ${c.tier}`,
          `plotFunction: ${c.plotFunction ?? '(未指定)'}`,
          `progressionMode: ${c.progressionMode ?? 'linear'}`,
        ]
        parts.push(`- ID: ${c.id} | ${fields.join(' | ')}`)
      }
      parts.push('')
    }

    // ── 伏笔 ──
    const foreshadows = this.store.listForeshadowing(projectId)
    if (foreshadows.length > 0) {
      parts.push('### 伏笔（foreshadow）')
      for (const f of foreshadows) {
        const fields = [
          `description: ${f.description}`,
          `category: ${f.category}`,
          `status: ${f.status}`,
          `plantMethod: ${f.plantMethod ?? '(未指定)'}`,
          `recoverMethod: ${f.recoverMethod ?? '(未指定)'}`,
        ]
        parts.push(`- ID: ${f.id} | ${fields.join(' | ')}`)
      }
      parts.push('')
    }

    // ── 势力 ──
    const factions = this.store.listFactions(projectId)
    if (factions.length > 0) {
      parts.push('### 势力（faction）')
      for (const f of factions) {
        const fields = [
          `name: ${f.name}`,
          `description: ${f.description || '(空)'}`,
          `type: ${f.type}`,
          `ideology: ${f.ideology || '(空)'}`,
          `strength: ${f.strength}`,
          `status: ${f.status}`,
        ]
        parts.push(`- ID: ${f.id} | ${fields.join(' | ')}`)
      }
      parts.push('')
    }

    // ── 地点 ──
    const locations = this.store.listLocations(projectId)
    if (locations.length > 0) {
      parts.push('### 地点（location）')
      for (const l of locations) {
        const fields = [
          `name: ${l.name}`,
          `description: ${l.description || '(空)'}`,
          `type: ${l.type}`,
          `significance: ${l.significance}`,
          `status: ${l.status}`,
        ]
        parts.push(`- ID: ${l.id} | ${fields.join(' | ')}`)
      }
      parts.push('')
    }

    // ── 世界要素 ──
    const worldElements = this.store.listWorldElements(projectId)
    if (worldElements.length > 0) {
      parts.push('### 世界要素（world_element）')
      for (const w of worldElements) {
        const fields = [
          `category: ${w.category}`,
          `name: ${w.name}`,
          `description: ${w.description || '(空)'}`,
        ]
        parts.push(`- ID: ${w.id} | ${fields.join(' | ')}`)
      }
      parts.push('')
    }

    // ── 钩子（v0.2 新增）──
    const hooks = this.store.listHooks(projectId)
    if (hooks.length > 0) {
      parts.push('### 钩子（hook）')
      for (const h of hooks) {
        const fields = [
          `chapterNumber: ${h.chapterNumber}`,
          `hookType: ${h.hookType}`,
          `description: ${h.description}`,
          `status: ${h.status}`,
        ]
        parts.push(`- ID: ${h.id} | ${fields.join(' | ')}`)
      }
      parts.push('')
    }

    // ── 角色弧光（v0.2 新增）──
    const arcs = this.store.listCharacterArcs(projectId)
    if (arcs.length > 0) {
      parts.push('### 角色弧光（character_arc）')
      for (const a of arcs) {
        const fields = [
          `arcType: ${a.arcType}`,
          `currentStage: ${a.currentStage}`,
          `description: ${a.description || '(空)'}`,
        ]
        parts.push(`- ID: ${a.id} | characterId: ${a.characterId} | ${fields.join(' | ')}`)
      }
      parts.push('')
    }

    // 实体总数提示
    const totalEntities =
      characters.length + conflicts.length + foreshadows.length
      + factions.length + locations.length + worldElements.length
      + hooks.length + arcs.length
    parts.push(`## 实体总数：${totalEntities}`)
    if (totalEntities === 0) {
      parts.push('（实体清单为空，直接返回空报告即可）')
    }
    parts.push('')
    parts.push('## 输出要求')
    parts.push('请按角色定义中规定的 JSON 格式输出相似度扫描报告。')
    parts.push('只报告 similarity > 0.6 的组；没有相似实体时返回 {"groups": [], "summary": "未发现相似实体"}。')

    return parts.join('\n')
  }

  // ═══════════════════════════════════════════════════════════════
  // JSON 解析（与 memory-generator 一致的鲁棒解析）
  // ═══════════════════════════════════════════════════════════════

  private parseResult(text: string): SimilarityScanPayload {
    // 提取 JSON：先尝试完整代码块，再处理截断的未闭合代码块
    let jsonStr: string
    const closedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (closedMatch) {
      jsonStr = closedMatch[1].trim()
    } else {
      const unclosedMatch = text.match(/```(?:json)?\s*([\s\S]*)/)
      jsonStr = unclosedMatch ? unclosedMatch[1].trim() : text.trim()
    }

    let parsed: SimilarityScanPayload | null = null

    // 第一步：直接解析
    try {
      parsed = JSON.parse(jsonStr) as SimilarityScanPayload
    } catch {
      // 继续
    }

    // 第二步：从文本中提取 { 到最后一个 } 的片段再试
    if (!parsed) {
      const firstBrace = jsonStr.indexOf('{')
      const lastBrace = jsonStr.lastIndexOf('}')
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        const extracted = jsonStr.slice(firstBrace, lastBrace + 1)
        try {
          parsed = JSON.parse(extracted) as SimilarityScanPayload
        } catch {
          // 继续
        }
      }
    }

    // 第三步：移除注释 + 尾逗号后重试
    if (!parsed) {
      const cleaned = jsonStr
        .replace(/\/\/.*$/gm, '') // 行注释
        .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
        .replace(/,(\s*[}\]])/g, '$1') // 尾逗号
      try {
        parsed = JSON.parse(cleaned) as SimilarityScanPayload
      } catch {
        // 继续
      }
    }

    // 第四步：截尾补全（流式输出可能截断在某个字段中间）
    if (!parsed) {
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
          parsed = JSON.parse(repaired) as SimilarityScanPayload
          break
        } catch {
          // 继续
        }
      }
    }

    if (!parsed || typeof parsed !== 'object') {
      this.context.logger.warn(
        { textPreview: text.slice(0, 200) },
        '相似度扫描 JSON 解析失败，使用空报告',
      )
      return { groups: [] }
    }

    return parsed
  }

  // ═══════════════════════════════════════════════════════════════
  // 报告清理：过滤掉无效组（keptId 缺失 / removed 为空 / similarity 过低）
  // ═══════════════════════════════════════════════════════════════

  private sanitizeGroups(groups: SimilarityGroup[]): SimilarityGroup[] {
    const valid: SimilarityGroup[] = []
    // 已被任何组使用过的实体 ID（不能重复出现在多个组中）
    const usedIds = new Set<string>()

    for (const g of groups) {
      // 基础校验
      if (!g || typeof g !== 'object') continue
      if (!g.kind || !g.keptId || !Array.isArray(g.removed) || g.removed.length === 0) {
        continue
      }
      // similarity 阈值：低于 0.6 的不报告
      if (typeof g.similarity !== 'number' || g.similarity < 0.6) {
        continue
      }
      // keptId 不能与 removed 中的任何 ID 重复
      const removedIds = g.removed.map((r) => r.id)
      if (removedIds.includes(g.keptId)) continue

      // 检查 ID 唯一性：keptId 和 removed.id 都不能在其他组中出现过
      if (usedIds.has(g.keptId)) continue
      if (removedIds.some((id) => usedIds.has(id))) continue

      // 标记已使用
      usedIds.add(g.keptId)
      for (const id of removedIds) usedIds.add(id)

      // 清理 fieldMerges（fromId 必须来自 removed 列表）
      const sanitizedFieldMerges = (g.fieldMerges ?? []).filter(
        (fm) => fm && typeof fm.field === 'string'
          && typeof fm.fromId === 'string'
          && removedIds.includes(fm.fromId),
      )
      valid.push({
        kind: g.kind,
        reason: g.reason ?? '',
        similarity: g.similarity,
        keptId: g.keptId,
        removed: g.removed.map((r) => ({ id: r.id, name: r.name ?? '' })),
        fieldMerges: sanitizedFieldMerges.length > 0 ? sanitizedFieldMerges : undefined,
      })
    }

    return valid
  }
}
