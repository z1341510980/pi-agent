import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { novelMigrations } from '../novel-migrations.js'
import { CreationRunStore } from '../core/runtime/creation-run-store.js'
import { CreationRunLifecycle } from '../core/runtime/creation-run-lifecycle.js'

function createLifecycle(): { db: Database.Database; lifecycle: CreationRunLifecycle } {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const migration of novelMigrations) db.exec(migration.sql)
  db.prepare("INSERT INTO novel_projects (id, title, genre) VALUES ('p-1', '测试', 'fantasy')").run()
  return { db, lifecycle: new CreationRunLifecycle(new CreationRunStore(db)) }
}

describe('CreationRunLifecycle', () => {
  it('projects workflow phases and checkpoint decisions into durable run state', () => {
    const { db, lifecycle } = createLifecycle()
    lifecycle.start({ runId: 'run-1', projectId: 'p-1', chapterNumber: 3, mode: 'workflow' }, 100)
    lifecycle.observePhase('run-1', 'writing', 110)
    lifecycle.observePhase('run-1', 'reviewing', 120)
    lifecycle.awaitCheckpoint('run-1', 'cp-1', 130)
    lifecycle.resolveCheckpoint('run-1', 'cp-1', 'revise', { reason: '质量门未通过' }, 140)

    expect(lifecycle.get('run-1')).toMatchObject({
      status: 'revising',
      stage: 'revising',
      revision: 1,
      checkpointId: undefined,
    })
    expect(lifecycle.events('run-1').map(event => event.type)).toEqual([
      'submitted', 'start', 'advance', 'advance', 'await_input', 'begin_revision',
    ])
    db.close()
  })

  it('completes through finalizing and makes cancellation terminal', () => {
    const { db, lifecycle } = createLifecycle()
    lifecycle.start({ runId: 'run-1', projectId: 'p-1', chapterNumber: 3, mode: 'arrange' }, 100)
    lifecycle.finish('run-1', { status: 'completed' }, 200)
    expect(lifecycle.get('run-1')).toMatchObject({ status: 'completed', stage: 'finalizing' })

    lifecycle.start({ runId: 'run-2', projectId: 'p-1', chapterNumber: 4, mode: 'workflow' }, 300)
    const cancelled = lifecycle.finish('run-2', { status: 'cancelled', error: 'stop' }, 400)
    expect(lifecycle.get('run-2')).toMatchObject({ status: 'cancelled', error: 'stop' })
    expect(lifecycle.finish('run-2', { status: 'cancelled', error: 'stop' }, 500)).toEqual(cancelled)
    db.close()
  })

  it('rejects stale checkpoint decisions', () => {
    const { db, lifecycle } = createLifecycle()
    lifecycle.start({ runId: 'run-1', projectId: 'p-1', chapterNumber: 3, mode: 'workflow' }, 100)
    lifecycle.awaitCheckpoint('run-1', 'cp-current', 110)

    expect(() => lifecycle.resolveCheckpoint('run-1', 'cp-old', 'approve')).toThrow(/checkpoint/i)
    expect(lifecycle.get('run-1')?.status).toBe('waiting_input')
    db.close()
  })

  it('supports replanning and writer pushback without treating force-continue as a revision', () => {
    const { db, lifecycle } = createLifecycle()
    lifecycle.start({ runId: 'run-1', projectId: 'p-1', chapterNumber: 3, mode: 'workflow' }, 100)
    lifecycle.awaitCheckpoint('run-1', 'cp-plan', 110)
    lifecycle.resolveCheckpoint('run-1', 'cp-plan', 'revise', { reason: '调整叙事任务' }, 120)
    lifecycle.observePhase('run-1', 'directing', 130)
    expect(lifecycle.get('run-1')).toMatchObject({ status: 'running', stage: 'planning', revision: 1 })

    lifecycle.observePhase('run-1', 'writing', 140)
    lifecycle.awaitCheckpoint('run-1', 'cp-pushback', 150)
    lifecycle.resolveCheckpoint(
      'run-1',
      'cp-pushback',
      'rewrite',
      { resumeStage: 'writing', resumeWithoutRevision: true },
      160,
    )
    expect(lifecycle.get('run-1')).toMatchObject({ status: 'running', stage: 'writing', revision: 1 })
    expect(lifecycle.events('run-1').at(-1)?.payload).toMatchObject({
      command: { type: 'resume', decision: 'rewrite', stage: 'writing' },
    })
    db.close()
  })

  it('marks unfinished durable runs failed after process restart', () => {
    const { db, lifecycle } = createLifecycle()
    lifecycle.start({ runId: 'run-1', projectId: 'p-1', chapterNumber: 3, mode: 'workflow' }, 100)

    expect(lifecycle.reconcileInterruptedRuns('服务重启')).toBe(1)
    expect(lifecycle.get('run-1')).toMatchObject({ status: 'failed', error: '服务重启' })
    expect(lifecycle.start({ runId: 'run-2', projectId: 'p-1', chapterNumber: 3, mode: 'workflow' }, 200).runId)
      .toBe('run-2')
    db.close()
  })
})
