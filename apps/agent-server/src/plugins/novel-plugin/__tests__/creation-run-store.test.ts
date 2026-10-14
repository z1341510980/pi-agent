import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { novelMigrations } from '../novel-migrations.js'
import { CreationRunStore } from '../core/runtime/creation-run-store.js'

function createStore(): { db: Database.Database; store: CreationRunStore } {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const migration of novelMigrations) db.exec(migration.sql)
  db.prepare("INSERT INTO novel_projects (id, title, genre) VALUES ('p-1', '测试', 'fantasy')").run()
  return { db, store: new CreationRunStore(db) }
}

const input = {
  runId: 'run-1',
  projectId: 'p-1',
  chapterNumber: 3,
  mode: 'workflow' as const,
  createdAt: 1_700_000_000_000,
}

describe('CreationRunStore', () => {
  it('persists state and ordered events across store instances', () => {
    const { db, store } = createStore()
    store.create(input)
    store.dispatch('run-1', { type: 'start', stage: 'planning' }, 1_700_000_000_100)
    store.dispatch('run-1', { type: 'await_input', checkpointId: 'cp-1' }, 1_700_000_000_200)

    const reopened = new CreationRunStore(db)
    expect(reopened.get('run-1')).toMatchObject({
      status: 'waiting_input',
      checkpointId: 'cp-1',
      updatedAt: 1_700_000_000_200,
    })
    expect(reopened.events('run-1').map(event => [event.seq, event.type])).toEqual([
      [1, 'submitted'],
      [2, 'start'],
      [3, 'await_input'],
    ])
    db.close()
  })

  it('enforces one active run per project and chapter across modes', () => {
    const { db, store } = createStore()
    store.create(input)
    expect(() => store.create({ ...input, runId: 'run-2', mode: 'discussion' })).toThrow(/active run/i)

    store.dispatch('run-1', { type: 'cancel' })
    expect(store.create({ ...input, runId: 'run-2', mode: 'discussion' }).runId).toBe('run-2')
    db.close()
  })

  it('rejects illegal transitions without changing state or appending events', () => {
    const { db, store } = createStore()
    store.create(input)
    expect(() => store.dispatch('run-1', { type: 'complete' })).toThrow(/invalid/i)
    expect(store.get('run-1')?.status).toBe('submitted')
    expect(store.events('run-1')).toHaveLength(1)
    db.close()
  })

  it('rolls back state when event insertion fails', () => {
    const { db, store } = createStore()
    store.create(input)
    db.exec(`CREATE TRIGGER reject_creation_run_event
      BEFORE INSERT ON novel_creation_run_events
      WHEN NEW.type = 'start'
      BEGIN SELECT RAISE(ABORT, 'event unavailable'); END`)

    expect(() => store.dispatch('run-1', { type: 'start', stage: 'planning' })).toThrow('event unavailable')
    expect(store.get('run-1')?.status).toBe('submitted')
    expect(store.events('run-1')).toHaveLength(1)
    db.close()
  })
})
