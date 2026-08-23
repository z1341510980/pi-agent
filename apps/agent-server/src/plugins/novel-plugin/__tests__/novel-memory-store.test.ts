import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { NovelMemoryStore, inferDimension } from '../core/novel-memory-store.js'
import { novelMigrations } from '../novel-migrations.js'

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

  it('recordEvent 未传 source 时回落 ai-extracted 且 status=pending（H3 回归）', () => {
    // 章节 diff 等自动事件不传 source：source 回落 'ai-extracted'，
    // status 判定必须基于回落后的值 → 'pending'，不能绕过待确认队列。
    store.recordEvent({
      projectId: 'p-1',
      chapterId: 'ch-1',
      chapterNumber: 1,
      eventType: 'character_change',
      entityId: 'c-1',
      entityType: 'character',
      description: '无 source 的自动事件',
      oldValue: null,
      newValue: '{"state":"x"}',
      cause: null,
      effectIds: [],
      significance: 5,
    })
    // 显式 manual 写入保持 confirmed
    store.recordEvent({
      projectId: 'p-1',
      chapterId: 'ch-1',
      chapterNumber: 1,
      eventType: 'character_change',
      entityId: 'c-1',
      entityType: 'character',
      description: '手动事件',
      oldValue: null,
      newValue: '{"state":"y"}',
      cause: null,
      effectIds: [],
      significance: 5,
      source: 'manual',
    })
    const events = store.listEvents('p-1')
    expect(events).toHaveLength(2)
    const auto = events.find((e) => e.description === '无 source 的自动事件')!
    expect(auto.source).toBe('ai-extracted')
    expect(auto.status).toBe('pending')
    const manual = events.find((e) => e.description === '手动事件')!
    expect(manual.source).toBe('manual')
    expect(manual.status).toBe('confirmed')
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

  it('replaceSnapshot 原子替换同维度快照', () => {
    store.saveSnapshot({
      projectId: 'p-1', chapterNumber: 1, snapshotType: 'full',
      entityId: null, snapshotData: '{"v":1}',
    })
    store.replaceSnapshot({
      projectId: 'p-1', chapterNumber: 1, snapshotType: 'full',
      entityId: null, snapshotData: '{"v":2}',
    })

    expect(store.listSnapshots('p-1', { chapterNumber: 1, snapshotType: 'full' })).toHaveLength(1)
    expect(store.getSnapshot('p-1', 1, { snapshotType: 'full' })?.snapshotData).toBe('{"v":2}')
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

// ═══════════════════════════════════════════════════════════════
// dimension 集中推断落库（纯函数测试见 infer-dimension.test.ts）
// ═══════════════════════════════════════════════════════════════

describe('recordEvent - dimension 自动推断落库', () => {
  it('recordEvent 写入后 dimension 和 valueType 字段被持久化', () => {
    const event = store.recordEvent({
      projectId: 'p-1', chapterId: 'ch-1', chapterNumber: 1,
      eventType: 'conflict_change',
      entityId: 'cf-1', entityType: 'conflict',
      description: '冲突阶段变更',
      oldValue: JSON.stringify({ stage: '潜伏', intensity: 5 }),
      newValue: JSON.stringify({ stage: '高潮', intensity: 8 }),
      cause: null, effectIds: [], significance: 7,
    })
    expect(event.dimension).toBe('conflict.stage')
    expect(event.valueType).toBe('enum')

    // 通过 listEvents 读回验证
    const list = store.listEvents('p-1')
    expect(list).toHaveLength(1)
    expect(list[0].dimension).toBe('conflict.stage')
    expect(list[0].valueType).toBe('enum')
    expect(list[0].source).toBe('ai-extracted')
  })

  it('调用方显式传入 dimension 时不被推断覆盖', () => {
    const event = store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 1,
      eventType: 'conflict_change',
      entityId: 'cf-1', entityType: 'conflict',
      description: '自定义维度',
      oldValue: JSON.stringify({ stage: '潜伏' }),
      newValue: JSON.stringify({ stage: '高潮' }),
      dimension: 'custom.dimension',
      valueType: 'text',
      cause: null, effectIds: [], significance: 5,
    })
    expect(event.dimension).toBe('custom.dimension')
    expect(event.valueType).toBe('text')
  })

  it('无法推断时 dimension 保持 null（旧行为）', () => {
    const event = store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 1,
      eventType: 'plot_event',
      entityId: 'ch-1', entityType: 'chapter',
      description: '剧情事件',
      oldValue: null,
      newValue: JSON.stringify({ title: '高潮' }),
      cause: null, effectIds: [], significance: 5,
    })
    expect(event.dimension).toBeNull()
    expect(event.valueType).toBeNull()
  })
})

