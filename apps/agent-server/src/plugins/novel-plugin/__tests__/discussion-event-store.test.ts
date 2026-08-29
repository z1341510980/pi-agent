import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { novelMigrations } from '../novel-migrations.js'
import {
  DiscussionEventStore,
  foldDiscussionEvents,
  deriveResumeInfo,
  type DiscussionEvent,
  type DiscussionEventType,
} from '../core/discussion/discussion-event-store.js'

function createStore(): DiscussionEventStore {
  const db = new Database(':memory:')
  for (const migration of novelMigrations) db.exec(migration.sql)
  return new DiscussionEventStore(db)
}

describe('DiscussionEventStore', () => {
  it('append 单调递增 seq，run 之间互不干扰', () => {
    const store = createStore()
    const a1 = store.append('run-a', 'run_started', { projectId: 'p-1' })
    const a2 = store.append('run-a', 'plan_submitted', { source: 'tool', sceneCount: 2 })
    const b1 = store.append('run-b', 'run_started')

    expect(a1.seq).toBe(1)
    expect(a2.seq).toBe(2)
    expect(b1.seq).toBe(1)
    expect(store.lastSeq('run-a')).toBe(2)
    expect(store.lastSeq('run-b')).toBe(1)
    expect(store.lastSeq('run-missing')).toBe(0)
  })

  it('list 按 fromSeq 重放：SSE tail 只拿游标之后的增量', () => {
    const store = createStore()
    for (const type of ['run_started', 'plan_submitted', 'beat_started', 'beat_completed'] as const) {
      store.append('run-1', type)
    }

    const all = store.list('run-1')
    expect(all.map(event => event.type)).toEqual([
      'run_started', 'plan_submitted', 'beat_started', 'beat_completed',
    ])
    const tail = store.list('run-1', 3)
    expect(tail.map(event => event.type)).toEqual(['beat_started', 'beat_completed'])
    expect(tail.every(event => event.seq >= 3)).toBe(true)
    // payload 往返无损
    store.append('run-1', 'degraded', { kind: 'thin', beatId: 'a1' })
    const last = store.list('run-1').at(-1)
    expect(last?.payload).toEqual({ kind: 'thin', beatId: 'a1' })
  })

  it('fold：完整成功 run 还原出 completed 与节点账目', () => {
    const events: Array<[import('../core/discussion/discussion-event-store.js').DiscussionEventType, Record<string, unknown>?]> = [
      ['run_started', {}],
      ['plan_submitted', { source: 'tool', sceneCount: 1 }],
      ['beat_started', { sceneId: 1, beatId: 'a1' }],
      ['turn_submitted', { messageId: 'm1', reaction: false }],
      ['beat_completed', { sceneId: 1, beatId: 'a1', via: 'beat' }],
      ['beat_started', { sceneId: 1, beatId: 'a2' }],
      ['reaction_enqueued', { sceneId: 1, parentBeatId: 'a2', targetId: 'char-lin' }],
      ['turn_submitted', { messageId: 'm2', reaction: true }],
      ['beat_completed', { sceneId: 1, beatId: 'a2', via: 'reaction' }],
      ['scene_completed', { sceneId: 1, completed: 2, thin: 0, skipped: 0, unreached: 0 }],
      ['weave_started', { sceneCount: 1 }],
      ['weave_completed', { chars: 3000 }],
      ['review_completed', { decision: 'approve' }],
      ['run_finished', { status: 'completed' }],
    ]
    const folded = foldDiscussionEvents(
      events.map(([type, payload], index) => ({
        runId: 'run-1', seq: index + 1, type, payload: payload ?? {}, createdAt: 0,
      })),
    )

    expect(folded.status).toBe('completed')
    expect(folded.planSource).toBe('tool')
    expect(folded.sceneCount).toBe(1)
    expect(folded.beatsCompleted).toEqual(['a1', 'a2'])
    expect(folded.characterTurnCount).toBe(2)
    expect(folded.reactionTurnCount).toBe(1)
    expect(folded.contentAvailable).toBe(true)
    expect(folded.cursorSeq).toBe(events.length)
  })

  it('fold：检查点期间 awaiting_user，resolve 后回 running，终态定账', () => {
    const store = createStore()
    store.append('run-1', 'run_started')
    store.append('run-1', 'checkpoint_raised', { phase: 'chapter_weaving' })
    expect(foldDiscussionEvents(store.list('run-1')).status).toBe('awaiting_user')

    store.append('run-1', 'checkpoint_resolved', { phase: 'chapter_weaving', reply: 'approve' })
    expect(foldDiscussionEvents(store.list('run-1')).status).toBe('running')

    store.append('run-1', 'run_finished', { status: 'error', error: '用户中止' })
    const folded = foldDiscussionEvents(store.list('run-1'))
    expect(folded.status).toBe('error')
    expect(folded.lastError).toBe('用户中止')
    expect(folded.checkpointsRaised).toBe(1)
  })

  it('fold：降级事件分账 thin / unreached，空事件流为 idle', () => {
    const store = createStore()
    expect(foldDiscussionEvents(store.list('nope')).status).toBe('idle')

    store.append('run-1', 'run_started')
    store.append('run-1', 'plan_submitted', { source: 'markdown', sceneCount: 2 })
    store.append('run-1', 'degraded', { kind: 'thin', beatId: 'a1' })
    store.append('run-1', 'degraded', { kind: 'unreached', beatId: 'a2' })
    store.append('run-1', 'beat_skipped', { beatId: 'a3' })

    const folded = foldDiscussionEvents(store.list('run-1'))
    expect(folded.planSource).toBe('markdown')
    expect(folded.beatsThin).toEqual(['a1'])
    expect(folded.beatsUnreached).toEqual(['a2'])
    expect(folded.beatsSkipped).toEqual(['a3'])
    expect(folded.beatsCompleted).toEqual([])
    // 没有 run_finished：run 仍在进行（fold 不猜终态）
    expect(folded.status).toBe('running')
  })

  it('deriveResumeInfo：acting 中断定位到最后 beat_started，完成集按场景分账', () => {
    const store = createStore()
    store.append('run-1', 'run_started')
    store.append('run-1', 'plan_submitted', { source: 'tool', sceneCount: 2 })
    // 场景 1：a1 完成、a2 thin；场景 2：b1 完成、b2 中断
    for (const [type, payload] of [
      ['beat_started', { sceneId: 1, beatId: 'a1' }] as const,
      ['beat_completed', { sceneId: 1, beatId: 'a1' }] as const,
      ['beat_started', { sceneId: 1, beatId: 'a2' }] as const,
      ['degraded', { kind: 'thin', sceneId: 1, beatId: 'a2' }] as const,
      ['scene_completed', { sceneId: 1 }] as const,
      ['beat_started', { sceneId: 2, beatId: 'b1' }] as const,
      ['beat_completed', { sceneId: 2, beatId: 'b1' }] as const,
      ['beat_started', { sceneId: 2, beatId: 'b2' }] as const,
    ]) {
      store.append('run-1', type as DiscussionEventType, payload as Record<string, unknown>)
    }

    const info = deriveResumeInfo(store.list('run-1'))
    expect(info.phase).toBe('acting')
    expect(info.failedSceneId).toBe(2)
    expect(info.failedActionBeatId).toBe('b2')
    expect(info.completedByScene.get(1)).toEqual(['a1'])
    expect(info.completedByScene.get(2)).toEqual(['b1'])
  })

  it('deriveResumeInfo：weave/review 阶段定位，无场景计划时无 phase', () => {
    const store = createStore()
    store.append('run-1', 'run_started')
    store.append('run-1', 'plan_submitted', { source: 'none', sceneCount: 0 })
    expect(deriveResumeInfo(store.list('run-1')).phase).toBeUndefined()

    store.append('run-1', 'weave_started', {})
    store.append('run-1', 'weave_completed', { chars: 1200 })
    expect(deriveResumeInfo(store.list('run-1')).phase).toBe('chapter_weaving')

    store.append('run-1', 'checkpoint_raised', { phase: 'reviewing', type: 'review' })
    expect(deriveResumeInfo(store.list('run-1')).phase).toBe('reviewing')
  })
})
