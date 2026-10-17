import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { novelMigrations } from '../novel-migrations.js'
import { CreationRunStore } from '../core/runtime/creation-run-store.js'
import { CreationRunLifecycle } from '../core/runtime/creation-run-lifecycle.js'
import { CreationRunMetricsStore } from '../core/runtime/creation-run-metrics-store.js'

function createLifecycle(): { db: Database.Database; lifecycle: CreationRunLifecycle } {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const migration of novelMigrations) db.exec(migration.sql)
  db.prepare("INSERT INTO novel_projects (id, title, genre) VALUES ('p-1', '测试', 'fantasy')").run()
  const metrics = new CreationRunMetricsStore(db)
  return {
    db,
    lifecycle: new CreationRunLifecycle(new CreationRunStore(db), metrics),
  }
}

describe('CreationRunMetricsStore', () => {
  it('persists word, revision, recovery, quality, cost, and terminal latency dimensions per run', () => {
    const { db, lifecycle } = createLifecycle()
    lifecycle.start({ runId: 'run-1', projectId: 'p-1', chapterNumber: 3, mode: 'workflow' }, 100)
    lifecycle.finish('run-1', {
      status: 'completed',
      metrics: {
        wordTarget: 3000,
        wordActual: 2750,
        revisionRounds: 2,
        revisionPatches: 3,
        qualityGateFailures: 1,
        recoveryResult: 'fresh',
        terminalLatencyMs: 4200,
        inputTokens: 1100,
        outputTokens: 500,
        cacheReadTokens: 200,
      },
    }, 4300)

    expect(new CreationRunMetricsStore(db).get('run-1')).toMatchObject({
      runId: 'run-1',
      projectId: 'p-1',
      chapterNumber: 3,
      wordTarget: 3000,
      wordActual: 2750,
      wordDeviation: -250,
      revisionRounds: 2,
      revisionPatches: 3,
      qualityGateFailures: 1,
      recoveryResult: 'fresh',
      terminalLatencyMs: 4200,
      inputTokens: 1100,
      outputTokens: 500,
      cacheReadTokens: 200,
    })
    db.close()
  })

  it('upserts terminal metrics when a cancelled run has no word output', () => {
    const { db, lifecycle } = createLifecycle()
    lifecycle.start({ runId: 'run-2', projectId: 'p-1', chapterNumber: 4, mode: 'discussion' }, 100)
    lifecycle.finish('run-2', {
      status: 'cancelled',
      error: '用户取消',
      metrics: { recoveryResult: 'cancelled', terminalLatencyMs: 50 },
    }, 150)

    expect(new CreationRunMetricsStore(db).get('run-2')).toMatchObject({
      recoveryResult: 'cancelled',
      terminalLatencyMs: 50,
      wordTarget: null,
      wordActual: null,
      wordDeviation: null,
    })
    db.close()
  })
})
