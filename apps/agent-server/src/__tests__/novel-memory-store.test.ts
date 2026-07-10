import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { NovelMemoryStore } from '../plugins/novel-plugin/core/novel-memory-store.js'
import { novelMigrations } from '../plugins/novel-plugin/novel-migrations.js'

let db: Database.Database
let store: NovelMemoryStore

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const m of novelMigrations) {
    db.exec(m.sql)
  }
  store = new NovelMemoryStore(db)
})

afterEach(() => {
  db.close()
  vi.useRealTimers()
})

describe('NovelMemoryStore - 事件记录', () => {
  it('recordEvent 记录事件并返回完整对象', () => {
    const event = store.recordEvent({
      projectId: 'p-1',
      chapterId: 'ch-1',
      chapterNumber: 1,
      eventType: 'character_change',
      entityId: 'c-1',
      entityType: 'character',
      description: '角色状态变更',
      oldValue: '{"state":"happy"}',
      newValue: '{"state":"sad"}',
      cause: null,
      effectIds: [],
      significance: 7,
    })
    expect(event.id).toBeTruthy()
    expect(event.projectId).toBe('p-1')
    expect(event.description).toBe('角色状态变更')
    expect(event.significance).toBe(7)
    expect(event.createdAt).toBeGreaterThan(0)
  })

  it('listEvents 返回项目所有事件（按章节顺序）', () => {
    store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 2,
      eventType: 'plot_event', entityId: 'e-2', entityType: 'chapter',
      description: '事件2', oldValue: null, newValue: null,
      cause: null, effectIds: [], significance: 5,
    })
    store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 1,
      eventType: 'plot_event', entityId: 'e-1', entityType: 'chapter',
      description: '事件1', oldValue: null, newValue: null,
      cause: null, effectIds: [], significance: 5,
    })
    const events = store.listEvents('p-1')
    expect(events).toHaveLength(2)
    // 按章节升序
    expect(events[0].chapterNumber).toBe(1)
    expect(events[1].chapterNumber).toBe(2)
  })

  it('listEvents 按 chapterNumber 过滤', () => {
    store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 1,
      eventType: 'plot_event', entityId: 'e-1', entityType: 'chapter',
      description: 'A', oldValue: null, newValue: null,
      cause: null, effectIds: [], significance: 5,
    })
    store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 2,
      eventType: 'plot_event', entityId: 'e-2', entityType: 'chapter',
      description: 'B', oldValue: null, newValue: null,
      cause: null, effectIds: [], significance: 5,
    })
    const events = store.listEvents('p-1', { chapterNumber: 2 })
    expect(events).toHaveLength(1)
    expect(events[0].description).toBe('B')
  })

  it('listEvents 按 entityType 过滤', () => {
    store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 1,
      eventType: 'character_change', entityId: 'c-1', entityType: 'character',
      description: '角色事件', oldValue: null, newValue: null,
      cause: null, effectIds: [], significance: 5,
    })
    store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 1,
      eventType: 'conflict_change', entityId: 'cf-1', entityType: 'conflict',
      description: '冲突事件', oldValue: null, newValue: null,
      cause: null, effectIds: [], significance: 5,
    })
    const events = store.listEvents('p-1', { entityType: 'conflict' })
    expect(events).toHaveLength(1)
    expect(events[0].entityType).toBe('conflict')
  })

  it('listEvents 按 minSignificance 过滤', () => {
    store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 1,
      eventType: 'plot_event', entityId: 'e-1', entityType: 'chapter',
      description: '低重要性', oldValue: null, newValue: null,
      cause: null, effectIds: [], significance: 3,
    })
    store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 1,
      eventType: 'plot_event', entityId: 'e-2', entityType: 'chapter',
      description: '高重要性', oldValue: null, newValue: null,
      cause: null, effectIds: [], significance: 8,
    })
    const events = store.listEvents('p-1', { minSignificance: 7 })
    expect(events).toHaveLength(1)
    expect(events[0].description).toBe('高重要性')
  })

  it('listEvents 默认 limit 为 100', () => {
    for (let i = 0; i < 105; i++) {
      store.recordEvent({
        projectId: 'p-1', chapterId: null, chapterNumber: 1,
        eventType: 'plot_event', entityId: `e-${i}`, entityType: 'chapter',
        description: `事件${i}`, oldValue: null, newValue: null,
        cause: null, effectIds: [], significance: 5,
      })
    }
    expect(store.listEvents('p-1')).toHaveLength(100)
    expect(store.listEvents('p-1', { limit: 200 })).toHaveLength(105)
  })

  it('listEvents 不属于此项目的事件不返回', () => {
    store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 1,
      eventType: 'plot_event', entityId: 'e-1', entityType: 'chapter',
      description: 'A', oldValue: null, newValue: null,
      cause: null, effectIds: [], significance: 5,
    })
    store.recordEvent({
      projectId: 'p-2', chapterId: null, chapterNumber: 1,
      eventType: 'plot_event', entityId: 'e-2', entityType: 'chapter',
      description: 'B', oldValue: null, newValue: null,
      cause: null, effectIds: [], significance: 5,
    })
    expect(store.listEvents('p-1')).toHaveLength(1)
  })
})