describe('recordEvent → listChangeRecords 端到端（验证 dimension 过滤穿透）', () => {
  it('recordEvent 写入的 conflict 事件能被 listChangeRecords 查到', () => {
    // 模拟 chapter-finalizer 写入冲突阶段变更
    store.recordEvent({
      projectId: 'p-1', chapterId: 'ch-1', chapterNumber: 5,
      eventType: 'conflict_change',
      entityId: 'cf-1', entityType: 'conflict',
      description: '冲突阶段变更: 主线冲突（潜伏 → 高潮）',
      oldValue: JSON.stringify({ stage: '潜伏', intensity: 5 }),
      newValue: JSON.stringify({ stage: '高潮', intensity: 8 }),
      cause: null, effectIds: [], significance: 7,
    })

    // 之前会被 `dimension IS NOT NULL` 过滤掉，现在应该能查到
    const records = store.listChangeRecords('p-1', { subjectId: 'cf-1' })
    expect(records).toHaveLength(1)
    expect(records[0].dimension).toBe('conflict.stage')
    expect(records[0].valueType).toBe('enum')
    expect(records[0].subjectId).toBe('cf-1')
    expect(records[0].subjectType).toBe('conflict')
  })

  it('recordEvent 写入的冲突创建事件 → conflict.created', () => {
    store.recordEvent({
      projectId: 'p-1', chapterId: 'ch-1', chapterNumber: 1,
      eventType: 'conflict_change',
      entityId: 'cf-new', entityType: 'conflict',
      description: '冲突创建: 主线冲突',
      oldValue: null,
      newValue: JSON.stringify({
        stage: '潜伏', intensity: 5,
        plotFunction: '主线', progressionMode: 'linear',
      }),
      cause: null, effectIds: [], significance: 7,
    })

    const records = store.listChangeRecords('p-1', { subjectId: 'cf-new' })
    expect(records).toHaveLength(1)
    expect(records[0].dimension).toBe('conflict.created')
    expect(records[0].valueType).toBe('reference')
  })

  it('recordEvent 写入的角色弧光变更 → character.arc_stage', () => {
    store.recordEvent({
      projectId: 'p-1', chapterId: 'ch-1', chapterNumber: 3,
      eventType: 'character_change',
      entityId: 'c-1', entityType: 'character',
      description: '角色 李雷 的 arcStage 变更',
      oldValue: JSON.stringify({ arcStage: '起点' }),
      newValue: JSON.stringify({ arcStage: '成长' }),
      cause: null, effectIds: [], significance: 6,
    })

    const records = store.listChangeRecords('p-1', { subjectId: 'c-1' })
    expect(records).toHaveLength(1)
    expect(records[0].dimension).toBe('character.arc_stage')
  })

  it('dimension 仍为 null 的事件（如 plot_event）被 listChangeRecords 过滤掉', () => {
    store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 1,
      eventType: 'plot_event',
      entityId: 'ch-1', entityType: 'chapter',
      description: '剧情事件',
      oldValue: null,
      newValue: JSON.stringify({ title: '高潮' }),
      cause: null, effectIds: [], significance: 5,
    })

    const records = store.listChangeRecords('p-1')
    expect(records).toHaveLength(0)
  })

  it('listChangeRecords 按 dimension 过滤生效', () => {
    store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 1,
      eventType: 'conflict_change',
      entityId: 'cf-1', entityType: 'conflict',
      description: '冲突阶段变更',
      oldValue: JSON.stringify({ stage: '潜伏' }),
      newValue: JSON.stringify({ stage: '高潮' }),
      cause: null, effectIds: [], significance: 7,
    })
    store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 2,
      eventType: 'conflict_change',
      entityId: 'cf-1', entityType: 'conflict',
      description: '冲突强度变更',
      oldValue: JSON.stringify({ intensity: 5 }),
      newValue: JSON.stringify({ intensity: 8 }),
      cause: null, effectIds: [], significance: 5,
    })

    const stageRecords = store.listChangeRecords('p-1', { dimension: 'conflict.stage' })
    expect(stageRecords).toHaveLength(1)
    expect(stageRecords[0].dimension).toBe('conflict.stage')

    const intensityRecords = store.listChangeRecords('p-1', { dimension: 'conflict.intensity' })
    expect(intensityRecords).toHaveLength(1)
    expect(intensityRecords[0].dimension).toBe('conflict.intensity')
  })
})

