/**
 * T02-6 AI 提取确认队列测试。
 *
 * 守护：
 * 1. AI 自动写入（ai-extracted / ai-planned）的事件进入待确认队列；
 * 2. 确认：事件 → confirmed，其 pending change record → confirmed，退出队列；
 * 3. 驳回：事件 → superseded，其 change record → rejected 并从消费查询（listChangeRecords）排除；
 * 4. manual 事件不进队列；无 pending change record 的事件正常返回。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { NovelStore } from '../core/novel-store.js'
import { NovelMemoryStore } from '../core/novel-memory-store.js'
import { novelMigrations } from '../novel-migrations.js'

const PROJECT_ID = 'proj-confirm-queue'

describe('AI 提取确认队列（T02-6）', () => {
  let db: Database.Database
  let store: NovelStore
  let memoryStore: NovelMemoryStore

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    for (const m of novelMigrations) db.exec(m.sql)
    store = new NovelStore(db)
    memoryStore = new NovelMemoryStore(db)
    store.createProject({
      id: PROJECT_ID, title: '确认队列测试', genre: 't', synopsis: '', outline: '',
      targetWords: 0, currentVolume: 1, currentChapter: 1,
      currentStage: 'setup', status: 'active',
    })
    store.createChapter({
      id: 'ch-1', projectId: PROJECT_ID, volume: 1, chapterNumber: 1,
      title: '', content: '', wordCount: 0, status: 'planned',
      narrativeTask: '', outline: '', volumeId: null, acceptanceResult: null,
    })
  })

  afterEach(() => db.close())

  function seedEvent(source: string, status: string): string {
    return memoryStore.createStoryEventWithChanges({
      event: {
        projectId: PROJECT_ID,
        chapterNumber: 1,
        sceneId: null,
        sceneOrder: 0,
        type: 'discovery',
        title: 'AI 提取事件',
        summary: '主角在书房发现染血收据',
        outcome: '',
        status: status as never,
        parentEventId: null,
        source: source as never,
      },
      entityRefs: [
        { entityType: 'character', entityId: 'c-1', role: 'actor', note: '' },
      ],
      changes: [
        {
          subjectType: 'character',
          subjectId: 'c-1',
          dimension: 'character.cognition',
          targetType: null,
          targetId: null,
          valueType: 'text',
          beforeValue: '不知情',
          afterValue: '开始怀疑',
          reason: 'AI 提取',
          significance: 6,
          source: 'ai-extracted' as never,
        },
      ],
    }).event.id
  }

  it('AI 提取事件进入待确认队列（带实体引用与 pending change record）', () => {
    seedEvent('ai-extracted', 'planned')
    const queue = memoryStore.listPendingEvents(PROJECT_ID)
    expect(queue).toHaveLength(1)
    expect(queue[0].event.source).toBe('ai-extracted')
    expect(queue[0].entityRefs).toHaveLength(1)
    expect(queue[0].changes).toHaveLength(1)
    expect(queue[0].changes[0].status).toBe('pending')
  })

  it('manual 事件不进待确认队列', () => {
    seedEvent('manual', 'planned')
    expect(memoryStore.listPendingEvents(PROJECT_ID)).toHaveLength(0)
  })

  it('已确认/已驳回事件不进待确认队列', () => {
    seedEvent('ai-extracted', 'confirmed')
    seedEvent('ai-extracted', 'superseded')
    expect(memoryStore.listPendingEvents(PROJECT_ID)).toHaveLength(0)
  })

  it('确认事件：事件 → confirmed，pending change record → confirmed，退出队列', () => {
    const id = seedEvent('ai-extracted', 'planned')
    expect(memoryStore.confirmEvent(id)).toBe(true)
    const event = memoryStore.getStoryEvent(id)
    expect(event?.status).toBe('confirmed')
    const changes = memoryStore.listChangeRecords(PROJECT_ID, { storyEventId: id })
    expect(changes).toHaveLength(1)
    expect(changes[0].status).toBe('confirmed')
    expect(memoryStore.listPendingEvents(PROJECT_ID)).toHaveLength(0)
  })

  it('驳回事件：事件 → superseded，change record → rejected 并从消费查询排除', () => {
    const id = seedEvent('ai-extracted', 'planned')
    expect(memoryStore.rejectEvent(id)).toBe(true)
    const event = memoryStore.getStoryEvent(id)
    expect(event?.status).toBe('superseded')
    // 消费查询（默认）排除 rejected
    expect(memoryStore.listChangeRecords(PROJECT_ID)).toHaveLength(0)
    // 显式按 status 查能看到 rejected 记录（审计可追溯）
    const rejected = memoryStore.listChangeRecords(PROJECT_ID, { storyEventId: id, status: 'rejected' })
    expect(rejected).toHaveLength(1)
    expect(memoryStore.listPendingEvents(PROJECT_ID)).toHaveLength(0)
  })

  it('不存在的事件 confirm/reject 返回 false', () => {
    expect(memoryStore.confirmEvent('no-such-event')).toBe(false)
    expect(memoryStore.rejectEvent('no-such-event')).toBe(false)
  })

  it('事件参与派生边：同事件实体两两成对，按章节定位', () => {
    // 两个实体参与同一事件 → 1 条边
    memoryStore.createStoryEventWithChanges({
      event: {
        projectId: PROJECT_ID,
        chapterNumber: 1,
        sceneId: null,
        sceneOrder: 0,
        type: 'encounter',
        title: '相遇事件',
        summary: '',
        outcome: '',
        status: 'confirmed',
        parentEventId: null,
        source: 'manual',
      },
      entityRefs: [
        { entityType: 'character', entityId: 'c-1', role: 'actor', note: '' },
        { entityType: 'character', entityId: 'c-2', role: 'actor', note: '' },
        { entityType: 'character', entityId: 'c-3', role: 'participant', note: '' },
      ],
      changes: [],
    })
    const edges = memoryStore.listEventParticipationEdges(PROJECT_ID)
    // 3 个实体两两成对 = 3 条边（c1-c2, c1-c3, c2-c3）
    const pairs = new Set(edges.map((e) => [e.from, e.to].sort().join('|')))
    expect(pairs).toEqual(new Set(['c-1|c-2', 'c-1|c-3', 'c-2|c-3']))
    expect(edges.every((e) => e.chapterNumber === 1)).toBe(true)
    expect(edges.every((e) => e.eventId.length > 0)).toBe(true)

    // 章节裁剪
    const ch2 = memoryStore.listEventParticipationEdges(PROJECT_ID, { chapterStart: 2 })
    expect(ch2).toHaveLength(0)
  })
})
