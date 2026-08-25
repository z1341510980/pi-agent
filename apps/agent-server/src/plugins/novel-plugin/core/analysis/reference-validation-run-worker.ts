/**
 * ReferenceValidationRunWorker：P7 同场景验证执行器（方案 §9）。
 *
 * 流程：场景安全校验（拒绝含参考专名/直接引用/剧情序列的场景）→
 * 同模型同参数双路生成（基准 = 无模板规则；模板 = 注入编译规则）→
 * 规则命中分析（LLM 判定四类规则在模板输出中的可观察性）→
 * 相似度核对（模板输出 vs 参考原文的 n-gram 重叠，作为复现阻断结论）。
 *
 * 不变量：
 * - regenerate 必须复用同一 facts hash（store 层冻结）；
 * - 两路使用相同 temperature/maxTokens/模型；规则只注入模板路；
 * - 相似度超阈值记入 safetyReport.blockers（阻断发布，人工不得静默放行）。
 */
import type { PluginContext } from '../../../../core/plugin/plugin-types.js'
import type {
  ReferenceValidationRunStore,
  ReferenceValidationRun
} from './reference-validation-run-store.js'
import type {
  ReferenceTemplateStore,
  ReferenceTemplateVersion
} from './reference-template-store.js'
import type { ReferenceProfileStore } from './reference-profile-store.js'
import type { ReferenceAnalysisService } from './reference-analysis-service.js'
import type { NovelStore } from '../novel-store.js'

export const VALIDATION_SIMILARITY_BLOCK_THRESHOLD = 0.25

export interface ScenarioSafetyViolation {
  kind: 'proper_noun' | 'direct_quote' | 'plot_sequence' | 'unique_scene'
  match: string
}

/** 场景安全校验：场景事实不得包含参考作品特有内容。 */
export function validateScenarioSafety(
  profileStore: ReferenceProfileStore,
  profileId: string,
  scenarioFacts: string
): ScenarioSafetyViolation[] {
  const profile = profileStore.getProfile(profileId)
  if (!profile) return []
  const violations: ScenarioSafetyViolation[] = []
  for (const quote of profile.safetyReport.directQuotes) {
    const head = quote.prefix.slice(0, 10)
    if (head.length >= 6 && scenarioFacts.includes(head)) {
      violations.push({ kind: 'direct_quote', match: head })
    }
  }
  for (const noun of profile.safetyReport.properNouns) {
    if (noun.length >= 2 && scenarioFacts.includes(noun)) {
      violations.push({ kind: 'proper_noun', match: noun })
    }
  }
  for (const sequence of profile.safetyReport.plotSequences) {
    const head = sequence.slice(0, 8)
    if (head.length >= 6 && scenarioFacts.includes(head)) {
      violations.push({ kind: 'plot_sequence', match: head })
    }
  }
  for (const scene of profile.safetyReport.uniqueScenes) {
    const head = scene.slice(0, 8)
    if (head.length >= 6 && scenarioFacts.includes(head)) {
      violations.push({ kind: 'unique_scene', match: head })
    }
  }
  return violations.slice(0, 20)
}

/** 中文 8-gram 重叠率：模板输出与参考原文的连续片段重叠（复现检测）。 */
export function computeSimilarity(
  output: string,
  referenceText: string
): { ngramOverlap: number; longestRun: number } {
  if (output.length < 8 || referenceText.length < 8) return { ngramOverlap: 0, longestRun: 0 }
  const grams = new Set<string>()
  for (let index = 0; index <= output.length - 8; index += 1) {
    grams.add(output.slice(index, index + 8))
  }
  let hits = 0
  let longestRun = 0
  let currentRun = 0
  for (let index = 0; index <= referenceText.length - 8; index += 1) {
    if (grams.has(referenceText.slice(index, index + 8))) {
      hits += 1
      currentRun += 1
      longestRun = Math.max(longestRun, currentRun)
    } else {
      currentRun = 0
    }
  }
  return {
    ngramOverlap: Number((hits / grams.size).toFixed(4)),
    longestRun: longestRun + 8
  }
}

export class ReferenceValidationRunWorker {
  private readonly running = new Map<string, AbortController>()

  constructor(
    private readonly context: PluginContext,
    private readonly runStore: ReferenceValidationRunStore,
    private readonly templateStore: ReferenceTemplateStore,
    private readonly profileStore: ReferenceProfileStore,
    private readonly referenceService: ReferenceAnalysisService,
    private readonly novelStore?: NovelStore
  ) {}

  isRunning(runId: string): boolean {
    return this.running.has(runId)
  }

