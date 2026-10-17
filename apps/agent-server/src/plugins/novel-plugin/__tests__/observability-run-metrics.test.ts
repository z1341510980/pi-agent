import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { novelMigrations } from '../novel-migrations.js'
import { CreationRunMetricsStore } from '../core/runtime/creation-run-metrics-store.js'
import { ObservabilityService } from '../core/analysis/observability-service.js'

describe('ObservabilityService creation run dimensions', () => {
  it('reports revision, quality, recovery, latency, and token dimensions by project', () => {
    const db = new Database(':memory:')
    for (const migration of novelMigrations) db.exec(migration.sql)
    db.prepare("INSERT INTO novel_projects (id, title, genre) VALUES ('p-1', '测试', 'fantasy')").run()
    db.prepare(`
      INSERT INTO novel_creation_runs (
        run_id, project_id, chapter_number, mode, status, stage, revision,
        created_at, updated_at
      ) VALUES ('run-1', 'p-1', 3, 'workflow', 'completed', 'finalizing', 0, 1, 1)
    `).run()
    new CreationRunMetricsStore(db).upsert(
      { runId: 'run-1', projectId: 'p-1', chapterNumber: 3 },
      {
        wordTarget: 3000,
        wordActual: 2800,
        revisionRounds: 2,
        revisionPatches: 4,
        qualityGateFailures: 1,
        recoveryResult: 'completed',
        terminalLatencyMs: 900,
        inputTokens: 1200,
        outputTokens: 500,
        cacheReadTokens: 250,
      },
    )

    expect(new ObservabilityService(db).runMetrics('p-1')).toMatchObject([{
      runId: 'run-1',
      chapterNumber: 3,
      wordDeviation: -200,
      revisionRounds: 2,
      qualityGateFailures: 1,
      recoveryResult: 'completed',
      terminalLatencyMs: 900,
      inputTokens: 1200,
      cacheReadTokens: 250,
    }])
    db.close()
  })
})
