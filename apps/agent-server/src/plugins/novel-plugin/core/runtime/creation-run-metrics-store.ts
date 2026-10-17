import type Database from 'better-sqlite3'

export interface CreationRunMetricsInput {
  wordTarget?: number | null
  wordActual?: number | null
  revisionRounds?: number
  revisionPatches?: number
  qualityGateFailures?: number
  recoveryResult?: string | null
  terminalLatencyMs?: number | null
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface CreationRunMetrics extends CreationRunMetricsInput {
  runId: string
  projectId: string
  chapterNumber: number
  wordDeviation: number | null
  recordedAt: number
}

interface CreationRunMetricsRow {
  run_id: string
  project_id: string
  chapter_number: number
  word_target: number | null
  word_actual: number | null
  word_deviation: number | null
  revision_rounds: number
  revision_patches: number
  quality_gate_failures: number
  recovery_result: string | null
  terminal_latency_ms: number | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  recorded_at: number
}

/** Durable, reportable dimensions for one creation run. */
export class CreationRunMetricsStore {
  private readonly stmtUpsert: Database.Statement
  private readonly stmtGet: Database.Statement

  constructor(private readonly db: Database.Database) {
    this.stmtUpsert = db.prepare(`
      INSERT INTO novel_creation_run_metrics (
        run_id, project_id, chapter_number, word_target, word_actual, word_deviation,
        revision_rounds, revision_patches, quality_gate_failures, recovery_result,
        terminal_latency_ms, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, recorded_at
      ) VALUES (
        @run_id, @project_id, @chapter_number, @word_target, @word_actual, @word_deviation,
        @revision_rounds, @revision_patches, @quality_gate_failures, @recovery_result,
        @terminal_latency_ms, @input_tokens, @output_tokens, @cache_read_tokens,
        @cache_write_tokens, @recorded_at
      )
      ON CONFLICT(run_id) DO UPDATE SET
        word_target = excluded.word_target,
        word_actual = excluded.word_actual,
        word_deviation = excluded.word_deviation,
        revision_rounds = excluded.revision_rounds,
        revision_patches = excluded.revision_patches,
        quality_gate_failures = excluded.quality_gate_failures,
        recovery_result = excluded.recovery_result,
        terminal_latency_ms = excluded.terminal_latency_ms,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        recorded_at = excluded.recorded_at
    `)
    this.stmtGet = db.prepare(`
      SELECT run_id, project_id, chapter_number, word_target, word_actual, word_deviation,
             revision_rounds, revision_patches, quality_gate_failures, recovery_result,
             terminal_latency_ms, input_tokens, output_tokens, cache_read_tokens,
             cache_write_tokens, recorded_at
        FROM novel_creation_run_metrics
       WHERE run_id = ?
    `)
  }

  upsert(
    run: { runId: string; projectId: string; chapterNumber: number },
    input: CreationRunMetricsInput,
    recordedAt: number = Date.now(),
  ): CreationRunMetrics {
    const wordTarget = input.wordTarget ?? null
    const wordActual = input.wordActual ?? null
    const full: CreationRunMetrics = {
      runId: run.runId,
      projectId: run.projectId,
      chapterNumber: run.chapterNumber,
      wordTarget,
      wordActual,
      wordDeviation: wordTarget != null && wordActual != null ? wordActual - wordTarget : null,
      revisionRounds: input.revisionRounds ?? 0,
      revisionPatches: input.revisionPatches ?? 0,
      qualityGateFailures: input.qualityGateFailures ?? 0,
      recoveryResult: input.recoveryResult ?? null,
      terminalLatencyMs: input.terminalLatencyMs ?? null,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      cacheReadTokens: input.cacheReadTokens ?? 0,
      cacheWriteTokens: input.cacheWriteTokens ?? 0,
      recordedAt,
    }
    this.stmtUpsert.run({
      run_id: full.runId,
      project_id: full.projectId,
      chapter_number: full.chapterNumber,
      word_target: full.wordTarget,
      word_actual: full.wordActual,
      word_deviation: full.wordDeviation,
      revision_rounds: full.revisionRounds,
      revision_patches: full.revisionPatches,
      quality_gate_failures: full.qualityGateFailures,
      recovery_result: full.recoveryResult,
      terminal_latency_ms: full.terminalLatencyMs,
      input_tokens: full.inputTokens,
      output_tokens: full.outputTokens,
      cache_read_tokens: full.cacheReadTokens,
      cache_write_tokens: full.cacheWriteTokens,
      recorded_at: full.recordedAt,
    })
    return full
  }

  get(runId: string): CreationRunMetrics | undefined {
    const row = this.stmtGet.get(runId) as CreationRunMetricsRow | undefined
    if (!row) return undefined
    return {
      runId: row.run_id,
      projectId: row.project_id,
      chapterNumber: row.chapter_number,
      wordTarget: row.word_target,
      wordActual: row.word_actual,
      wordDeviation: row.word_deviation,
      revisionRounds: row.revision_rounds,
      revisionPatches: row.revision_patches,
      qualityGateFailures: row.quality_gate_failures,
      recoveryResult: row.recovery_result,
      terminalLatencyMs: row.terminal_latency_ms,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      recordedAt: row.recorded_at,
    }
  }
}