  requestCancel(runId: string): void {
    this.running.get(runId)?.abort()
  }

  async run(runId: string, scenarioFacts: string): Promise<void> {
    if (this.running.has(runId)) return
    const controller = new AbortController()
    this.running.set(runId, controller)
    try {
      await this.runInternal(runId, scenarioFacts, controller.signal)
    } finally {
      this.running.delete(runId)
    }
  }

  private async runInternal(
    runId: string,
    scenarioFacts: string,
    signal: AbortSignal
  ): Promise<void> {
    const run = this.runStore.getRun(runId)
    if (!run || run.status !== 'queued') return

    // ── 场景安全校验（原创性）：拒绝参考特有内容 ──
    const version = this.templateStore.getVersion(run.templateVersionId)
    if (!version) {
      this.runStore.failRun(runId, '模板版本不存在')
      return
    }
    const template = this.templateStore.getTemplate(version.templateId)
    const violations = template?.sourceProfileId
      ? validateScenarioSafety(this.profileStore, template.sourceProfileId, scenarioFacts)
      : []
    if (violations.length > 0) {
      this.runStore.failRun(
        runId,
        `场景包含参考作品特有内容（${violations
          .map((item) => `${item.kind}:${item.match}`)
          .slice(0, 3)
          .join('、')}），请改用原创场景`
      )
      return
    }
    signal.throwIfAborted()

    // ── 双路配置（同模型同参数；仅模板路注入规则） ──
    const rulesPrompt = compileRulesPrompt(version)
    const sharedConfig = {
      provider: run.providerId,
      modelId: run.modelId,
      temperature: 0.8,
      maxTokens: 2048
    }
    this.runStore.saveGenerationConfig(
      runId,
      { ...sharedConfig, rulesInjected: false },
      { ...sharedConfig, rulesInjected: true, ruleKeys: countRules(version) }
    )

    // ── 双路生成 ──
    let baselineOutput: string
    let templateOutput: string
    try {
      ;[baselineOutput, templateOutput] = await Promise.all([
        this.generateOnce(run, scenarioFacts, null, signal),
        this.generateOnce(run, scenarioFacts, rulesPrompt, signal)
      ])
    } catch (error) {
      if (signal.aborted) return
      this.runStore.failRun(
        runId,
        `双路生成失败：${error instanceof Error ? error.message : '未知错误'}`
      )
      return
    }
    signal.throwIfAborted()

    const usage = {
      llmCalls: 2,
      baselineChars: baselineOutput.length,
      templateChars: templateOutput.length
    }
    this.runStore.saveOutputs(runId, { baselineOutput, templateOutput, usage, cost: {} })

    // ── 规则命中分析（LLM 判定四类规则可观察性） ──
    let ruleHits: Record<string, unknown>
    try {
      ruleHits = await this.analyzeRuleHits(run, version, baselineOutput, templateOutput, signal)
    } catch (error) {
      if (signal.aborted) return
      // 命中分析失败不阻断完成，标记 unknown
      ruleHits = {
        error: error instanceof Error ? error.message : '规则命中分析失败',
        hits: [],
        misses: []
      }
    }
    signal.throwIfAborted()

    // ── 相似度核对：模板输出 vs 参考原文 ──
    let similarity = { ngramOverlap: 0, longestRun: 0 }
    try {
      const sourceId =
        typeof template === 'object' && template?.sourceProfileId
          ? (this.profileStore.getProfile(template.sourceProfileId)?.coverage.sourceId ?? null)
          : null
      if (sourceId && typeof sourceId === 'string') {
        const sections = this.referenceService.listSections(sourceId)
        const includedIds = sections
          .filter((section) => section.included)
          .map((section) => section.id)
        const bundle = this.referenceService.getSectionsText(
          sourceId,
          includedIds.length > 0 ? includedIds : sections.map((section) => section.id)
        )
        similarity = computeSimilarity(templateOutput, bundle.text)
      } else {
        similarity = { ngramOverlap: -1, longestRun: 0 } // 原文已删除，检测能力降级
      }
    } catch {
      similarity = { ngramOverlap: -1, longestRun: 0 }
    }

    const blockers: string[] = []
    if (similarity.ngramOverlap >= VALIDATION_SIMILARITY_BLOCK_THRESHOLD) {
      blockers.push(
        `模板输出与参考原文 8-gram 重叠率 ${similarity.ngramOverlap} 超过阈值 ${VALIDATION_SIMILARITY_BLOCK_THRESHOLD}，存在复现风险，不得发布`
      )
    }
    if (similarity.ngramOverlap < 0) {
      blockers.push('参考原文已删除，相似度检测降级为不可用；发布前需人工复核')
    }
    this.runStore.completeRun(runId, {
      ruleHits,
      safetyReport: {
        similarity,
        blockers,
        degraded: similarity.ngramOverlap < 0,
        scenarioViolations: []
      }
    })
  }