// ═══════════════════════════════════════════════════════════════
// backfillMissingDimensions - 历史数据回填迁移
// ═══════════════════════════════════════════════════════════════

/**
 * 直接用 SQL 插入 dimension IS NULL 的行，模拟 recordEvent 推断功能上线前的历史数据。
 * 修改后的 recordEvent 会自动推断 dimension，所以正常路径不会再产生 NULL 行。
 */
function insertLegacyEvent(opts: {
  id: string
  eventType: string
  entityId: string
  entityType: string
  newValue: string | null
  oldValue?: string | null
}): void {
  db.prepare(`
    INSERT INTO novel_memory_events
      (id, project_id, chapter_id, chapter_number, event_type, entity_id, entity_type,
       description, old_value, new_value, cause, effect_ids, significance,
       dimension, value_type, source, created_at)
    VALUES
      (?, 'p-1', NULL, 1, ?, ?, ?,
       'legacy event', ?, ?, NULL, '[]', 5,
       NULL, NULL, 'migration', ?)
  `).run(
    opts.id, opts.eventType, opts.entityId, opts.entityType,
    opts.oldValue ?? null, opts.newValue, Math.floor(Date.now() / 1000),
  )
}

describe('backfillMissingDimensions - dry-run', () => {
  it('空库时返回 scanned=0', () => {
    const stats = store.backfillMissingDimensions({ dryRun: true })
    expect(stats).toEqual({ scanned: 0, updated: 0, skipped: 0, uninferable: 0 })
  })

  it('dry-run 只统计不写入', () => {
    insertLegacyEvent({
      id: 'legacy-1', eventType: 'conflict_change',
      entityId: 'cf-1', entityType: 'conflict',
      oldValue: JSON.stringify({ stage: '潜伏' }),
      newValue: JSON.stringify({ stage: '高潮' }),
    })

    const stats = store.backfillMissingDimensions({ dryRun: true })
    expect(stats.scanned).toBe(1)
    expect(stats.updated).toBe(0)  // dry-run 不写入
    expect(stats.uninferable).toBe(0)

    // 验证数据库中 dimension 仍为 NULL
    const records = store.listChangeRecords('p-1')
    expect(records).toHaveLength(0)  // 仍被 dimension IS NOT NULL 过滤
  })

  it('dry-run 统计 uninferable 数量', () => {
    insertLegacyEvent({
      id: 'legacy-plot', eventType: 'plot_event',
      entityId: 'ch-1', entityType: 'chapter',
      newValue: JSON.stringify({ title: '高潮' }),
    })

    const stats = store.backfillMissingDimensions({ dryRun: true })
    expect(stats.scanned).toBe(1)
    expect(stats.uninferable).toBe(1)
  })
})

