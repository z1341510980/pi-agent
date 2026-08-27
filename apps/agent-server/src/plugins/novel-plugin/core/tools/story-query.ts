/**
 * 叙事查询工具：novel_ask_story / novel_query_state。
 * 从 novel-tools.ts 拆出（阶段 1 整理）；对外仍经 novel-tools.js 桶文件导出。
 */

// 导入头：从原 novel-tools.ts 拆出时带入
import { Type } from 'typebox'
import { defineTool, type ToolDefinition, type AgentToolResult } from '@earendil-works/pi-coding-agent'
import type { NovelStore } from '../novel-store.js'
import type { NovelMemoryStore } from '../novel-memory-store.js'
import type { ChapterBoundaryContext } from '../prompting/prompt-builder.js'
import type { ChapterStoryContext } from '@repo/shared/novel'

export interface ChapterBoundaryProvider {
  /**
   * 读取第 N 章开篇边界状态。
   *
   * 语义：chapterNumber > 1 且存在 N-1 快照时，返回 N-1 章结束时的实体快照；
   * 否则返回当前活库状态（顺序生成场景）。
   *
   * 工具与注入路径都应调用此方法，确保重写中间章节时读到一致的章前状态。
   */
  getChapterBoundaryContext(projectId: string, chapterNumber: number): ChapterBoundaryContext
}

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
  asOfChapter: Type.Optional(Type.Number({
    description: '章前时点（可选）：返回该章开篇前的状态快照，而非活库最新值。' +
      '重写中间章节时必传，避免读到未来章节已写入的状态倒灌。顺序生成当前章时留空。',
  })),
})

const AskStoryParams = Type.Object({
  projectId: Type.String({ description: '项目 ID' }),
  question: Type.String({ description: '自然语言问题，例如"上一章结尾是什么？""角色林深的当前目标是什么？"' }),
  chapterNumber: Type.Optional(Type.Number({ description: '当前章节号（可选，用于上下文过滤）' })),
})