  private async generateOnce(
    run: ReferenceValidationRun,
    scenarioFacts: string,
    rulesPrompt: string | null,
    signal: AbortSignal
  ): Promise<string> {
    const systemPrompt = rulesPrompt
      ? [
          '你是小说作者。基于固定场景事实写一段 300-500 字的正文样章。',
          '必须遵守以下参考模板规则（规则描述的是写作手法，绝不要复现任何参考作品的情节或原文）：',
          rulesPrompt
        ].join('\n')
      : '你是小说作者。基于固定场景事实写一段 300-500 字的正文样章。'
    const startedAt = Date.now()
    let result = ''
    let failure = ''
    let sessionId = ''
    const session = await this.context.createSession({
      systemPrompt,
      userMessage: `## 固定场景事实（frozen）\n${scenarioFacts}`,
      tools: [],
      modelId: { provider: run.providerId ?? '', modelId: run.modelId ?? '' },
      temperature: 0.8,
      maxTokens: 2048,
      timeoutMs: 300_000,
      signal
    })
    try {
      const output = await session.promptStream(() => {})
      if (output.trim().length === 0) throw new Error('生成输出为空')
      result = output.trim().slice(0, 100_000)
      return result
    } catch (error) {
      failure = error instanceof Error ? error.message : '验证样章生成失败'
      throw error
    } finally {
      sessionId = session.sessionId ?? ''
      session.dispose()
      this.recordValidationCall({
        run,
        operation: rulesPrompt ? 'template_generation' : 'baseline_generation',
        agentName: rulesPrompt ? '参考模板验证生成' : '参考基准验证生成',
        systemPrompt,
        result,
        failure,
        durationMs: Date.now() - startedAt,
        sessionId
      })
    }
  }

  private async analyzeRuleHits(
    run: ReferenceValidationRun,
    version: ReferenceTemplateVersion,
    baselineOutput: string,
    templateOutput: string,
    signal: AbortSignal
  ): Promise<Record<string, unknown>> {
    const rules = [
      ...version.spiritRules,
      ...version.techniqueRules,
      ...version.powerRules,
      ...version.pacingRules
    ]
      .map((rule) => `${rule.findingKey}: ${rule.rule}`)
      .slice(0, 20)
    if (rules.length === 0) return { hits: [], misses: [], note: '模板无规则' }
    const systemPrompt = [
      '你是写作规则验收器。对比基准输出与模板输出，判定每条规则在模板输出中是否可观察命中。',
      '只依据文本证据判断，不要猜测。输出严格 JSON：{"hits":["findingKey"],"misses":["findingKey"]}。'
    ].join('\n')
    const startedAt = Date.now()
    let result: Record<string, unknown> = {}
    let failure = ''
    let sessionId = ''
    const session = await this.context.createSession({
      systemPrompt,
      userMessage: [
        '## 规则清单',
        rules.join('\n'),
        '## 基准输出（无规则）',
        baselineOutput.slice(0, 6000),
        '## 模板输出（注入规则）',
        templateOutput.slice(0, 6000)
      ].join('\n\n'),
      tools: [],
      responseFormat: 'json',
      modelId: { provider: run.providerId ?? '', modelId: run.modelId ?? '' },
      timeoutMs: 120_000,
      signal
    })
    try {
      const raw = await session.promptStream(() => {})
      const parsed = JSON.parse(raw) as { hits?: unknown; misses?: unknown }
      const filterKeys = (value: unknown): string[] =>
        Array.isArray(value)
          ? value.filter((item): item is string => typeof item === 'string').slice(0, 30)
          : []
      result = { hits: filterKeys(parsed.hits), misses: filterKeys(parsed.misses) }
      return result
    } catch (error) {
      failure = error instanceof Error ? error.message : '规则命中分析失败'
      throw error
    } finally {
      sessionId = session.sessionId ?? ''
      session.dispose()
      this.recordValidationCall({
        run,
        operation: 'rule_hit_analysis',
        agentName: '参考规则验收',
        systemPrompt,
        result: JSON.stringify(result),
        failure,
        durationMs: Date.now() - startedAt,
        sessionId
      })
    }
  }

