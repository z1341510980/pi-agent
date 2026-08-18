/**
 * NovelCharacterGenerator：AI 角色生成器
 *
 * 基于用户输入的核心风格描述 + 项目上下文（类型、世界规则、风格指南），
 * 调用 LLM 生成完整的角色设定（身份/性格/外貌/动态状态/秘密/角色弧光/说话风格）。
 *
 * 通过 PluginContext.createSession 创建独立 Pi Session 调用 LLM（参考 NovelOrchestrator.runAgent）。
 * 与主聊天 Session 隔离：使用独立的 threadId，不污染用户对话历史。
 *
 * 与 NovelOrchestrator 同目录，作为插件级服务由 NovelServices 注入。
 */

import type { PluginContext } from '../../../../core/plugin/plugin-types.js'
import type { NovelPromptBuilder } from '../prompting/prompt-builder.js'
import type { PromptManager } from '../prompting/prompt-manager.js'
import type { NovelCharacter } from '../types.js'
import type { CharacterGenerationProgressEvent } from '@repo/shared/novel'
import { CircuitBreaker } from '../../../../core/agent/circuit-breaker.js'

// CharacterGenerationProgressEvent 已迁入 @repo/shared/novel 共享包，
// 此处 re-export 供本插件内部模块沿用相对路径引入。
export type { CharacterGenerationProgressEvent } from '@repo/shared/novel'