export function createNovelAskStoryTool(
  store: NovelStore,
  memoryStore?: NovelMemoryStore,
  boundaryProvider?: ChapterBoundaryProvider,
): ToolDefinition<typeof AskStoryParams> {
  return defineTool({
    name: 'novel_ask_story',
    label: '小说信息问答',
    description:
      '用自然语言向小说创作系统提问，获取当前项目的故事状态、角色、冲突、伏笔、上一章内容等信息。' +
      '适用于创作过程中按需查询，不必记忆全部设定。只读工具，不修改任何状态。' +
      '当携带 chapterNumber 时，会返回该章开篇前的状态（与注入上下文一致），避免重写中间章节时读到未来章节的状态倒灌。',
    promptSnippet: '小说信息问答',
    parameters: AskStoryParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const { projectId, question, chapterNumber } = params
      const q = question.toLowerCase()

      function quotedName(s: string): string | undefined {
        const m = s.match(/[“"""「『]([^""""」』]+)[""""」』]/)
        return m?.[1].trim()
      }

      // P0 修复：优先走 boundaryProvider（与注入路径一致），回退到 memoryStore 账本重放
      let boundary: ChapterBoundaryContext | undefined
      let chapterContext: ChapterStoryContext | undefined
      if (chapterNumber !== undefined) {
        if (boundaryProvider) {
          try {
            boundary = boundaryProvider.getChapterBoundaryContext(projectId, chapterNumber)
          } catch {
            boundary = undefined
          }
        } else if (memoryStore) {
          try {
            chapterContext = memoryStore.getChapterStoryContext(projectId, chapterNumber)
          } catch {
            chapterContext = undefined
          }
        }
      }

      if (q.includes('上一章') || q.includes('最近章节') || q.includes('结尾') || q.includes('前情') || q.includes('recap')) {
        return answerRecentChapter(store, projectId, chapterNumber)
      }
      if (q.includes('角色') || q.includes('人物') || q.includes('谁') || q.includes('主角') || quotedName(question)) {
        return answerCharacter(store, projectId, quotedName(question), boundary, chapterContext)
      }
      if (q.includes('冲突') || q.includes('矛盾') || q.includes('危机') || q.includes('张力')) {
        return answerConflicts(store, projectId, boundary, chapterContext)
      }
      if (q.includes('伏笔') || q.includes('铺垫') || q.includes('回收')) {
        return answerForeshadows(store, projectId, chapterNumber, boundary, chapterContext)
      }
      if (q.includes('线索') || q.includes('真相') || q.includes('谜题')) {
        return answerClues(store, projectId, boundary, chapterContext)
      }
      if (q.includes('风格') || q.includes('文风') || q.includes('写法') || q.includes('语言')) {
        return answerStyle(store, projectId)
      }
      if (q.includes('大纲') || q.includes('结构') || q.includes('整体') || q.includes('主线')) {
        return answerOutline(store, projectId)
      }
      if (q.includes('世界') || q.includes('设定') || q.includes('规则') || q.includes('势力') || q.includes('地点')) {
        return answerWorld(store, projectId)
      }

      return answerGuide()
    },
  })
}

function answerRecentChapter(store: NovelStore, projectId: string, chapterNumber?: number): AgentToolResult<undefined> {
  // 重写中间章节时，chapterNumber 之前的章节才算"最近章节"，避免读到未来章节内容
  const allChapters = store.listRecentChapters(projectId, 3)
  const chapters = chapterNumber !== undefined
    ? allChapters.filter((c) => c.chapterNumber < chapterNumber)
    : allChapters
  if (chapters.length === 0) {
    return { content: [{ type: 'text', text: '尚未生成任何章节。' }], details: undefined }
  }
  const latest = chapters[chapters.length - 1]
  const ending = latest.content ? latest.content.slice(-500) : '（无内容）'
  const recap = latest.recap ? `\n\n前情提要：${latest.recap}` : ''
  const text = [
    `## 最近章节：第${latest.chapterNumber}章 ${latest.title}`,
    `状态：${latest.status} | 字数：${latest.wordCount || 0}`,
    ``,
    `### 结尾片段（最后 500 字）`,
    ending,
    recap,
  ].join('\n')
  return { content: [{ type: 'text', text }], details: undefined }
}

function answerCharacter(
  store: NovelStore,
  projectId: string,
  nameHint?: string,
  boundary?: ChapterBoundaryContext,
  chapterContext?: ChapterStoryContext,
): AgentToolResult<undefined> {
  // P0 修复：优先用 boundary.entities（与注入路径一致的章前快照），回退到账本覆盖逻辑
  const baseCharacters = boundary ? boundary.entities.characters : store.listCharacters(projectId)
  if (baseCharacters.length === 0) {
    return { content: [{ type: 'text', text: '项目中暂无角色。' }], details: undefined }
  }

  let view: typeof baseCharacters
  let sourceSuffix: string
  if (boundary) {
    // boundary.entities 已是章前状态，无需覆盖
    view = baseCharacters
    sourceSuffix = boundary.fromSnapshot
      ? `\n（以上为第 ${boundary.chapterNumber} 章开篇前快照，与注入上下文一致）`
      : `\n（未找到 N-1 快照，回退为当前活库状态）`
  } else {
    // 回退路径：用账本反推的角色动态字段覆盖 store 中的最新值
    const stateById = chapterContext
      ? collectChapterStateBySubject(chapterContext, 'character')
      : new Map<string, Record<string, unknown>>()
    view = baseCharacters.map((c) => {
      const state = stateById.get(c.id)
      if (!state) return c
      return {
        ...c,
        currentState: pickString(state.currentState, c.currentState),
        currentGoal: pickString(state.currentGoal, c.currentGoal),
        currentPressure: pickString(state.currentPressure, c.currentPressure),
        secret: pickString(state.secret, c.secret),
        arcStage: pickString(state.arcStage, c.arcStage),
        longTermDesire: pickString(state.longTermDesire, c.longTermDesire),
        plotRole: pickString(state.plotRole, c.plotRole) as typeof c.plotRole,
      }
    })
    sourceSuffix = chapterContext
      ? `\n（以上动态字段基于第 ${chapterContext.chapterNumber} 章前事件账本反推）`
      : ''
  }

  let target = view.find((c) => c.isProtagonist)
  if (nameHint) {
    const exact = view.find((c) => c.name === nameHint)
    const fuzzy = view.find((c) => c.name.includes(nameHint) || nameHint.includes(c.name))
    target = exact ?? fuzzy ?? target
  }

  if (target) {
    const text = [
      `## 角色：${target.name}`,
      `身份：${target.identity || '未设定'}`,
      `性格：${target.personality || '未设定'}`,
      `外貌：${target.appearance || '未设定'}`,
      `说话风格：${target.speechStyle || '未设定'}`,
      `当前状态：${target.currentState || '未设定'}`,
      `当前目标：${target.currentGoal || '未设定'}`,
      `当前压力：${target.currentPressure || '未设定'}`,
      `长期欲望：${target.longTermDesire || '未设定'}`,
      `角色层级：${target.plotRole || '未设定'}`,
      `弧光阶段：${target.arcStage || '未设定'}`,
      `秘密：${target.secret || '无'}`,
      sourceSuffix,
    ].join('\n')
    return { content: [{ type: 'text', text }], details: undefined }
  }

  const list = view
    .map((c) => `- ${c.name}${c.isProtagonist ? '（主角）' : ''}：${c.identity || c.description || '暂无简介'}`)
    .join('\n')
  return { content: [{ type: 'text', text: `## 角色列表\n${list}` }], details: undefined }
}

function answerConflicts(
  store: NovelStore,
  projectId: string,
  boundary?: ChapterBoundaryContext,
  chapterContext?: ChapterStoryContext,
): AgentToolResult<undefined> {
  // P0 修复：优先用 boundary.entities.conflicts（章前快照），回退到账本覆盖逻辑
  const baseConflicts = boundary ? boundary.entities.conflicts : store.listConflicts(projectId)

  let conflicts: typeof baseConflicts
  let suffix: string
  if (boundary) {
    conflicts = baseConflicts
    suffix = boundary.fromSnapshot
      ? `\n（以上为第 ${boundary.chapterNumber} 章开篇前快照，与注入上下文一致）`
      : `\n（未找到 N-1 快照，回退为当前活库状态）`
  } else {
    const stateById = chapterContext
      ? collectChapterStateBySubject(chapterContext, 'conflict')
      : new Map<string, Record<string, unknown>>()
    conflicts = baseConflicts.map((c) => {
      const state = stateById.get(c.id)
      if (!state) return c
      return {
        ...c,
        stage: pickString(state.stage, c.stage) as typeof c.stage,
        intensity: pickNumber(state.intensity, c.intensity),
      }
    })
    suffix = chapterContext ? `\n（以上状态基于第 ${chapterContext.chapterNumber} 章前事件账本反推）` : ''
  }

  conflicts = conflicts
    .filter((c) => c.stage !== 'resolved' && c.stage !== 'transformed')
    .sort((a, b) => b.intensity - a.intensity)
    .slice(0, 5) as typeof conflicts

  if (conflicts.length === 0) {
    return { content: [{ type: 'text', text: '当前没有活跃冲突。' }], details: undefined }
  }
  const list = conflicts
    .map((c) => `- ${c.description}（强度 ${c.intensity}/10，阶段 ${c.stage}）`)
    .join('\n')
  return { content: [{ type: 'text', text: `## 活跃冲突（Top 5）\n${list}${suffix}` }], details: undefined }
}

function answerForeshadows(
  store: NovelStore,
  projectId: string,
  chapterNumber?: number,
  boundary?: ChapterBoundaryContext,
  chapterContext?: ChapterStoryContext,
): AgentToolResult<undefined> {
  // P0 修复：优先用 boundary.entities.foreshadowing（章前快照），回退到账本覆盖逻辑
  const baseForeshadows = boundary ? boundary.entities.foreshadowing : store.listForeshadowing(projectId)

  let foreshadows: typeof baseForeshadows
  let suffix: string
  if (boundary) {
    foreshadows = baseForeshadows
    suffix = boundary.fromSnapshot
      ? `\n（以上为第 ${boundary.chapterNumber} 章开篇前快照，与注入上下文一致）`
      : `\n（未找到 N-1 快照，回退为当前活库状态）`
  } else {
    const stateById = chapterContext
      ? collectChapterStateBySubject(chapterContext, 'foreshadow')
      : new Map<string, Record<string, unknown>>()
    foreshadows = baseForeshadows.map((f) => {
      const state = stateById.get(f.id)
      if (!state) return f
      return {
        ...f,
        status: pickString(state.status, f.status) as typeof f.status,
      }
    })
    suffix = chapterContext ? `\n（以上状态基于第 ${chapterContext.chapterNumber} 章前事件账本反推）` : ''
  }

  foreshadows = foreshadows
    .filter((f) => f.status === 'planned' || f.status === 'planted' || f.status === 'reinforced') as typeof foreshadows

  if (chapterNumber !== undefined) {
    foreshadows = foreshadows.filter((f) => !f.recoverByChapter || f.recoverByChapter <= chapterNumber + 5) as typeof foreshadows
  }

  foreshadows = foreshadows.slice(0, 10) as typeof foreshadows
  if (foreshadows.length === 0) {
    return { content: [{ type: 'text', text: '当前没有待回收伏笔。' }], details: undefined }
  }
  const list = foreshadows
    .map((f) => `- ${f.description}（类别 ${f.category}，状态 ${f.status}${f.recoverByChapter ? `，预计第 ${f.recoverByChapter} 章前回收` : ''}）`)
    .join('\n')
  return { content: [{ type: 'text', text: `## 未回收伏笔（Top 10）\n${list}${suffix}` }], details: undefined }
}

function answerClues(
  store: NovelStore,
  projectId: string,
  boundary?: ChapterBoundaryContext,
  chapterContext?: ChapterStoryContext,
): AgentToolResult<undefined> {
  // P0 修复：优先用 boundary.entities.clues（章前快照），回退到账本覆盖逻辑
  const baseClues = boundary ? boundary.entities.clues : store.listClues(projectId)

  let clues: typeof baseClues
  let suffix: string
  if (boundary) {
    clues = baseClues
    suffix = boundary.fromSnapshot
      ? `\n（以上为第 ${boundary.chapterNumber} 章开篇前快照，与注入上下文一致）`
      : `\n（未找到 N-1 快照，回退为当前活库状态）`
  } else {
    const stateById = chapterContext
      ? collectChapterStateBySubject(chapterContext, 'clue')
      : new Map<string, Record<string, unknown>>()
    clues = baseClues.map((c) => {
      const state = stateById.get(c.id)
      if (!state) return c
      return {
        ...c,
        progress: pickNumber(state.progress, c.progress),
      }
    })
    suffix = chapterContext ? `\n（以上状态基于第 ${chapterContext.chapterNumber} 章前事件账本反推）` : ''
  }

  clues = clues
    .filter((c) => c.progress < 100)
    .sort((a, b) => b.progress - a.progress)
    .slice(0, 8) as typeof clues

  if (clues.length === 0) {
    return { content: [{ type: 'text', text: '当前没有进行中的线索。' }], details: undefined }
  }
  const list = clues
    .map((c) => `- ${c.description}（进度 ${c.progress}%${c.isMisleading ? '，误导线索' : ''}）`)
    .join('\n')
  return { content: [{ type: 'text', text: `## 进行中线索（Top 8）\n${list}${suffix}` }], details: undefined }
}

function answerStyle(store: NovelStore, projectId: string): AgentToolResult<undefined> {
  const guides = store.listStyleGuide(projectId)
  if (guides.length === 0) {
    return { content: [{ type: 'text', text: '尚未配置风格指南。' }], details: undefined }
  }
  const list = guides.map((g) => `- ${g.category}：${g.rule}${g.example ? `（示例：${g.example}）` : ''}`).join('\n')
  return { content: [{ type: 'text', text: `## 风格指南\n${list}` }], details: undefined }
}

function answerOutline(store: NovelStore, projectId: string): AgentToolResult<undefined> {
  const project = store.getProject(projectId)
  if (!project) {
    return { content: [{ type: 'text', text: '项目不存在。' }], details: undefined }
  }
  const text = [
    `## 项目：${project.title}`,
    `类型：${project.genre || '未设定'}`,
    `阶段：${project.currentStage || '未设定'} | 当前卷：${project.currentVolume} | 当前章：${project.currentChapter}`,
    ``,
    `### 简介`,
    project.synopsis || '（暂无）',
    ``,
    `### 大纲`,
    project.outline || '（暂无）',
  ].join('\n')
  return { content: [{ type: 'text', text }], details: undefined }
}

function answerWorld(store: NovelStore, projectId: string): AgentToolResult<undefined> {
  const rules = store.listWorldRules(projectId)
  const factions = store.listFactions(projectId)
  const locations = store.listLocations(projectId)

  const parts: string[] = ['## 世界设定']
  if (rules.length > 0) {
    parts.push('\n### 世界规则\n' + rules.map((r) => `- [${r.category}] ${r.rule}${r.cost ? `（代价：${r.cost}）` : ''}`).join('\n'))
  }
  if (factions.length > 0) {
    parts.push('\n### 势力\n' + factions.slice(0, 10).map((f) => `- ${f.name}（${f.type}，实力 ${f.strength}，状态 ${f.status}）`).join('\n'))
  }
  if (locations.length > 0) {
    parts.push('\n### 地点\n' + locations.slice(0, 10).map((l) => `- ${l.name}（${l.type}，重要度 ${l.significance}）`).join('\n'))
  }
  if (rules.length === 0 && factions.length === 0 && locations.length === 0) {
    parts.push('暂无世界设定。')
  }
  return { content: [{ type: 'text', text: parts.join('\n') }], details: undefined }
}

function answerGuide(): AgentToolResult<undefined> {
  const text = [
    '## 小说信息问答使用指南',
    '你可以用自然语言提问，例如：',
    '- 上一章结尾是什么？',
    '- 角色 "林深" 的当前目标是什么？',
    '- 当前最大的冲突是什么？',
    '- 有哪些未回收的伏笔？',
    '- 故事的风格要求是什么？',
    '- 全书大纲是什么？',
    '- 世界设定/势力/地点有哪些？',
  ].join('\n')
  return { content: [{ type: 'text', text }], details: undefined }
}

// ── 章前状态反推辅助函数 ──

/**
 * 从 ChapterStoryContext.stateBeforeChapter 中按 subjectType 聚合，
 * 返回 subjectId → { dimension: value } 的映射。
 *
 * stateBeforeChapter 已经按 (subjectType, subjectId, dimension, targetType, targetId)
 * 去重并保留最近一次变化（见 novel-memory-store.getChapterStoryContext），
 * 因此这里只需按 subjectType 过滤后按 subjectId 分组即可。
 */

function collectChapterStateBySubject(
  context: ChapterStoryContext,
  subjectType: 'character' | 'conflict' | 'foreshadow' | 'clue',
): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>()
  for (const state of context.stateBeforeChapter) {
    if (state.subjectType !== subjectType) continue
    const entry = map.get(state.subjectId) ?? {}
    entry[state.dimension] = state.value
    map.set(state.subjectId, entry)
  }
  return map
}

/** 账本值若为非空字符串则采用，否则回退到 store 中的当前值 */

function pickString(ledgerValue: unknown, fallback: string): string {
  return typeof ledgerValue === 'string' && ledgerValue.length > 0 ? ledgerValue : fallback
}

/** 账本值若为有效数字则采用，否则回退到 store 中的当前值 */

function pickNumber(ledgerValue: unknown, fallback: number): number {
  return typeof ledgerValue === 'number' && Number.isFinite(ledgerValue) ? ledgerValue : fallback
}

// ── 工具创建函数 ──

/**
 * 创建小说状态查询工具
 *
 * 读工具：查询故事状态，结果作为 tool message 追加到对话末尾。
 * 不影响系统提示词和章节上下文 → 前缀缓存命中。
 *
 * 双事实源修复（P0）：当传入 asOfChapter 且注入了 boundaryProvider 时，
 * 走与 prompt-builder 注入路径相同的章前语义（N-1 快照优先，活库兜底），
 * 避免重写中间章节时读到未来章节已写入的状态。未传 asOfChapter 时走活库最新值（顺序生成场景）。
 */

export function createNovelQueryStateTool(
  store: NovelStore,
  boundaryProvider?: ChapterBoundaryProvider,
): ToolDefinition<typeof QueryStateParams> {
  return defineTool({
    name: 'novel_query_state',
    label: '查询故事状态',
    description:
      '查询小说的故事状态，包括角色、关系、冲突、伏笔、线索、世界规则等。' +
      '用于在创作过程中获取状态信息。此工具只读不写，不影响缓存。' +
      '重写中间章节时请传 asOfChapter 获取该章开篇前的状态，避免读到未来章节的状态倒灌。',
    promptSnippet: '查询小说故事状态',
    parameters: QueryStateParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const { projectId, queryType, asOfChapter } = params

      // 当传入 asOfChapter 且有 boundaryProvider 时，走统一章前语义
      // 与 prompt-builder.buildChapterContextShared 注入路径一致，消除双事实源
      const boundary = (asOfChapter !== undefined && boundaryProvider)
        ? boundaryProvider.getChapterBoundaryContext(projectId, asOfChapter)
        : undefined

      let result: string

      if (boundary) {
        const e = boundary.entities
        const suffix = boundary.fromSnapshot
          ? `\n\n（以上为第 ${asOfChapter} 章开篇前快照，与注入上下文一致）`
          : `\n\n（未找到 N-1 快照，回退为当前活库状态）`
        switch (queryType) {
          case 'characters':
            result = JSON.stringify(e.characters, null, 2) + suffix
            break
          case 'relationships':
            result = JSON.stringify(e.relationships, null, 2) + suffix
            break
          case 'conflicts':
            result = JSON.stringify(e.conflicts, null, 2) + suffix
            break
          case 'foreshadowing':
            result = JSON.stringify(e.foreshadowing, null, 2) + suffix
            break
          case 'clues':
            result = JSON.stringify(e.clues, null, 2) + suffix
            break
          case 'world_rules':
            result = JSON.stringify(store.listWorldRules(projectId), null, 2) + suffix
            break
          case 'constraints':
            result = JSON.stringify(store.listConstraints(projectId), null, 2) + suffix
            break
          case 'info_layers':
            result = JSON.stringify(e.informationLayers, null, 2) + suffix
            break
          case 'style_guide':
            result = JSON.stringify(store.listStyleGuide(projectId), null, 2) + suffix
            break
          case 'all':
            result = JSON.stringify({
              characters: e.characters,
              relationships: e.relationships,
              conflicts: e.conflicts,
              foreshadowing: e.foreshadowing,
              clues: e.clues,
              factions: e.factions,
              locations: e.locations,
              items: e.items,
              worldElements: e.worldElements,
              informationLayers: e.informationLayers,
              worldRules: store.listWorldRules(projectId),
              constraints: store.listConstraints(projectId),
              styleGuides: store.listStyleGuide(projectId),
            }, null, 2) + suffix
            break
          default:
            result = `未知查询类型: ${queryType}`
        }
      } else {
        // 活库最新值（顺序生成场景，或未注入 boundaryProvider 的兼容路径）
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