describe('NovelMemoryStore - 实体时间线', () => {
  it('getEntityTimeline 返回实体所有事件（按章节升序）', () => {
    store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 3,
      eventType: 'character_change', entityId: 'c-1', entityType: 'character',
      description: '第三章变更', oldValue: null, newValue: null,
      cause: null, effectIds: [], significance: 5,
    })
    store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 1,
      eventType: 'character_change', entityId: 'c-1', entityType: 'character',
      description: '第一章变更', oldValue: null, newValue: null,
      cause: null, effectIds: [], significance: 5,
    })
    const timeline = store.getEntityTimeline('p-1', 'c-1')
    expect(timeline).toHaveLength(2)
    expect(timeline[0].chapterNumber).toBe(1)
    expect(timeline[1].chapterNumber).toBe(3)
  })

  it('getEntityTimeline 不存在实体返回空数组', () => {
    expect(store.getEntityTimeline('p-1', 'nonexistent')).toEqual([])
  })

  it('getEntityTimeline 只返回指定实体的事件', () => {
    store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 1,
      eventType: 'character_change', entityId: 'c-1', entityType: 'character',
      description: 'A', oldValue: null, newValue: null,
      cause: null, effectIds: [], significance: 5,
    })
    store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 1,
      eventType: 'character_change', entityId: 'c-2', entityType: 'character',
      description: 'B', oldValue: null, newValue: null,
      cause: null, effectIds: [], significance: 5,
    })
    expect(store.getEntityTimeline('p-1', 'c-1')).toHaveLength(1)
  })
})

describe('NovelMemoryStore - 因果链', () => {
  it('getCausalChain 向上追溯原因', () => {
    const cause = store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 1,
      eventType: 'plot_event', entityId: 'e-1', entityType: 'chapter',
      description: '根因事件', oldValue: null, newValue: null,
      cause: null, effectIds: [], significance: 8,
    })
    const effect = store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 2,
      eventType: 'plot_event', entityId: 'e-2', entityType: 'chapter',
      description: '结果事件', oldValue: null, newValue: null,
      cause: cause.id, effectIds: [], significance: 6,
    })

    const chain = store.getCausalChain(effect.id)
    expect(chain.causes).toHaveLength(1)
    expect(chain.causes[0].id).toBe(cause.id)
    expect(chain.causes[0].description).toBe('根因事件')
  })

  it('getCausalChain 向下追溯影响', () => {
    const effect1 = store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 2,
      eventType: 'plot_event', entityId: 'e-2', entityType: 'chapter',
      description: '结果1', oldValue: null, newValue: null,
      cause: null, effectIds: [], significance: 5,
    })
    const effect2 = store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 3,
      eventType: 'plot_event', entityId: 'e-3', entityType: 'chapter',
      description: '结果2', oldValue: null, newValue: null,
      cause: null, effectIds: [], significance: 5,
    })
    const root = store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 1,
      eventType: 'plot_event', entityId: 'e-1', entityType: 'chapter',
      description: '根事件', oldValue: null, newValue: null,
      cause: null, effectIds: [effect1.id, effect2.id], significance: 8,
    })

    const chain = store.getCausalChain(root.id)
    expect(chain.effects).toHaveLength(2)
    expect(chain.effects.map((e) => e.id).sort()).toEqual([effect1.id, effect2.id].sort())
  })

  it('getCausalChain 不存在的事件返回空链', () => {
    const chain = store.getCausalChain('nonexistent')
    expect(chain.causes).toEqual([])
    expect(chain.effects).toEqual([])
  })

  it('getCausalChain 防止循环引用死循环', () => {
    // 构造循环：A cause=B, B cause=A
    // 因 recordEvent 一次性写入，先写 A 再写 B（B cause=A），然后手动 update A.cause=B
    const a = store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 1,
      eventType: 'plot_event', entityId: 'e-a', entityType: 'chapter',
      description: 'A', oldValue: null, newValue: null,
      cause: null, effectIds: [], significance: 5,
    })
    const b = store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 2,
      eventType: 'plot_event', entityId: 'e-b', entityType: 'chapter',
      description: 'B', oldValue: null, newValue: null,
      cause: a.id, effectIds: [], significance: 5,
    })
    // 手动将 A.cause 设为 B，制造循环
    db.prepare('UPDATE novel_memory_events SET cause = ? WHERE id = ?').run(b.id, a.id)

    // 不应陷入死循环，应正常返回（最多追溯一层后检测到循环）
    const chain = store.getCausalChain(a.id)
    expect(chain.causes.length).toBeGreaterThan(0)
    // 由于 A.cause=B, B.cause=A，遍历到第二次 A 时会被 visited 集合拦截
    expect(chain.causes.length).toBeLessThanOrEqual(2)
  })

  it('getCausalChain 多级原因链（祖父→父→当前）', () => {
    const grandparent = store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 1,
      eventType: 'plot_event', entityId: 'e-1', entityType: 'chapter',
      description: '祖父事件', oldValue: null, newValue: null,
      cause: null, effectIds: [], significance: 9,
    })
    const parent = store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 2,
      eventType: 'plot_event', entityId: 'e-2', entityType: 'chapter',
      description: '父事件', oldValue: null, newValue: null,
      cause: grandparent.id, effectIds: [], significance: 7,
    })
    const current = store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 3,
      eventType: 'plot_event', entityId: 'e-3', entityType: 'chapter',
      description: '当前事件', oldValue: null, newValue: null,
      cause: parent.id, effectIds: [], significance: 5,
    })

    const chain = store.getCausalChain(current.id)
    expect(chain.causes).toHaveLength(2)
    // causes 已 reverse，按时间顺序：祖父→父
    expect(chain.causes[0].id).toBe(grandparent.id)
    expect(chain.causes[1].id).toBe(parent.id)
  })
})