describe('backfillMissingDimensions - 实际回填', () => {
  it('回填后 dimension 被填入且能被 listChangeRecords 查到', () => {
    insertLegacyEvent({
      id: 'legacy-conflict', eventType: 'conflict_change',
      entityId: 'cf-1', entityType: 'conflict',
      oldValue: JSON.stringify({ stage: '潜伏', intensity: 5 }),
      newValue: JSON.stringify({ stage: '高潮', intensity: 8 }),
    })

    // 回填前：被 dimension IS NOT NULL 过滤
    expect(store.listChangeRecords('p-1')).toHaveLength(0)

    const stats = store.backfillMissingDimensions({ backup: false })
    expect(stats.scanned).toBe(1)
    expect(stats.updated).toBe(1)
    expect(stats.uninferable).toBe(0)

    // 回填后：能查到
    const records = store.listChangeRecords('p-1')
    expect(records).toHaveLength(1)
    expect(records[0].dimension).toBe('conflict.stage')
    expect(records[0].valueType).toBe('enum')
    expect(records[0].subjectId).toBe('cf-1')
  })

  it('多种 eventType 混合回填', () => {
    insertLegacyEvent({
      id: 'legacy-char', eventType: 'character_change',
      entityId: 'c-1', entityType: 'character',
      oldValue: JSON.stringify({ arcStage: '起点' }),
      newValue: JSON.stringify({ arcStage: '成长' }),
    })
    insertLegacyEvent({
      id: 'legacy-foreshadow', eventType: 'foreshadow_change',
      entityId: 'f-1', entityType: 'foreshadow',
      oldValue: JSON.stringify({ status: 'planted' }),
      newValue: JSON.stringify({ status: 'payoff' }),
    })
    insertLegacyEvent({
      id: 'legacy-relationship', eventType: 'relationship_change',
      entityId: 'r-1', entityType: 'relationship',
      oldValue: JSON.stringify({ currentStage: '盟友' }),
      newValue: JSON.stringify({ currentStage: '决裂' }),
    })

    const stats = store.backfillMissingDimensions({ backup: false })
    expect(stats.scanned).toBe(3)
    expect(stats.updated).toBe(3)
    expect(stats.uninferable).toBe(0)

    const records = store.listChangeRecords('p-1')
    expect(records).toHaveLength(3)
    const dims = records.map((r) => r.dimension).sort()
    expect(dims).toEqual(['character.arc_stage', 'foreshadow.beat', 'relationship.stage'])
  })

  it('无法推断的事件 dimension 保持 NULL（不被回填）', () => {
    insertLegacyEvent({
      id: 'legacy-plot', eventType: 'plot_event',
      entityId: 'ch-1', entityType: 'chapter',
      newValue: JSON.stringify({ title: '高潮' }),
    })

    const stats = store.backfillMissingDimensions({ backup: false })
    expect(stats.scanned).toBe(1)
    expect(stats.updated).toBe(0)
    expect(stats.uninferable).toBe(1)

    // dimension 仍为 NULL，listChangeRecords 仍查不到
    expect(store.listChangeRecords('p-1')).toHaveLength(0)

    // 但 listEvents 仍能查到（不过滤 dimension）
    const events = store.listEvents('p-1')
    expect(events).toHaveLength(1)
    expect(events[0].dimension).toBeNull()
  })

  it('混合可推断 + 不可推断事件', () => {
    insertLegacyEvent({
      id: 'legacy-conflict', eventType: 'conflict_change',
      entityId: 'cf-1', entityType: 'conflict',
      oldValue: JSON.stringify({ stage: '潜伏' }),
      newValue: JSON.stringify({ stage: '高潮' }),
    })
    insertLegacyEvent({
      id: 'legacy-plot', eventType: 'plot_event',
      entityId: 'ch-1', entityType: 'chapter',
      newValue: JSON.stringify({ title: '高潮' }),
    })

    const stats = store.backfillMissingDimensions({ backup: false })
    expect(stats.scanned).toBe(2)
    expect(stats.updated).toBe(1)
    expect(stats.uninferable).toBe(1)

    expect(store.listChangeRecords('p-1')).toHaveLength(1)
  })
})

describe('backfillMissingDimensions - 幂等性', () => {
  it('重复调用安全：第二次 scanned=0', () => {
    insertLegacyEvent({
      id: 'legacy-1', eventType: 'conflict_change',
      entityId: 'cf-1', entityType: 'conflict',
      oldValue: JSON.stringify({ stage: '潜伏' }),
      newValue: JSON.stringify({ stage: '高潮' }),
    })

    const first = store.backfillMissingDimensions({ backup: false })
    expect(first.scanned).toBe(1)
    expect(first.updated).toBe(1)

    const second = store.backfillMissingDimensions({ backup: false })
    expect(second.scanned).toBe(0)
    expect(second.updated).toBe(0)
  })

  it('已显式填入 dimension 的行不被回填覆盖', () => {
    // 用 createChangeRecord 写入一个已有 dimension 的记录
    store.createChangeRecord({
      projectId: 'p-1',
      storyEventId: null,
      chapterNumber: 1,
      sceneOrder: 0,
      subjectType: 'conflict',
      subjectId: 'cf-manual',
      dimension: 'manual.dimension',
      targetType: null,
      targetId: null,
      valueType: 'text',
      beforeValue: null,
      afterValue: { foo: 'bar' },
      reason: 'manual record',
      significance: 5,
      source: 'manual',
      cause: null,
      effectIds: [],
    })

    const stats = store.backfillMissingDimensions({ backup: false })
    expect(stats.scanned).toBe(0)  // 已有 dimension，不在扫描范围
  })
})

