import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { novelMigrations } from '../novel-migrations.js'
import { WorkflowEventStore } from '../core/workflow-event-store.js'

function createStore(): WorkflowEventStore {
  const db = new Database(':memory:')
  for (const migration of novelMigrations) db.exec(migration.sql)
  return new WorkflowEventStore(db)
}

/**
 * 章节工作流事件流（T8：create-flow 脱离 HTTP 生命周期）。
 *
 * 这组用例钉住的是"断线不等于中断"所依赖的那几个事实：
 * 事件按 run 隔离且 seq 单调（前端游标续传的基础）、活跃 run 可被面板重开找回、
 * 崩溃残留的孤儿流必须补终态（否则前端 tail 永远轮询）。
 */
describe('WorkflowEventStore', () => {
  it('append 单调递增 seq，run 之间互不干扰', () => {
    const store = createStore()
    const a1 = store.append('run-a', 'run_started', { projectId: 'p-1', chapterNumber: 1 })
    const a2 = store.append('run-a', 'agui', { type: 'TEXT_MESSAGE_CONTENT', delta: '正文' })
    const b1 = store.append('run-b', 'run_started', { projectId: 'p-1', chapterNumber: 2 })

    expect([a1.seq, a2.seq, b1.seq]).toEqual([1, 2, 1])
    expect(store.lastSeq('run-a')).toBe(2)
    expect(store.lastSeq('run-b')).toBe(1)
    expect(store.lastSeq('run-missing')).toBe(0)
  })

  it('list(fromSeq) 支持断线重连只补增量', () => {
    const store = createStore()
    store.append('run-1', 'run_started', {})
    store.append('run-1', 'agui', { n: 1 })
    store.append('run-1', 'agui', { n: 2 })
    store.append('run-1', 'run_finished', { status: 'completed' })

    expect(store.list('run-1').map(e => e.seq)).toEqual([1, 2, 3, 4])
    // 客户端上次游标 2 → 只补 3、4
    expect(store.list('run-1', 3).map(e => e.type)).toEqual(['agui', 'run_finished'])
    expect(store.list('run-1', 3)[0]?.payload).toEqual({ n: 2 })
  })

  it('findActiveRun 只认"有 run_started、无 run_finished"的 run', () => {
    const store = createStore()
    store.append('run-done', 'run_started', { projectId: 'p-1', chapterNumber: 3 })
    store.append('run-done', 'run_finished', { status: 'completed' })
    store.append('run-running', 'run_started', { projectId: 'p-1', chapterNumber: 3 })
    store.append('run-running', 'agui', { n: 1 })
    store.append('run-other-chapter', 'run_started', { projectId: 'p-1', chapterNumber: 4 })

    expect(store.findActiveRun('p-1', 3)).toEqual({ runId: 'run-running', cursorSeq: 2 })
    expect(store.findActiveRun('p-1', 4)).toEqual({ runId: 'run-other-chapter', cursorSeq: 1 })
    expect(store.findActiveRun('p-1', 9)).toBeUndefined()
  })

  it('reconcileOrphanRuns 给崩溃残留的事件流补终态，已收口的 run 不动', () => {
    const store = createStore()
    store.append('orphan-1', 'run_started', { projectId: 'p-1', chapterNumber: 1 })
    store.append('orphan-1', 'agui', { n: 1 })
    store.append('orphan-2', 'run_started', { projectId: 'p-1', chapterNumber: 2 })
    store.append('orphan-2', 'run_finished', { status: 'completed' })

    expect(store.reconcileOrphanRuns('服务重启导致创作流程中断；可从断点继续')).toBe(1)

    const orphan = store.list('orphan-1')
    expect(orphan.at(-1)?.type).toBe('run_finished')
    expect(orphan.at(-1)?.payload).toMatchObject({ status: 'error', interrupted: true })
    // 已收口的 run 不再追加事件（否则前端会收到第二条终态）
    expect(store.list('orphan-2')).toHaveLength(2)
    // 幂等：再跑一次不会重复补
    expect(store.reconcileOrphanRuns('again')).toBe(0)
  })
})
