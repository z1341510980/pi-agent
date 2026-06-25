/**
 * NovelCharacterGenerator：AI 角色生成器
 *
 * 基于用户输入的核心风格描述 + 项目上下文（类型、世界规则、风格指南），
 * 调用 LLM 生成完整的角色设定（身份/性格/外貌/动态状态/秘密/角色弧光/说话风格）。
 *
 * 当前实现为占位：返回基于 coreStyle 的模板角色。
 * Pi SDK 集成后通过 Session 调用 LLM 完成实际生成（参考 NovelOrchestrator.runAgent）。
 *
 * 与 NovelOrchestrator 同目录，作为插件级服务由 NovelServices 注入。
 */

import type { NovelPromptBuilder } from '../../../core/novel/prompt-builder.js'
import type { PromptManager } from '../../../core/novel/prompt-manager.js'
import type { NovelCharacter } from '../../../core/novel/types.js'

export type GeneratedCharacter = Pick<
  NovelCharacter,
  | 'name' | 'description' | 'identity' | 'personality' | 'appearance'
  | 'currentState' | 'currentGoal' | 'currentPressure' | 'secret'
  | 'arcStage' | 'speechStyle'
>

export class NovelCharacterGenerator {
  constructor(
    private promptBuilder: NovelPromptBuilder,
    private promptManager: PromptManager,
  ) {}

  /**
   * 生成角色设定
   *
   * @param projectId 项目 ID（用于读取项目上下文：类型、世界规则、风格指南）
   * @param coreStyle 用户输入的核心风格描述（如"沉默寡言的剑客，背负血海深仇"）
   * @returns 角色设定（不含 id / projectId / arcHistory / 时间戳，由调用方补全）
   */
  async generate(projectId: string, coreStyle: string): Promise<GeneratedCharacter> {
    // ── 1. 构建系统提示词（包含项目级世界规则、风格指南、角色定义等上下文）──
    // agentType 使用 'character-generator'，promptBuilder 会回退到通用角色描述
    const systemPrompt = this.promptBuilder.buildSystemPrompt(projectId, 'character-generator')

    // ── 2. 构建用户消息（核心风格描述 + 生成指令）──
    const userPrompt = this.buildUserPrompt(coreStyle)

    // TODO: 集成 Pi SDK Session 调用 LLM
    // 实际实现需要：
    //   1. 通过 createPiSession 创建 Session（注入 systemPrompt 作为 system prompt）
    //   2. 发送 userPrompt 作为首条用户消息
    //   3. 解析 LLM 返回的 JSON/结构化文本为 GeneratedCharacter
    // 当前返回基于 coreStyle 的模板角色，实际 LLM 调用在 Pi SDK 集成后完成
    console.log(
      `[Novel] Generating character for project ${projectId}, ` +
      `coreStyle: ${coreStyle.slice(0, 80)}${coreStyle.length > 80 ? '...' : ''}`,
    )
    console.log(`[Novel] System prompt length: ${systemPrompt.length}, user prompt length: ${userPrompt.length}`)

    return this.buildTemplateCharacter(coreStyle)
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
      '- currentGoal: 当前短期目标',
      '- currentPressure: 当前面临的压力',
      '- secret: 隐藏的秘密',
      '- arcStage: 角色弧光当前阶段（如 setup/rising/climax/falling/resolution）',
      '- speechStyle: 说话风格特征',
    ].join('\n')
  }

  /**
   * 基于核心风格描述生成模板角色（占位实现）
   *
   * 实际实现应通过 Pi SDK 调用 LLM，根据 coreStyle + 项目上下文
   * 生成符合类型惯例与世界观的角色设定。
   * 当前实现基于 coreStyle 关键词推断角色特征，仅用于开发期占位。
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

  /** 基于核心风格关键词推断说话风格 */
  private inferSpeechStyle(coreStyle: string): string {
    if (/沉默|寡言/.test(coreStyle)) return '惜字如金，多用短句'
    if (/豪爽|豪|直/.test(coreStyle)) return '直来直往，嗓门大'
    if (/文雅|雅|书生|书/.test(coreStyle)) return '引经据典，措辞文雅'
    if (/冷|酷/.test(coreStyle)) return '冷淡简短，不带情感'
    return '说话风格待定'
  }
}