describe('NovelMemoryStore - 快照', () => {
  it('saveSnapshot 保存快照并返回完整对象', () => {
    const snap = store.saveSnapshot({
      projectId: 'p-1',
      chapterNumber: 1,
      snapshotType: 'character',
      entityId: 'c-1',
      snapshotData: '{"state":"happy"}',
    })
    expect(snap.id).toBeTruthy()
    expect(snap.projectId).toBe('p-1')
    expect(snap.snapshotType).toBe('character')
    expect(snap.createdAt).toBeGreaterThan(0)
  })

  it('getSnapshot 返回最新一条匹配快照', () => {
    // now() 使用秒级精度（Math.floor(Date.now() / 1000)），用 fake timers 控制时间戳递增
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2024, 0, 1, 0, 0, 0).getTime()) // createdAt = 1704067200
    store.saveSnapshot({
      projectId: 'p-1', chapterNumber: 1, snapshotType: 'character',
      entityId: 'c-1', snapshotData: '{"v":1}',
    })
    vi.setSystemTime(new Date(2024, 0, 1, 0, 0, 5).getTime()) // createdAt = 1704067205
    store.saveSnapshot({
      projectId: 'p-1', chapterNumber: 1, snapshotType: 'character',
      entityId: 'c-1', snapshotData: '{"v":2}',
    })

    const snap = store.getSnapshot('p-1', 1, { snapshotType: 'character', entityId: 'c-1' })
    expect(snap).toBeDefined()
    expect(snap!.snapshotData).toBe('{"v":2}')
  })

  it('getSnapshot 不存在返回 undefined', () => {
    expect(store.getSnapshot('p-1', 99)).toBeUndefined()
  })

  it('getSnapshot 按 snapshotType 过滤', () => {
    store.saveSnapshot({
      projectId: 'p-1', chapterNumber: 1, snapshotType: 'character',
      entityId: 'c-1', snapshotData: '{}',
    })
    store.saveSnapshot({
      projectId: 'p-1', chapterNumber: 1, snapshotType: 'conflict',
      entityId: 'cf-1', snapshotData: '{}',
    })
    const snap = store.getSnapshot('p-1', 1, { snapshotType: 'conflict' })
    expect(snap).toBeDefined()
    expect(snap!.entityId).toBe('cf-1')
  })

  it('listSnapshots 返回项目所有快照', () => {
    store.saveSnapshot({
      projectId: 'p-1', chapterNumber: 1, snapshotType: 'character',
      entityId: 'c-1', snapshotData: '{}',
    })
    store.saveSnapshot({
      projectId: 'p-1', chapterNumber: 2, snapshotType: 'character',
      entityId: 'c-1', snapshotData: '{}',
    })
    store.saveSnapshot({
      projectId: 'p-2', chapterNumber: 1, snapshotType: 'character',
      entityId: 'c-1', snapshotData: '{}',
    })
    expect(store.listSnapshots('p-1')).toHaveLength(2)
  })

  it('listSnapshots 按 chapterNumber 过滤', () => {
    store.saveSnapshot({
      projectId: 'p-1', chapterNumber: 1, snapshotType: 'character',
      entityId: 'c-1', snapshotData: '{}',
    })
    store.saveSnapshot({
      projectId: 'p-1', chapterNumber: 2, snapshotType: 'character',
      entityId: 'c-1', snapshotData: '{}',
    })
    const list = store.listSnapshots('p-1', { chapterNumber: 2 })
    expect(list).toHaveLength(1)
    expect(list[0].chapterNumber).toBe(2)
  })

  it('listSnapshots 按 snapshotType 过滤', () => {
    store.saveSnapshot({
      projectId: 'p-1', chapterNumber: 1, snapshotType: 'character',
      entityId: 'c-1', snapshotData: '{}',
    })
    store.saveSnapshot({
      projectId: 'p-1', chapterNumber: 1, snapshotType: 'full',
      entityId: null, snapshotData: '{}',
    })
    const list = store.listSnapshots('p-1', { snapshotType: 'full' })
    expect(list).toHaveLength(1)
    expect(list[0].snapshotType).toBe('full')
  })
})