describe('backfillMissingDimensions - 备份', () => {
  it('非 dry-run 且有更新时创建备份表', () => {
    insertLegacyEvent({
      id: 'legacy-1', eventType: 'conflict_change',
      entityId: 'cf-1', entityType: 'conflict',
      oldValue: JSON.stringify({ stage: '潜伏' }),
      newValue: JSON.stringify({ stage: '高潮' }),
    })

    const stats = store.backfillMissingDimensions({ backup: true })
    expect(stats.scanned).toBe(1)
    expect(stats.updated).toBe(1)
    expect(stats.backupTable).toMatch(/^novel_memory_events_backup_\d+$/)

    // 验证备份表存在且数据完整
    const backupCount = db.prepare(`SELECT COUNT(*) as c FROM ${stats.backupTable}`).get() as { c: number }
    expect(backupCount.c).toBe(1)  // 备份时表里有 1 行（回填前的原始数据）
  })

  it('backup: false 时不创建备份表', () => {
    insertLegacyEvent({
      id: 'legacy-1', eventType: 'conflict_change',
      entityId: 'cf-1', entityType: 'conflict',
      oldValue: JSON.stringify({ stage: '潜伏' }),
      newValue: JSON.stringify({ stage: '高潮' }),
    })

    const stats = store.backfillMissingDimensions({ backup: false })
    expect(stats.backupTable).toBeUndefined()
  })

  it('无待回填数据时不创建备份表', () => {
    const stats = store.backfillMissingDimensions({ backup: true })
    expect(stats.scanned).toBe(0)
    expect(stats.backupTable).toBeUndefined()
  })
})

describe('backfillMissingDimensions - 端到端验证（打通过滤陷阱）', () => {
  it('历史 conflict 事件回填后可被矩阵账本视图消费', () => {
    // 模拟：推断功能上线前写入的历史 conflict 事件
    insertLegacyEvent({
      id: 'history-conflict-1', eventType: 'conflict_change',
      entityId: 'cf-matrix', entityType: 'conflict',
      oldValue: JSON.stringify({ stage: '潜伏', intensity: 5 }),
      newValue: JSON.stringify({ stage: '高潮', intensity: 8 }),
    })
    insertLegacyEvent({
      id: 'history-conflict-2', eventType: 'conflict_change',
      entityId: 'cf-matrix', entityType: 'conflict',
      oldValue: JSON.stringify({ intensity: 8 }),
      newValue: JSON.stringify({ intensity: 9 }),
    })

    // 回填前：矩阵账本视图查不到任何 conflict 变化
    expect(store.listChangeRecords('p-1', { subjectId: 'cf-matrix' })).toHaveLength(0)

    // 执行回填
    const stats = store.backfillMissingDimensions({ backup: false })
    expect(stats.updated).toBe(2)

    // 回填后：矩阵账本视图能查到 2 条变化（stage + intensity）
    const records = store.listChangeRecords('p-1', { subjectId: 'cf-matrix' })
    expect(records).toHaveLength(2)
    expect(records.map((r) => r.dimension).sort()).toEqual(['conflict.intensity', 'conflict.stage'])

    // 按 dimension 精确过滤也能用
    const stageOnly = store.listChangeRecords('p-1', {
      subjectId: 'cf-matrix',
      dimension: 'conflict.stage',
    })
    expect(stageOnly).toHaveLength(1)
    expect(stageOnly[0].dimension).toBe('conflict.stage')
  })
})