/** 将任意 LLM 输出值安全转为 string，防止数组/对象传到 SQLite */
function ensureString(value: unknown, defaultValue: string): string {
  if (typeof value === 'string') return value
  if (value == null) return defaultValue
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export type GeneratedCharacter = Pick<
  NovelCharacter,
  | 'name' | 'description' | 'identity' | 'personality' | 'appearance'
  | 'currentState' | 'currentGoal' | 'currentPressure' | 'secret'
  | 'arcStage' | 'speechStyle'
  | 'longTermDesire' | 'plotRole' | 'removalImpact'
>

export class NovelCharacterGenerator {
  /** LLM 调用熔断器（实例级，所有 generate 调用共享） */
  private readonly circuitBreaker: CircuitBreaker

  constructor(
    private promptBuilder: NovelPromptBuilder,
    private promptManager: PromptManager,
    private context: PluginContext,
    circuitBreaker?: CircuitBreaker,
  ) {
    // 未注入则使用默认配置（从 runtimePerformance 读取阈值）
    this.circuitBreaker = circuitBreaker ?? new CircuitBreaker()
  }

  /**
   * 生成角色设定
   *
   * @param projectId 项目 ID（用于读取项目上下文：类型、世界规则、风格指南）
   * @param coreStyle 用户输入的核心风格描述（如"沉默寡言的剑客，背负血海深仇"）
   * @param onProgress 进度回调（用于 SSE 流式推送生成阶段到前端）
   * @param signal 取消信号
   * @param modelId 本次生成指定的 Provider/模型；未传时使用默认模型
   * @returns 角色设定（不含 id / projectId / arcHistory / 时间戳，由调用方补全）
   */
  async generate(
    projectId: string,
    coreStyle: string,
    onProgress?: (event: CharacterGenerationProgressEvent) => void,
    signal?: AbortSignal,
    modelId?: { provider: string; modelId: string },
  ): Promise<GeneratedCharacter> {
    // ── 1. 构建系统提示词（包含项目级世界规则、风格指南、角色定义等上下文）──
    // agentType 使用 'character-generator'，promptBuilder 会回退到通用角色描述
    onProgress?.({ phase: 'preparing', message: '正在构建角色生成提示词...' })
    const systemPrompt = this.promptBuilder.buildSystemPrompt(projectId, 'character-generator')

    // ── 2. 构建用户消息（核心风格描述 + 生成指令）──
    // 身份段注入 userMessage 开头（systemPrompt 不含身份段，以跨 Agent 共享 system 缓存）
    const userPrompt = this.promptBuilder.buildAgentIdentity(projectId, 'character-generator')
      + '\n\n---\n\n' + this.buildUserPrompt(coreStyle)

    // ── 3. 创建独立 Session 调用 LLM ──
    onProgress?.({ phase: 'generating', message: 'AI 正在生成角色设定...' })
    const session = await this.context.createSession({
      systemPrompt,
      userMessage: userPrompt,
      tools: [],
      responseFormat: 'json',
      // 角色生成涉及详细设定（外貌/性格/背景/能力/关系等），LLM 耗时较长；
      // 默认 120s 不足，提到 300s 与 Memory Agent 一致
      timeoutMs: 300_000,
      signal,
      modelId,
    })

    try {
      // 用熔断器包装 LLM 调用：连续失败时熔断，避免雪崩
      const result = await this.circuitBreaker.execute(async () => {
        // 使用 promptStream 实现真正的流式推送：
        // 每收到一段 text_delta 就通过 onProgress 推送给前端，
        // 前端可在 SSE 通道上实时显示生成中的文本预览。
        let streamedText = ''
        let lastEmitTs = 0
        return await session.promptStream((delta) => {
          streamedText += delta
          // 节流：每 500ms 最多发一次进度，避免 token 级回调导致 SSE 事件洪泛
          const now = Date.now()
          if (now - lastEmitTs < 500) return
          lastEmitTs = now
          const partial = streamedText.slice(-200)
          onProgress?.({
            phase: 'generating',
            message: 'AI 正在生成角色设定...',
            data: { partial },
          })
        })
      })
      this.context.logger.info(
        {
          projectId,
          coreStylePreview: coreStyle.slice(0, 80),
          resultLength: result.length,
          circuitBreakerState: this.circuitBreaker.state,
        },
        '角色生成 LLM 调用完成',
      )
      onProgress?.({
        phase: 'parsing',
        message: '正在解析生成结果...',
        data: { resultLength: result.length },
      })
      // ── 4. 解析 LLM 返回的 JSON ──
      const character = this.parseCharacterJson(result, coreStyle)
      onProgress?.({
        phase: 'completed',
        message: '角色生成完成',
        data: { name: character.name },
      })
      return character
    } catch (err) {
      // 熔断器开路时给出明确错误信息
      if (err instanceof Error && /熔断器开路/.test(err.message)) {
        this.context.logger.warn(
          { projectId, circuitBreakerState: this.circuitBreaker.state },
          '角色生成被熔断器拒绝',
        )
        onProgress?.({
          phase: 'fallback',
          message: 'AI 服务暂时不可用（熔断器开路），请稍后重试',
        })
      }
      this.context.logger.error(
        { projectId, coreStylePreview: coreStyle.slice(0, 80), err },
        '角色生成 LLM 调用失败，回退到模板角色',
      )
      onProgress?.({ phase: 'fallback', message: 'AI 生成失败，使用模板兜底...' })
      return this.buildTemplateCharacter(coreStyle)
    } finally {
      session.dispose()
    }
  }

  /**
   * 构建用户消息（核心风格描述 + 生成指令）
   */
  private buildUserPrompt(coreStyle: string): string {
    return [
      '请根据以下核心风格描述，生成一个完整的角色设定。',
      '',
      `【核心风格描述】`,
      coreStyle,
      '',
      '【输出要求】',
      '请返回 JSON 格式，包含以下字段：',
      '- name: 角色姓名',
      '- description: 一句话概述',
      '- identity: 身份背景（出身/职业/社会地位）',
      '- personality: 性格特征（含优缺点）',
      '- appearance: 外貌描写',
      '- currentState: 当前情绪/处境状态',
      '- currentGoal: 当前短期目标（本章/近几章可达成）',
      '- currentPressure: 当前面临的压力',
      '- secret: 隐藏的秘密',
      '- arcStage: 角色弧光当前阶段（如 setup/rising/climax/falling/resolution）',
      '- speechStyle: 说话风格特征',
      '',
      '【四层逻辑补全字段（重要）】',
      '- longTermDesire: 长期欲望（跨章节稳定的发动机，区别于 currentGoal 短期目标）',
      '  · 想保住什么 / 争到什么 / 躲开什么，最好能一句话说清',
      '  · 例：复仇/夺回家族产业/守护某人/找到失散的妹妹/成为最强剑客',
      '  · 注意：不是"打倒 BOSS"这种短期目标，而是支撑他跨整本书行动的内在驱动',
      '- plotRole: 角色层级，从以下枚举中选择一个：',
      '  · protagonist: 主角（整本书的核心视角，唯一）',
      '  · main_opponent: 主要对手（长期对抗主角的核心反派）',
      '  · supporting: 重要配角（有人物深度，参与多条线）',
      '  · function: 功能配角（主要为推动特定剧情而存在，工具人风险高）',
      '  · background: 背景人物（仅作为环境/陪衬）',
      '- removalImpact: 删掉影响（一句话描述"删掉这个角色哪段剧情会受影响"）',
      '  · 例：删掉他，主角将失去信息来源，第 12 章的转折将无法触发',
      '  · 若该角色尚未承担剧情功能，填"暂无关键影响"',
      '',
      '【输出约束（必须遵守）】',
      '所有输出的文本字段（name / description / personality / appearance / currentState 等）绝不使用破折号"——"。转折用句号分割独立句，补充说明用逗号，列举用顿号，悬念收尾用省略号。',
      '',
    ].join('\n')
  }

  /**
   * 解析 LLM 返回的文本为 GeneratedCharacter
   *
   * LLM 可能返回纯 JSON，也可能用 ```json ... ``` 代码块包裹。
   * 解析失败时回退到模板角色（buildTemplateCharacter）。
   */
  private parseCharacterJson(text: string, coreStyle: string): GeneratedCharacter {
    // 提取 JSON：先尝试完整代码块，再处理截断的未闭合代码块
    let jsonStr: string
    const closedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (closedMatch) {
      jsonStr = closedMatch[1].trim()
    } else {
      const unclosedMatch = text.match(/```(?:json)?\s*([\s\S]*)/)
      jsonStr = unclosedMatch ? unclosedMatch[1].trim() : text.trim()
    }

    let parsed: Record<string, unknown> | null = null

    // 1. 直接解析
    try {
      parsed = JSON.parse(jsonStr) as Record<string, unknown>
    } catch {
      // 继续
    }

    // 2. 截尾补全：逐步回退，尝试在合理位置截断后补 }
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
          parsed = JSON.parse(repaired) as Record<string, unknown>
          this.context.logger.info(
            { textPreview: text.slice(0, 100) },
            '角色 JSON 截断补全成功',
          )
          break
        } catch {
          // 继续回退
        }
      }
    }

    if (parsed) {
      return {
        name: ensureString(parsed.name, '未命名角色'),
        description: ensureString(parsed.description, ''),
        identity: ensureString(parsed.identity, ''),
        personality: ensureString(parsed.personality, ''),
        appearance: ensureString(parsed.appearance, ''),
        currentState: ensureString(parsed.currentState, ''),
        currentGoal: ensureString(parsed.currentGoal, ''),
        currentPressure: ensureString(parsed.currentPressure, ''),
        secret: ensureString(parsed.secret, ''),
        arcStage: ensureString(parsed.arcStage, 'setup'),
        speechStyle: ensureString(parsed.speechStyle, ''),
        longTermDesire: ensureString(parsed.longTermDesire, ''),
        plotRole: this.normalizePlotRole(parsed.plotRole),
        removalImpact: ensureString(parsed.removalImpact, '暂无关键影响'),
      }
    }

    this.context.logger.warn(
      { textPreview: text.slice(0, 200) },
      '解析 LLM 返回的角色 JSON 失败（可能被截断），回退到模板角色',
    )
    return this.buildTemplateCharacter(coreStyle)
  }

  /**
   * 基于核心风格描述生成模板角色（占位实现 / 兜底回退）
   *
   * 用途：
   * 1. LLM 调用失败时的兜底回退（保证调用方拿到结构化结果）
   * 2. parseCharacterJson 解析失败时的回退
   */
  private buildTemplateCharacter(coreStyle: string): GeneratedCharacter {
    // 从 coreStyle 推断姓名（取前 2-4 个字符 + "角色"后缀作为占位名）
    const trimmed = coreStyle.trim()
    const nameSeed = trimmed.slice(0, 4).replace(/[^\u4e00-\u9fa5a-zA-Z]/g, '')
    const name = nameSeed.length >= 2 ? `${nameSeed}（待定）` : '未命名角色'

    // 推断角色弧光阶段（默认从 setup 起步）
    const arcStage = 'setup'

    // 当前状态：基于核心风格推断
    const currentState = this.inferCurrentState(trimmed)

    return {
      name,
      description: `基于核心风格"${trimmed.slice(0, 30)}${trimmed.length > 30 ? '...' : ''}"生成的占位角色，待 LLM 集成后替换为真实生成内容。`,
      identity: '身份背景待补充（占位）',
      personality: `性格特征基于核心风格推断：${this.inferPersonality(trimmed)}`,
      appearance: '外貌描写待补充（占位）',
      currentState,
      currentGoal: '当前目标待补充（占位）',
      currentPressure: '当前压力待补充（占位）',
      secret: '隐藏秘密待补充（占位）',
      arcStage,
      speechStyle: this.inferSpeechStyle(trimmed),
      longTermDesire: '长期欲望待补充（占位）',
      plotRole: 'supporting',
      removalImpact: '暂无关键影响（占位角色）',
    }
  }

  /** 基于核心风格关键词推断当前状态 */
  private inferCurrentState(coreStyle: string): string {
    if (/沉默|寡言|冷|孤独|孤|独/.test(coreStyle)) return '内心封闭，对外保持距离'
    if (/愤怒|仇恨|仇|恨|怒/.test(coreStyle)) return '情绪激动，被仇恨驱动'
    if (/迷茫|困惑|迷|惑/.test(coreStyle)) return '内心迷茫，寻找方向'
    if (/自信|从容|淡|稳/.test(coreStyle)) return '心态从容，目标明确'
    return '初始状态，待发展'
  }

  /** 基于核心风格关键词推断性格特征 */
  private inferPersonality(coreStyle: string): string {
    const traits: string[] = []
    if (/沉默|寡言/.test(coreStyle)) traits.push('内敛', '少言')
    if (/勇敢|勇|胆/.test(coreStyle)) traits.push('果敢', '有担当')
    if (/聪明|智|慧|机智/.test(coreStyle)) traits.push('机敏', '善谋')
    if (/善良|善|慈/.test(coreStyle)) traits.push('仁厚', '重情')
    if (/冷|酷/.test(coreStyle)) traits.push('冷静', '理性')
    if (traits.length === 0) traits.push('性格待定')
    return traits.join('、')
  }

  /** 基于 coreStyle 推断角色层级（默认按配角起步，仇恨/对手关键词推断 main_opponent） */
  private normalizePlotRole(value: unknown): NovelCharacter['plotRole'] {
    const valid: NovelCharacter['plotRole'][] = ['protagonist', 'main_opponent', 'supporting', 'function', 'background']
    if (typeof value === 'string' && valid.includes(value as NovelCharacter['plotRole'])) {
      return value as NovelCharacter['plotRole']
    }
    return 'supporting'
  }

  /** 基于核心风格关键词推断说话风格 */
  private inferSpeechStyle(coreStyle: string): string {
    if (/沉默|寡言/.test(coreStyle)) return '惜字如金，多用短句'
    if (/豪爽|豪|直/.test(coreStyle)) return '直来直往，嗓门大'
    if (/文雅|雅|书生|书/.test(coreStyle)) return '引经据典，措辞文雅'
    if (/冷|酷/.test(coreStyle)) return '冷淡简短，不带情感'
    return '说话风格待定'
  }
}
