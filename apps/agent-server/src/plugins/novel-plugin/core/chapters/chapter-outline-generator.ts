import { randomUUID } from 'node:crypto'
import type {
  ChapterOutlineDraft,
  ChapterOutlineGenerationMode,
  ChapterOutlineGenerationResult,
  NovelChapter
} from '@repo/shared/novel'
import type {
  PluginContext,
  PluginPayloadStats,
  PluginSessionHandle
} from '../../../../core/plugin/plugin-types.js'
import type { NovelStore } from '../novel-store.js'
import type { NovelMemoryStore } from '../novel-memory-store.js'
import type { PromptManager } from '../prompting/prompt-manager.js'
import { parseNovelModelRef, type NovelModelSelection } from '../domain/novel-model-ref.js'
import {
  addLlmUsage,
  extractLlmUsageFromMessage,
  type LlmUsageSnapshot
} from '../agent-run-utils.js'
import {
  buildChapterOutlineDraftFromSubmit,
  createChapterOutlineSubmitTool,
  formatChapterOutlineSubmitAttempts,
  type ChapterOutlineSubmitAttempt,
  type ChapterOutlineSubmitDraftHolder,
  hashChapterOutline,
  hashChapterOutlineContext,
  parseChapterOutlineDraft
} from './chapter-outline.js'

const PROMPT_VERSION = 'outline-planner-v1'
const MAX_CONTEXT_ITEMS = 12

export interface GenerateChapterOutlineParams {
  projectId: string
  chapterNumber: number
  mode: ChapterOutlineGenerationMode
  currentOutline: string
  expectedOutline: string
  instruction?: string
  /** 本次请求模型，优先于项目主模型和 Agent 配置。 */
  modelId?: NovelModelSelection
  signal?: AbortSignal
}

interface PayloadTotals {
  messagesChars: number
  toolsChars: number
  toolCount: number
  totalChars: number
  roundTrips: number
}

interface CompactStoryEvent {
  id: string
  chapterNumber: number
  sceneOrder: number
  type: string
  title: string
  summary: string
  outcome: string
  status: string
}

interface OutlineContextBuildResult {
  value: Record<string, unknown>
  warnings: string[]
  characterNames: Map<string, string>
  storylineNames: Map<string, string>
}