// ═══════════════════════════════════════════════════════════════
// styleNote 字段：文风挂接（设计文档第 8 节）
// ═══════════════════════════════════════════════════════════════

describe('styleNote 字段 - recordEvent 写入', () => {
  it('recordEvent 支持 styleNote 字段写入', () => {
    const event = store.recordEvent({
      projectId: 'p-1', chapterId: 'ch-1', chapterNumber: 1,
      eventType: 'conflict_change',
      entityId: 'cf-1', entityType: 'conflict',
      description: '冲突阶段变更',
      oldValue: JSON.stringify({ stage: '潜伏' }),
      newValue: JSON.stringify({ stage: '高潮' }),
      cause: null, effectIds: [], significance: 7,
      styleNote: '用对话暗示而非直叙冲突升级',
    })
    expect(event.styleNote).toBe('用对话暗示而非直叙冲突升级')

    // 通过 listEvents 读回验证
    const list = store.listEvents('p-1')
    expect(list[0].styleNote).toBe('用对话暗示而非直叙冲突升级')
  })

  it('recordEvent 不传 styleNote 时默认 null', () => {
    store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 1,
      eventType: 'conflict_change',
      entityId: 'cf-1', entityType: 'conflict',
      description: '冲突变更',
      oldValue: JSON.stringify({ stage: '潜伏' }),
      newValue: JSON.stringify({ stage: '高潮' }),
      cause: null, effectIds: [], significance: 5,
    })
    const list = store.listEvents('p-1')
    expect(list[0].styleNote).toBeNull()
  })
})

describe('styleNote 字段 - createChangeRecord 写入', () => {
  it('createChangeRecord 支持 styleNote 字段', () => {
    const record = store.createChangeRecord({
      projectId: 'p-1',
      storyEventId: null,
      chapterNumber: 1,
      sceneOrder: 0,
      subjectType: 'conflict',
      subjectId: 'cf-1',
      dimension: 'conflict.stage',
      targetType: null,
      targetId: null,
      valueType: 'enum',
      beforeValue: '潜伏',
      afterValue: '高潮',
      reason: '剧情推进',
      significance: 7,
      source: 'manual',
      cause: null,
      effectIds: [],
      styleNote: '用环境描写烘托冲突张力',
    })
    expect(record.styleNote).toBe('用环境描写烘托冲突张力')

    // 通过 listChangeRecords 读回验证
    const records = store.listChangeRecords('p-1', { subjectId: 'cf-1' })
    expect(records[0].styleNote).toBe('用环境描写烘托冲突张力')
  })

  it('createChangeRecord 不传 styleNote 时默认 null', () => {
    store.createChangeRecord({
      projectId: 'p-1',
      storyEventId: null,
      chapterNumber: 1,
      sceneOrder: 0,
      subjectType: 'conflict',
      subjectId: 'cf-1',
      dimension: 'conflict.stage',
      targetType: null,
      targetId: null,
      valueType: 'enum',
      beforeValue: '潜伏',
      afterValue: '高潮',
      reason: '剧情推进',
      significance: 5,
      source: 'manual',
      cause: null,
      effectIds: [],
    })
    const records = store.listChangeRecords('p-1', { subjectId: 'cf-1' })
    expect(records[0].styleNote).toBeNull()
  })
})

describe('styleNote 字段 - 矩阵聚合接口返回', () => {
  it('getMatrixAggregation 返回的 changes 携带 styleNote', async () => {
    // 这里只验证 store 层，路由层测试在 matrix-aggregation-routes.test.ts
    store.recordEvent({
      projectId: 'p-1', chapterId: null, chapterNumber: 1,
      eventType: 'character_change',
      entityId: 'c-1', entityType: 'character',
      description: '角色弧光变更',
      oldValue: JSON.stringify({ arcStage: '起点' }),
      newValue: JSON.stringify({ arcStage: '成长' }),
      cause: null, effectIds: [], significance: 6,
      styleNote: '通过内心独白展现成长转折',
    })

    const records = store.listChangeRecords('p-1', { subjectId: 'c-1' })
    expect(records).toHaveLength(1)
    expect(records[0].styleNote).toBe('通过内心独白展现成长转折')
    expect(records[0].dimension).toBe('character.arc_stage')
  })
})