  /**
   * P7 整改反馈：基于验证输出与用户反馈，让 LLM 提出规则修改建议并直接生成
   * 模板新草稿版本（返回 diff 摘要）。整改修改的是规则而非正文（方案 §9）。
   */
  async suggestRuleRevisions(input: {
    runId: string
    feedback: string
    targetFindingKeys?: string[]
  }): Promise<{
    ruleSuggestions: Array<{
      findingKey: string
      currentRule: string
      suggestedRule: string
      reason: string
    }>
    newVersionId: string | null
  }> {
    const run = this.runStore.getRun(input.runId)
    if (!run) throw new Error('验证任务不存在')
    if (!run.baselineOutput || !run.templateOutput) throw new Error('验证尚未生成输出，无法整改')
    const version = this.templateStore.getVersion(run.templateVersionId)
    if (!version) throw new Error('模板版本不存在')
    const allRules = [
      ...version.spiritRules,
      ...version.techniqueRules,
      ...version.powerRules,
      ...version.pacingRules
    ]
    const targetFilter =
      input.targetFindingKeys && input.targetFindingKeys.length > 0
        ? new Set(input.targetFindingKeys)
        : null
    const candidates = allRules
      .filter((rule) => !targetFilter || targetFilter.has(rule.findingKey))
      .slice(0, 20)
    if (candidates.length === 0) return { ruleSuggestions: [], newVersionId: null }

    const systemPrompt = [
      '你是写作规则整改器。根据基准/模板输出的差异和用户反馈，修改规则文本使其更贴近反馈意图。',
      '只修改规则的表述，不要引入参考作品的情节、专名或原文。输出严格 JSON：',
      '{"suggestions":[{"findingKey":"...","suggestedRule":"...","reason":"..."}]}'
    ].join('\n')
    const startedAt = Date.now()
    let failure = ''
    let resultSummary = ''
    let sessionId = ''
    const session = await this.context.createSession({
      systemPrompt,
      userMessage: [
        `## 用户反馈\n${input.feedback.slice(0, 3000)}`,
        '## 待整改规则',
        candidates.map((rule) => `${rule.findingKey}: ${rule.rule}`).join('\n'),
        '## 基准输出（无规则）',
        run.baselineOutput.slice(0, 4000),
        '## 模板输出（注入规则）',
        run.templateOutput.slice(0, 4000)
      ].join('\n\n'),
      tools: [],
      responseFormat: 'json',
      modelId: { provider: run.providerId ?? '', modelId: run.modelId ?? '' },
      timeoutMs: 120_000
    })
    let suggestions: Array<{ findingKey: string; suggestedRule: string; reason: string }>
    try {
      const raw = await session.promptStream(() => {})
      const parsed = JSON.parse(raw) as { suggestions?: unknown }
      suggestions = Array.isArray(parsed.suggestions)
        ? parsed.suggestions
            .filter(
              (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object'
            )
            .map((item) => ({
              findingKey: typeof item.findingKey === 'string' ? item.findingKey : '',
              suggestedRule:
                typeof item.suggestedRule === 'string' ? item.suggestedRule.slice(0, 1000) : '',
              reason: typeof item.reason === 'string' ? item.reason.slice(0, 500) : ''
            }))
            .filter((item) => item.findingKey && item.suggestedRule)
            .slice(0, 20)
        : []
      resultSummary = `已生成 ${suggestions.length} 条规则整改建议。`
    } catch (error) {
      failure = error instanceof Error ? error.message : '规则整改失败'
      throw error
    } finally {
      sessionId = session.sessionId ?? ''
      session.dispose()
      this.recordValidationCall({
        run,
        operation: 'rule_revision',
        agentName: '参考规则整改',
        systemPrompt,
        result: resultSummary,
        failure,
        durationMs: Date.now() - startedAt,
        sessionId
      })
    }

    if (suggestions.length === 0) return { ruleSuggestions: [], newVersionId: null }

    // 生成新草稿版本（编辑对应 findingKey 的规则）
    const currentRuleByKey = new Map(allRules.map((rule) => [rule.findingKey, rule.rule]))
    const newVersion = this.templateStore.createVersionRevision({
      versionId: version.id,
      ruleOverrides: suggestions.map((suggestion) => ({
        findingKey: suggestion.findingKey,
        rule: suggestion.suggestedRule
      })),
      changeSummary: `P7 整改：${suggestions.length} 条规则依据反馈修改`
    })
    return {
      ruleSuggestions: suggestions.map((suggestion) => ({
        findingKey: suggestion.findingKey,
        currentRule: currentRuleByKey.get(suggestion.findingKey) ?? '',
        suggestedRule: suggestion.suggestedRule,
        reason: suggestion.reason
      })),
      newVersionId: newVersion.id
    }
  }

  private recordValidationCall(input: {
    run: ReferenceValidationRun
    operation: string
    agentName: string
    systemPrompt: string
    result: string
    failure: string
    durationMs: number
    sessionId: string
  }): void {
    let source: ReturnType<ReferenceAnalysisService['getSource']> | undefined
    try {
      const template = this.templateStore.getTemplate(
        this.templateStore.getVersion(input.run.templateVersionId)?.templateId ?? ''
      )
      const profile = template?.sourceProfileId
        ? this.profileStore.getProfile(template.sourceProfileId)
        : undefined
      const sourceId =
        typeof profile?.coverage.sourceId === 'string' ? profile.coverage.sourceId : undefined
      source = sourceId ? this.referenceService.getSource(sourceId) : undefined
    } catch (error) {
      this.context.logger.warn({ error, runId: input.run.id }, '参考验证日志无法关联参考源')
    }
    const projectId = source?.projectId
    const agentType = `reference-validation-${input.operation}`
    const status = input.failure ? 'error' : 'success'
    const taskInput = JSON.stringify({
      referenceValidationRunId: input.run.id,
      operation: input.operation
    })
    if (projectId) {
      try {
        this.novelStore?.insertAgentLog({
          projectId,
          chapterNumber: 0,
          agentType,
          agentName: input.agentName,
          displayAgentType: agentType,
          displayAgentName: input.agentName,
          phase: 'reference-validation',
          systemPrompt: input.systemPrompt,
          chapterContext: '',
          userMessage: '参考模板同场景验证调用。',
          taskInput,
          userInstructions: [],
          tools: [],
          toolNames: [],
          askStoryPolicy: 'allOffWithReferences',
          askStoryEnabled: false,
          result: input.result,
          resultLength: input.result.length,
          durationMs: input.durationMs,
          status,
          error: input.failure,
          sessionId: input.sessionId,
          operation: input.operation,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          llmProvider: input.run.providerId ?? '',
          llmModel: input.run.modelId ?? '',
          payloadMessagesChars: 0,
          payloadToolsChars: 0,
          payloadToolCount: 0,
          payloadTotalChars: 0,
          llmRoundTrips: 1,
          dataQuality: 'no_data'
        })
      } catch (error) {
        this.context.logger.warn({ error, runId: input.run.id }, '参考验证项目日志写入失败')
      }
    }
    try {
      this.context.agentCallLogger?.record({
        agentId: agentType,
        agentName: input.agentName,
        threadId: input.sessionId,
        systemPrompt: input.systemPrompt,
        userMessage: '参考模板同场景验证调用。',
        taskInput,
        tools: '[]',
        toolNames: '[]',
        result: input.result,
        resultLength: input.result.length,
        durationMs: input.durationMs,
        status,
        error: input.failure,
        metadata: JSON.stringify({
          projectId: projectId ?? null,
          referenceSourceId: source?.id ?? null,
          referenceValidationRunId: input.run.id,
          operation: input.operation,
          providerId: input.run.providerId,
          modelId: input.run.modelId
        })
      })
    } catch (error) {
      this.context.logger.warn({ error, runId: input.run.id }, '参考验证通用日志写入失败')
    }
  }
}

function compileRulesPrompt(version: ReferenceTemplateVersion): string {
  const groups: Array<[string, string]> = [
    [
      '文风精神',
      version.spiritRules
        .map((rule) => `- [${rule.findingKey}|${rule.strength}] ${rule.rule}`)
        .join('\n')
    ],
    [
      '文笔技法',
      version.techniqueRules
        .map((rule) => `- [${rule.findingKey}|${rule.strength}] ${rule.rule}`)
        .join('\n')
    ],
    [
      '笔力控制',
      version.powerRules
        .map((rule) => `- [${rule.findingKey}|${rule.strength}] ${rule.rule}`)
        .join('\n')
    ],
    [
      '推进节奏',
      version.pacingRules
        .map((rule) => `- [${rule.findingKey}|${rule.strength}] ${rule.rule}`)
        .join('\n')
    ]
  ]
  return groups
    .filter(([, body]) => body.length > 0)
    .map(([label, body]) => `### ${label}\n${body}`)
    .join('\n')
}

function countRules(version: ReferenceTemplateVersion): Record<string, number> {
  return {
    spirit: version.spiritRules.length,
    technique: version.techniqueRules.length,
    power: version.powerRules.length,
    pacing: version.pacingRules.length
  }
}
