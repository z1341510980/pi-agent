/**
 * ReferenceValidationRunStore：P7 同场景验证 run（方案 §9）。
 *
 * - 创建时冻结场景版本与 facts hash；regenerate 必须复用同一 facts hash；
 * - 两路输出（基准/模板）与规则命中、usage、费用、安全结果落库；
 * - 事件走 novel_reference_run_events（run_kind='validation'），支持 SSE 重放；
 * - decision=accepted 后版本 publishable=true（由路由校验后调用 publishVersion）。
 */
import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'

export type ValidationScenarioSource = 'system_original' | 'user_input' | 'project_facts'
export type ValidationRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface ReferenceValidationRun {
  id: string
  templateVersionId: string
  scenarioSource: ValidationScenarioSource
  scenarioType: string | null
  /** 固定输入（§9：验收记录必须保存固定输入）；regenerate 复用原值而非重新输入。 */
  scenarioFacts: string
  fixedScenarioVersion: string
  fixedFactsHash: string
  baselineConfig: Record<string, unknown>
  templateConfig: Record<string, unknown>
  baselineOutput: string | null
  templateOutput: string | null
  ruleHits: Record<string, unknown>
  feedback: string | null
  decision: 'accepted' | 'rejected' | null
  decisionNote: string | null
  decisionHash: string | null
  status: ValidationRunStatus
  providerId: string | null
  modelId: string | null
  estimate: Record<string, unknown>
  usage: Record<string, unknown>
  cost: Record<string, unknown>
  safetyReport: Record<string, unknown>
  error: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

interface RunRow {
  id: string; template_version_id: string; scenario_source: string; scenario_type: string | null
  scenario_facts: string; fixed_scenario_version: string; fixed_facts_hash: string; baseline_config: string; template_config: string
  baseline_output: string | null; template_output: string | null; rule_hits: string; feedback: string | null
  decision: string | null; decision_note: string | null; decision_hash: string | null; status: string
  provider_id: string | null; model_id: string | null; estimate: string; usage: string; cost: string
  safety_report: string; error: string | null; created_at: number; updated_at: number; completed_at: number | null
}

export class ReferenceValidationRunStore {
  constructor(private readonly db: Database.Database) {}

  createRun(input: {
    templateVersionId: string
    scenarioSource: ValidationScenarioSource
    scenarioType?: string
    scenarioFacts: string
    providerId: string
    modelId: string
    estimate?: Record<string, unknown>
    reuseFromRunId?: string
  }): ReferenceValidationRun {
    const reuse = input.reuseFromRunId ? this.getRun(input.reuseFromRunId) : undefined
    const now = Date.now()
    const id = randomUUID()
    // 场景与 facts hash 冻结：regenerate 复用原值，否则用本次输入计算。
    // scenarioFacts 也持久化（§9 固定输入），执行器在 regenerate 时拿同一文本生成。
    const fixedScenarioVersion = reuse?.fixedScenarioVersion ?? `scenario-${now}-${randomUUID().slice(0, 8)}`
    const fixedFactsHash = reuse?.fixedFactsHash ?? createHash('sha256').update(input.scenarioFacts).digest('hex')
    const scenarioFacts = reuse?.scenarioFacts ?? input.scenarioFacts
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO novel_reference_validation_runs
          (id, template_version_id, scenario_source, scenario_type, scenario_facts, fixed_scenario_version, fixed_facts_hash,
           baseline_config, template_config, status, provider_id, model_id, estimate, usage, cost, safety_report, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, '{}', '{}', 'queued', ?, ?, ?, '{}', '{}', '{}', ?, ?)
      `).run(id, input.templateVersionId, input.scenarioSource, input.scenarioType ?? null, scenarioFacts, fixedScenarioVersion, fixedFactsHash,
        input.providerId, input.modelId, JSON.stringify(input.estimate ?? {}), now, now)
      this.appendEvent(id, 'validation_queued', `验证任务已排队（${input.scenarioSource}）`, { reuseFromRunId: input.reuseFromRunId ?? null }, now)
    })()
    return this.getRun(id)!
  }

  getRun(id: string): ReferenceValidationRun | undefined {
    const row = this.db.prepare('SELECT * FROM novel_reference_validation_runs WHERE id = ?').get(id) as RunRow | undefined
    return row ? toRun(row) : undefined
  }

  saveGenerationConfig(id: string, baselineConfig: Record<string, unknown>, templateConfig: Record<string, unknown>): void {
    this.db.prepare('UPDATE novel_reference_validation_runs SET baseline_config = ?, template_config = ?, status = \'running\', updated_at = ? WHERE id = ?')
      .run(JSON.stringify(baselineConfig), JSON.stringify(templateConfig), Date.now(), id)
    this.appendEvent(id, 'generation_started', '双路生成开始（同模型同参数）', {}, Date.now())
  }

  saveOutputs(id: string, outputs: { baselineOutput: string; templateOutput: string; usage: Record<string, unknown>; cost: Record<string, unknown> }): void {
    const now = Date.now()
    this.db.transaction(() => {
      this.db.prepare('UPDATE novel_reference_validation_runs SET baseline_output = ?, template_output = ?, usage = ?, cost = ?, updated_at = ? WHERE id = ?')
        .run(outputs.baselineOutput.slice(0, 100_000), outputs.templateOutput.slice(0, 100_000), JSON.stringify(outputs.usage), JSON.stringify(outputs.cost), now, id)
      this.appendEvent(id, 'outputs_ready', '两路输出已生成', { usage: outputs.usage }, now)
    })()
  }

  completeRun(id: string, result: { ruleHits: Record<string, unknown>; safetyReport: Record<string, unknown> }): void {
    const now = Date.now()
    this.db.transaction(() => {
      this.db.prepare('UPDATE novel_reference_validation_runs SET rule_hits = ?, safety_report = ?, status = \'completed\', completed_at = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(result.ruleHits), JSON.stringify(result.safetyReport), now, now, id)
      this.appendEvent(id, 'validation_completed', '验证完成', {}, now)
    })()
  }

  failRun(id: string, error: string): void {
    const now = Date.now()
    this.db.transaction(() => {
      this.db.prepare('UPDATE novel_reference_validation_runs SET status = \'failed\', error = ?, updated_at = ? WHERE id = ?').run(error.slice(0, 2000), now, id)
      this.appendEvent(id, 'validation_failed', '验证失败', { error: error.slice(0, 300) }, now)
    })()
  }

  saveFeedback(id: string, feedback: string): void {
    this.db.prepare('UPDATE novel_reference_validation_runs SET feedback = ?, updated_at = ? WHERE id = ?').run(feedback.slice(0, 5000), Date.now(), id)
    this.appendEvent(id, 'feedback_saved', '整改反馈已保存', {}, Date.now())
  }

  decide(id: string, decision: 'accepted' | 'rejected', note: string): ReferenceValidationRun {
    const now = Date.now()
    const run = this.getRun(id)!
    const decisionHash = createHash('sha256').update(JSON.stringify({ id, decision, note, templateOutputHash: hashShort(run.templateOutput ?? '') })).digest('hex')
    this.db.prepare('UPDATE novel_reference_validation_runs SET decision = ?, decision_note = ?, decision_hash = ?, updated_at = ? WHERE id = ?')
      .run(decision, note.slice(0, 1000), decisionHash, now, id)
    this.appendEvent(id, decision === 'accepted' ? 'validation_accepted' : 'validation_rejected', `最终决定：${decision}`, {}, now)
    return this.getRun(id)!
  }

  listEvents(runId: string, afterSequence = 0): Array<{ id: string; sequence: number; type: string; stage: string | null; summary: string; payload: Record<string, unknown>; createdAt: number }> {
    const rows = this.db.prepare('SELECT * FROM novel_reference_run_events WHERE run_id = ? AND run_kind = \'validation\' AND sequence_no > ? ORDER BY sequence_no ASC').all(runId, afterSequence) as Array<{ id: string; sequence_no: number; event_type: string; stage: string | null; summary: string; payload: string; created_at: number }>
    return rows.map((row) => ({ id: row.id, sequence: row.sequence_no, type: row.event_type, stage: row.stage, summary: row.summary, payload: parseObject(row.payload), createdAt: row.created_at }))
  }

  private appendEvent(runId: string, type: string, summary: string, payload: Record<string, unknown>, createdAt: number): void {
    const row = this.db.prepare('SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next FROM novel_reference_run_events WHERE run_id = ?').get(runId) as { next: number }
    this.db.prepare('INSERT INTO novel_reference_run_events (id, run_id, run_kind, sequence_no, event_type, stage, summary, payload, created_at) VALUES (?, ?, \'validation\', ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), runId, row.next, type, 'validation', summary, JSON.stringify(payload), createdAt)
  }
}

function hashShort(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function toRun(row: RunRow): ReferenceValidationRun {
  const parseObj = (value: string): Record<string, unknown> => parseObject(value)
  return {
    id: row.id, templateVersionId: row.template_version_id, scenarioSource: row.scenario_source as ValidationScenarioSource,
    scenarioType: row.scenario_type, scenarioFacts: row.scenario_facts, fixedScenarioVersion: row.fixed_scenario_version, fixedFactsHash: row.fixed_facts_hash,
    baselineConfig: parseObj(row.baseline_config), templateConfig: parseObj(row.template_config),
    baselineOutput: row.baseline_output, templateOutput: row.template_output, ruleHits: parseObj(row.rule_hits),
    feedback: row.feedback, decision: row.decision as 'accepted' | 'rejected' | null, decisionNote: row.decision_note,
    decisionHash: row.decision_hash, status: row.status as ValidationRunStatus, providerId: row.provider_id, modelId: row.model_id,
    estimate: parseObj(row.estimate), usage: parseObj(row.usage), cost: parseObj(row.cost), safetyReport: parseObj(row.safety_report),
    error: row.error, createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at,
  }
}