function truncate(value: string | null | undefined, limit: number): string {
  const text = value?.trim() ?? ''
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n[内容已截断]`
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function prioritize<T extends { id: string; updatedAt?: number }>(
  items: T[],
  preferredIds: ReadonlySet<string>,
  max = MAX_CONTEXT_ITEMS
): T[] {
  return [...items]
    .sort((a, b) => {
      const priority = Number(preferredIds.has(b.id)) - Number(preferredIds.has(a.id))
      return priority || (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id)
    })
    .slice(0, max)
}

function compactStoryEvent(event: {
  id: string
  chapterNumber: number
  sceneOrder: number
  type: string
  title: string
  summary: string
  outcome: string
  status: string
}): CompactStoryEvent {
  return {
    id: event.id,
    chapterNumber: event.chapterNumber,
    sceneOrder: event.sceneOrder,
    type: event.type,
    title: truncate(event.title, 160),
    summary: truncate(event.summary, 500),
    outcome: truncate(event.outcome, 300),
    status: event.status
  }
}

export class ChapterOutlineGenerator {
  constructor(
    private readonly store: NovelStore,
    private readonly memoryStore: NovelMemoryStore,
    private readonly promptManager: PromptManager,
    private readonly context: PluginContext
  ) {}

  async generate(params: GenerateChapterOutlineParams): Promise<ChapterOutlineGenerationResult> {
    params.signal?.throwIfAborted()
    const project = this.store.getProject(params.projectId)
    if (!project) throw new Error(`小说项目不存在: ${params.projectId}`)
    const chapter = this.store.getChapter(params.projectId, params.chapterNumber)
    if (!chapter) throw new Error(`章节不存在: ${params.chapterNumber}`)
    if (chapter.status === 'published') throw new Error('已发布章节不能生成新章纲')
    if (hashChapterOutline(chapter.outline) !== hashChapterOutline(params.expectedOutline)) {
      throw new Error('章纲已经发生变化，请刷新章节后重试')
    }
    if ((params.mode === 'rewrite' || params.mode === 'expand') && !params.currentOutline.trim()) {
      throw new Error(`${params.mode === 'rewrite' ? '改写' : '扩写'}模式需要已有章纲`)
    }

    // LLM 调用前冻结全部来源版本。生成期间不持有数据库事务，保存时由章节 PATCH 再校验。
    const base = {
      chapterId: chapter.id,
      outlineHash: hashChapterOutline(chapter.outline),
      contentRevisionId: this.store.getCurrentContentRevision(chapter.id)?.id ?? null,
      planRevisionId: this.store.getCurrentPlan(chapter.id)?.id ?? null
    }
    const {
      value: outlineContext,
      warnings,
      characterNames,
      storylineNames
    } = this.buildContext(chapter, params.currentOutline)
    const contextFingerprint = hashChapterOutlineContext(outlineContext)
    const frozenBase = { ...base, contextFingerprint }
    const generationId = randomUUID()

    const rolePrompt = this.promptManager.getTemplate('role-outline-planner', params.projectId)
    // 方案 D：结构化提交工具为主路径（参数结构由 provider 约束 + SDK 校验），
    // 文本 JSON 解析降级为 provider 不支持工具时的兜底。
    const submitDraft: ChapterOutlineSubmitDraftHolder = {}
    const submitTool = createChapterOutlineSubmitTool(submitDraft)
    const systemPrompt = this.promptManager.render(
      'system-base',
      {
        agent_type: 'outline-planner',
        agent_role: rolePrompt
      },
      params.projectId
    ) + '\n\n必须调用 submit_chapter_outline 工具提交章纲；不要在对话文本中输出 JSON。'
    const taskMessage = this.buildTaskMessage(params.mode, params.instruction, {
      hasCharacters: characterNames.size > 0,
      hasStorylines: storylineNames.size > 0
    })
    const contextText = JSON.stringify(outlineContext, null, 2)
    const userMessage = `${taskMessage}\n\n<chapter_outline_context>\n${contextText}\n</chapter_outline_context>`

    const projectModel = parseNovelModelRef(this.store.getNovelModelId(params.projectId))
    const directorAgent = this.context.subagentManager?.getAgent('novel-director')
    const modelId = params.modelId ?? projectModel ?? directorAgent?.model
    const payloadTotals: PayloadTotals = {
      messagesChars: 0,
      toolsChars: 0,
      toolCount: 0,
      totalChars: 0,
      roundTrips: 0
    }
    const addPayload = (stats: PluginPayloadStats): void => {
      payloadTotals.messagesChars += stats.messagesChars
      payloadTotals.toolsChars += stats.toolsChars
      payloadTotals.toolCount = Math.max(payloadTotals.toolCount, stats.toolCount)
      payloadTotals.totalChars += stats.totalChars
      payloadTotals.roundTrips += 1
    }

    const startedAt = Date.now()
    let session: PluginSessionHandle
    try {
      session = await this.context.createSession({
        systemPrompt,
        userMessage,
        // 挂载提交工具时不声明 responseFormat='json'（底座会注入 tool_choice='none'）
        tools: [submitTool],
        modelId,
        temperature: directorAgent?.temperature ?? 0.4,
        timeoutMs: 180_000,
        signal: params.signal,
        promptCacheScope: `novel:${params.projectId}:outline:${params.chapterNumber}`,
        onPayloadStats: addPayload
      })
    } catch (err) {
      this.recordCall({
        projectId: params.projectId,
        chapterNumber: params.chapterNumber,
        generationId,
        mode: params.mode,
        systemPrompt,
        chapterContext: contextText,
        userMessage: taskMessage,
        taskInput: params.instruction ?? '',
        result: '',
        durationMs: Date.now() - startedAt,
        status: params.signal?.aborted ? 'cancelled' : 'error',
        error: err instanceof Error ? err.message : String(err),
        sessionId: '',
        payload: payloadTotals,
        contextFingerprint
      })
      throw err
    }

    let usage: LlmUsageSnapshot | undefined
    let rawResult = ''
    let status: 'success' | 'error' | 'cancelled' = 'success'
    let errorMessage = ''
    const unsubscribe = session.subscribe((event: Record<string, unknown>) => {
      if (event.type !== 'message_end') return
      const message = (event as { message?: Record<string, unknown> }).message
      if (!message || message.role !== 'assistant') return
      const next = extractLlmUsageFromMessage(message)
      if (next) usage = addLlmUsage(usage, next)
    })

    try {
      rawResult = await session.prompt()
      const references = {
        characters: characterNames,
        storylines: storylineNames
      }
      let draft: ChapterOutlineDraft
      if (submitDraft.payload) {
        // ── 主路径：工具提交（结构化参数经 provider 约束 + SDK 校验后闭包捕获）──
        draft = buildChapterOutlineDraftFromSubmit(submitDraft.payload, references)
      } else if (submitDraft.attempts?.length) {
        // 模型调过工具但每次都被协议校验打回（工具已把纠正提示回给模型，仍未修好）。
        // 直接报最后一次的失败原因，不再走文本兜底——文本里此时只有确认语。
        const last = submitDraft.attempts[submitDraft.attempts.length - 1]
        this.context.logger.warn(
          {
            chapterNumber: params.chapterNumber,
            attempts: submitDraft.attempts.length,
            reason: last.reason,
            payload: last.payload
          },
          '章纲工具提交全部未通过协议校验'
        )
        throw new Error(last.reason ?? '章纲提交参数不符合协议')
      } else {
        // ── 兜底：provider 未发起工具调用 → 容错解析自由文本 + 一次修复轮 ──
        try {
          draft = parseChapterOutlineDraft(rawResult, references)
        } catch (firstError) {
          if (params.signal?.aborted) throw firstError
          this.context.logger.warn(
            { chapterNumber: params.chapterNumber, rawHead: rawResult.slice(0, 160), err: firstError },
            '章纲协议校验失败且未收到工具提交，发起同会话修复轮'
          )
          const repairedRaw = await session.prompt(
            [
              '你上一条回复不符合输出协议：' +
                (firstError instanceof Error ? firstError.message : String(firstError)),
              '',
              '请立即调用 submit_chapter_outline 工具提交章纲；',
              '若无法调用工具，则只输出一个合法 JSON 对象（顶层字段：version、outlineText、chapterGoal、openingState、progression、obstacles、turningPoint、endingState、hook、sceneCountEstimate、povSuggestions、storylines、continuityRisks），不要任何解释或元信息包装。'
            ].join('\n')
          )
          rawResult = repairedRaw
          draft = submitDraft.payload
            ? buildChapterOutlineDraftFromSubmit(submitDraft.payload, references)
            : parseChapterOutlineDraft(repairedRaw, references)
        }
      }
      const resolvedModelId =
        usage?.llmProvider && usage?.llmModel
          ? `${usage.llmProvider}:${usage.llmModel}`
          : modelId
            ? `${modelId.provider}:${modelId.modelId}`
            : null
      return {
        generationId,
        draft,
        base: frozenBase,
        model: { modelId: resolvedModelId, promptVersion: PROMPT_VERSION },
        warnings,
        ...(usage
          ? {
              usage: {
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheReadTokens: usage.cacheReadTokens,
                cacheWriteTokens: usage.cacheWriteTokens
              }
            }
          : {})
      }
    } catch (err) {
      status = params.signal?.aborted ? 'cancelled' : 'error'
      errorMessage = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      unsubscribe()
      session.dispose()
      // 工具提交的原始参数落库：session.prompt() 只返回助手确认语（"章纲已提交…"），
      // 模型真正传给 submit_chapter_outline 的结构在日志里此前完全缺失，
      // 协议校验失败时无从判断是哪个字段被填了什么。
      const submissionAudit = formatChapterOutlineSubmitAttempts(submitDraft.attempts)
      this.recordCall({
        projectId: params.projectId,
        chapterNumber: params.chapterNumber,
        generationId,
        mode: params.mode,
        systemPrompt,
        chapterContext: contextText,
        userMessage: taskMessage,
        taskInput: params.instruction ?? '',
        result: submissionAudit ? `${rawResult}\n\n${submissionAudit}`.trim() : rawResult,
        toolSubmissions: submitDraft.attempts ?? [],
        durationMs: Date.now() - startedAt,
        status,
        error: errorMessage,
        sessionId: session.sessionId ?? '',
        usage,
        payload: payloadTotals,
        contextFingerprint
      })
    }
  }

  private buildContext(chapter: NovelChapter, currentOutline: string): OutlineContextBuildResult {
    const projectId = chapter.projectId
    const chapters = this.store.listChapters(projectId)
    const previous = chapters
      .filter((item) => item.chapterNumber < chapter.chapterNumber)
      .sort((a, b) => b.chapterNumber - a.chapterNumber)
      .slice(0, 3)
    const next = chapters
      .filter((item) => item.chapterNumber > chapter.chapterNumber)
      .sort((a, b) => a.chapterNumber - b.chapterNumber)[0]
    const immediatePrevious = previous[0]
    const volume = chapter.volumeId
      ? this.store.listVolumes(projectId).find((item) => item.id === chapter.volumeId)
      : this.store.listVolumes(projectId).find((item) => item.volumeNumber === chapter.volume)

    const appearanceIds = (entityType: string): Set<string> =>
      new Set([
        ...this.store.listChapterAppearanceIds({
          projectId,
          chapterNumber: chapter.chapterNumber,
          entityType
        }),
        ...(chapter.chapterNumber > 1
          ? this.store.listChapterAppearanceIds({
              projectId,
              chapterNumber: chapter.chapterNumber - 1,
              entityType
            })
          : [])
      ])
    const characterAppearanceIds = appearanceIds('character')
    for (const character of this.store.listCharacters(projectId)) {
      if (character.isProtagonist) characterAppearanceIds.add(character.id)
    }
    const characters = prioritize(this.store.listCharacters(projectId), characterAppearanceIds)
    const characterIds = new Set(characters.map((item) => item.id))
    const relationships = this.store
      .listRelationships(projectId)
      .filter((item) => characterIds.has(item.characterA) || characterIds.has(item.characterB))
      .slice(0, 20)

    const conflicts = prioritize(
      this.store.listConflicts(projectId).filter((item) => item.stage !== 'resolved'),
      appearanceIds('conflict')
    )
    const foreshadowing = prioritize(
      this.store
        .listForeshadowing(projectId)
        .filter((item) => item.status !== 'recovered' && item.status !== 'abandoned'),
      appearanceIds('foreshadow')
    )
    const clues = prioritize(
      this.store.listClues(projectId).filter((item) => item.progress < 100),
      appearanceIds('clue')
    )
    const storylines = this.store
      .listStorylines(projectId)
      .filter((item) => item.lifecycle === 'active' || item.lifecycle === 'paused')
      .sort(
        (a, b) =>
          Number(b.maturity === 'established') - Number(a.maturity === 'established') ||
          b.updatedAt - a.updatedAt
      )
      .slice(0, MAX_CONTEXT_ITEMS)
    const storyContext = this.memoryStore.getChapterStoryContext(projectId, chapter.chapterNumber)
    const timelineInvalidation = this.store.getActiveTimelineInvalidation(projectId)
    const warnings = [...storyContext.continuityWarnings.slice(0, 12)]
    const project = this.store.getProject(projectId)!
    if (!project.outline?.trim()) warnings.push('项目尚未填写全书大纲')
    if (!volume?.outline?.trim()) warnings.push('当前章节所属卷尚未填写卷纲')
    if (timelineInvalidation) {
      warnings.push(
        `第 ${timelineInvalidation.startChapterNumber} 章起的派生时间线当前处于失效状态`
      )
    }

    const value = {
      project: {
        id: project.id,
        title: project.title,
        genre: project.genre,
        synopsis: truncate(project.synopsis, 1600),
        outline: truncate(project.outline, 5000),
        targetWords: project.targetWords,
        currentStage: project.currentStage,
        targetPlatform: project.targetPlatform ?? null
      },
      volume: volume
        ? {
            id: volume.id,
            volumeNumber: volume.volumeNumber,
            title: volume.title,
            outline: truncate(volume.outline, 3500)
          }
        : null,
      chapter: {
        id: chapter.id,
        chapterNumber: chapter.chapterNumber,
        title: chapter.title,
        rhythm: chapter.rhythm ?? null,
        positioning: chapter.positioning ?? null,
        tension: chapter.tension ?? null,
        currentOutline: truncate(currentOutline, 20000)
      },
      continuityAnchors: {
        previousChapters: previous.map((item) => ({
          chapterNumber: item.chapterNumber,
          title: item.title,
          recap: truncate(item.recap || item.content, 700)
        })),
        immediatePreviousEnding: truncate(immediatePrevious?.content.slice(-1000), 1000),
        nextChapter: next
          ? {
              chapterNumber: next.chapterNumber,
              title: next.title,
              outline: truncate(next.outline, 1200)
            }
          : null
      },
      storylines: storylines.map((item) => ({
        id: item.id,
        name: item.name,
        kind: item.kind,
        lifecycle: item.lifecycle,
        maturity: item.maturity,
        description: truncate(item.description, 700),
        recentProgress: this.store
          .listProgressByStoryline(item.id, ['confirmed', 'planned'])
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 3)
          .map((progress) => ({
            type: progress.type,
            beforeState: truncate(progress.beforeState, 300),
            afterState: truncate(progress.afterState, 300),
            summary: truncate(progress.summary, 500),
            status: progress.status
          }))
      })),
      characters: characters.map((item) => ({
        id: item.id,
        name: item.name,
        description: truncate(item.description, 500),
        identity: truncate(item.identity, 500),
        plotRole: item.plotRole,
        isProtagonist: item.isProtagonist,
        currentState: truncate(item.currentState, 500),
        currentGoal: truncate(item.currentGoal, 500),
        currentPressure: truncate(item.currentPressure, 500),
        longTermDesire: truncate(item.longTermDesire, 500),
        authorOnlySecret: truncate(item.secret, 500)
      })),
      relationships: relationships.map((item) => ({
        characterA: item.characterA,
        characterB: item.characterB,
        relationType: item.relationType,
        currentStage: truncate(item.currentStage, 300),
        alignment: item.alignment,
        trend: item.trend
      })),
      conflicts: conflicts.map((item) => ({
        id: item.id,
        description: truncate(item.description, 700),
        type: item.type,
        stage: item.stage,
        intensity: item.intensity,
        stakes: truncate(item.stakes, 500),
        climaxChapter: item.climaxChapter ?? null
      })),
      foreshadowing: foreshadowing.map((item) => ({
        id: item.id,
        description: truncate(item.description, 700),
        category: item.category,
        status: item.status,
        recoverByChapter: item.recoverByChapter
      })),
      clues: clues.map((item) => ({
        id: item.id,
        description: truncate(item.description, 700),
        pointsTo: truncate(item.pointsTo, 500),
        progress: item.progress,
        currentStep: truncate(item.currentStep, 400),
        nextStep: truncate(item.nextStep, 400)
      })),
      narratives: prioritize(
        this.store.listNarratives(projectId).filter((item) => item.status === 'active'),
        appearanceIds('narrative')
      ).map((item) => ({
        id: item.id,
        description: truncate(item.description, 700),
        type: item.type,
        status: item.status
      })),
      informationLayers: this.store
        .listInformationLayers(projectId)
        .filter((item) => !item.isRevealed || item.revealChapter === chapter.chapterNumber)
        .sort(
          (a, b) =>
            Number(b.revealChapter === chapter.chapterNumber) -
            Number(a.revealChapter === chapter.chapterNumber)
        )
        .slice(0, MAX_CONTEXT_ITEMS)
        .map((item) => ({
          id: item.id,
          description: truncate(item.infoDescription, 700),
          readerKnows: item.readerKnows,
          characterKnowledge: parseJsonRecord(item.characterKnowledge),
          revealStage: item.revealStage,
          revealChapter: item.revealChapter,
          isRevealed: item.isRevealed
        })),
      setting: {
        locations: prioritize(
          this.store.listLocations(projectId),
          appearanceIds('location'),
          8
        ).map((item) => ({
          id: item.id,
          name: item.name,
          description: truncate(item.description, 500),
          status: item.status
        })),
        factions: prioritize(this.store.listFactions(projectId), appearanceIds('faction'), 8).map(
          (item) => ({
            id: item.id,
            name: item.name,
            description: truncate(item.description, 500),
            status: item.status
          })
        ),
        items: prioritize(this.store.listItems(projectId), appearanceIds('item'), 8).map(
          (item) => ({
            id: item.id,
            name: item.name,
            description: truncate(item.description, 500),
            status: item.status
          })
        )
      },
      constraints: this.store
        .listConstraints(projectId)
        .filter((item) => item.isActive)
        .slice(0, 20)
        .map((item) => ({
          id: item.id,
          type: item.type,
          scope: item.scope,
          rule: truncate(item.rule, 700)
        })),
      worldRules: this.store
        .listWorldRules(projectId)
        .slice(0, 20)
        .map((item) => ({
          id: item.id,
          category: item.category,
          rule: truncate(item.rule, 700),
          cost: truncate(item.cost, 400),
          isFixed: item.isFixed
        })),
      styleGuide: this.store
        .listStyleGuide(projectId)
        .slice(0, 12)
        .map((item) => ({
          category: item.category,
          rule: truncate(item.rule, 500)
        })),
      storyLedger: {
        stateBeforeChapter: storyContext.stateBeforeChapter.slice(-40),
        activeThreads: storyContext.activeThreads.slice(0, 12).map(compactStoryEvent),
        plannedEvents: storyContext.plannedEvents.slice(0, 12).map(compactStoryEvent),
        unresolvedDebts: storyContext.unresolvedDebts.slice(0, 16).map((item) => ({
          subjectType: item.subjectType,
          subjectId: item.subjectId,
          dimension: item.dimension,
          value: item.afterValue,
          reason: truncate(item.reason, 400)
        })),
        futureCommitments: storyContext.futureCommitments.slice(0, 12).map((item) => ({
          event: compactStoryEvent(item.event),
          changes: item.changes.slice(0, 8).map((change) => ({
            subjectType: change.subjectType,
            subjectId: change.subjectId,
            dimension: change.dimension,
            afterValue: change.afterValue,
            reason: truncate(change.reason, 300)
          }))
        })),
        annotations: storyContext.annotations.slice(0, 12).map((item) => ({
          kind: item.kind,
          content: truncate(item.content, 500),
          entityType: item.entityType,
          entityId: item.entityId
        })),
        continuityWarnings: storyContext.continuityWarnings.slice(0, 12)
      },
      timelineInvalidation: timelineInvalidation
        ? {
            startChapterNumber: timelineInvalidation.startChapterNumber,
            affectedChapters: timelineInvalidation.affectedChapters
          }
        : null
    }

    return {
      value,
      warnings,
      characterNames: new Map(characters.map((item) => [item.id, item.name])),
      storylineNames: new Map(storylines.map((item) => [item.id, item.name]))
    }
  }

  private buildTaskMessage(
    mode: ChapterOutlineGenerationMode,
    instruction: string | undefined,
    availability: { hasCharacters: boolean; hasStorylines: boolean }
  ): string {
    const modeInstruction = {
      create: '忽略当前编辑内容，从项目事实重新规划本章。',
      rewrite: '保留当前章纲的有效意图，修复结构、因果和连续性问题。',
      expand: '不改变当前章纲的核心走向，补足推进步骤、阻力、转折和结尾状态。'
    }[mode]
    // 上下文里一个角色/故事线都没有时（新项目、实体尚未抽取），模型仍会照提示词
    // 给出 mode=single 或故事线推进，只能填空 ID —— 直接打穿协议校验。在此显式封口。
    const referenceConstraints = [
      ...(availability.hasCharacters
        ? []
        : ['本次上下文没有任何已有角色：povSuggestions 只能用 mode=omniscient 或 mode=none，禁止 mode=single，禁止编造角色 ID。']),
      ...(availability.hasStorylines
        ? []
        : ['本次上下文没有任何已有故事线：storylines 必须为空数组，禁止编造故事线 ID。'])
    ]
    return [
      `生成模式：${mode}`,
      modeInstruction,
      instruction?.trim() ? `作者补充要求：${instruction.trim()}` : '作者补充要求：无',
      ...referenceConstraints,
      '依据下方上下文生成一份章纲草稿。只返回协议规定的 JSON。'
    ].join('\n')
  }

  private recordCall(input: {
    projectId: string
    chapterNumber: number
    generationId: string
    mode: ChapterOutlineGenerationMode
    systemPrompt: string
    chapterContext: string
    userMessage: string
    taskInput: string
    result: string
    /** 模型对 submit_chapter_outline 的每次提交（含被协议打回的） */
    toolSubmissions?: readonly ChapterOutlineSubmitAttempt[]
    durationMs: number
    status: 'success' | 'error' | 'cancelled'
    error: string
    sessionId: string
    usage?: LlmUsageSnapshot
    payload: PayloadTotals
    contextFingerprint: string
  }): void {
    const toolSubmissions = input.toolSubmissions ?? []
    try {
      this.store.insertAgentLog({
        projectId: input.projectId,
        chapterNumber: input.chapterNumber,
        agentType: 'outline-planner',
        agentName: '章纲规划师',
        displayAgentType: 'outline-planner',
        displayAgentName: '章纲规划师',
        phase: 'outline',
        systemPrompt: input.systemPrompt,
        chapterContext: input.chapterContext,
        userMessage: input.userMessage,
        taskInput: input.taskInput,
        userInstructions: input.taskInput ? [input.taskInput] : [],
        // tools 段承载工具入参审计（结构化），result 段同时带可读文本副本
        tools: toolSubmissions.map((attempt, index) => ({
          tool: 'submit_chapter_outline',
          attempt: index + 1,
          accepted: attempt.accepted,
          ...(attempt.reason ? { reason: attempt.reason } : {}),
          arguments: attempt.payload
        })),
        toolNames: toolSubmissions.length > 0 ? ['submit_chapter_outline'] : [],
        askStoryPolicy: 'allOffWithReferences',
        askStoryEnabled: false,
        result: input.result,
        resultLength: input.result.length,
        durationMs: input.durationMs,
        status: input.status,
        error: input.error,
        sessionId: input.sessionId,
        operation: input.mode,
        inputTokens: input.usage?.inputTokens ?? 0,
        outputTokens: input.usage?.outputTokens ?? 0,
        cacheReadTokens: input.usage?.cacheReadTokens ?? 0,
        cacheWriteTokens: input.usage?.cacheWriteTokens ?? 0,
        llmProvider: input.usage?.llmProvider ?? '',
        llmModel: input.usage?.llmModel ?? '',
        payloadMessagesChars: input.payload.messagesChars,
        payloadToolsChars: input.payload.toolsChars,
        payloadToolCount: input.payload.toolCount,
        payloadTotalChars: input.payload.totalChars,
        llmRoundTrips: input.payload.roundTrips,
        cacheKey: `novel:${input.projectId}:outline:${input.chapterNumber}`,
        requestFingerprint: input.contextFingerprint,
        cacheablePrefixChars: input.systemPrompt.length
      })
    } catch (err) {
      this.context.logger.warn({ err, projectId: input.projectId }, '章纲生成日志写入失败')
    }

    if (!this.context.agentCallLogger) return
    try {
      this.context.agentCallLogger.record({
        agentId: 'novel-outline-planner',
        agentName: '章纲规划师',
        threadId: input.sessionId,
        systemPrompt: input.systemPrompt,
        userMessage: input.userMessage,
        taskInput: input.taskInput,
        tools: JSON.stringify(toolSubmissions),
        toolNames: JSON.stringify(toolSubmissions.length > 0 ? ['submit_chapter_outline'] : []),
        result: input.result,
        resultLength: input.result.length,
        durationMs: input.durationMs,
        status: input.status === 'success' ? 'success' : 'error',
        error: input.error,
        metadata: JSON.stringify({
          projectId: input.projectId,
          chapterNumber: input.chapterNumber,
          generationId: input.generationId,
          mode: input.mode,
          promptVersion: PROMPT_VERSION,
          source: 'chapter-outline-generator'
        })
      })
    } catch (err) {
      this.context.logger.debug({ err }, '通用章纲生成日志写入失败')
    }
  }
}
