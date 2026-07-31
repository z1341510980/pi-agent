import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import {
  shiftChapterNumber,
  shiftChapterSpans,
  shiftChapterList,
  shiftChapterEvents,
  type ChapterRenumberSpec,
  createChapterRenumberSpec,
} from '../core/chapter-renumber.js'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  for (const m of novelMigrations) db.exec(m.sql)
  return db
}

describe('ChapterRenumberSpec - 标量字段 shift', () => {
  it('当被删章节是 3，当前字段值 5 时，应 shift 为 4', () => {
    expect(shiftChapterNumber(5, createChapterRenumberSpec(3))).toBe(4)
  })

  it('当被删章节是 3，当前字段值 3 时，应返回 null（被删章节引用需清除）', () => {
    expect(shiftChapterNumber(3, createChapterRenumberSpec(3))).toBeNull()
  })

  it('当被删章节是 3，当前字段值 2 时，不变（小于被删章节）', () => {
    expect(shiftChapterNumber(2, createChapterRenumberSpec(3))).toBe(2)
  })

  it('当被删章节是 3，当前字段值 null 时，返回 null', () => {
    expect(shiftChapterNumber(null, createChapterRenumberSpec(3))).toBeNull()
  })

  it('delta 为正数时（向右 shift，预留插入场景），值 5 → 6', () => {
    const spec: ChapterRenumberSpec = { deletedChapter: 3, delta: 1 }
    expect(shiftChapterNumber(5, spec)).toBe(6)
  })
})

describe('ChapterRenumberSpec - chapter_spans JSON 数组 shift', () => {
  it('单段跨度 [[1,5]] 删第 3 章 → [[1,4]]（end 减 1，start 不变因小于被删章）', () => {
    expect(shiftChapterSpans([[1, 5]], createChapterRenumberSpec(3))).toEqual([[1, 4]])
  })

  it('单段跨度 [[1,2]] 删第 3 章 → [[1,2]]（被删章在跨度外，不变）', () => {
    expect(shiftChapterSpans([[1, 2]], createChapterRenumberSpec(3))).toEqual([[1, 2]])
  })

  it('单段跨度 [[3,5]] 删第 3 章 → [[3,4]]（start 等于被删章，视为从被删章开始，start 不变 end shift）', () => {
    expect(shiftChapterSpans([[3, 5]], createChapterRenumberSpec(3))).toEqual([[3, 4]])
  })

  it('单段跨度 [[3,3]] 删第 3 章 → []（整段被删，移除）', () => {
    expect(shiftChapterSpans([[3, 3]], createChapterRenumberSpec(3))).toEqual([])
  })

  it('多段跨度 [[1,2],[5,8]] 删第 5 章 → [[1,2],[5,7]]（仅第二段 end 减 1）', () => {
    expect(shiftChapterSpans([[1, 2], [5, 8]], createChapterRenumberSpec(5))).toEqual([[1, 2], [5, 7]])
  })

  it('多段跨度 [[1,2],[5,8]] 删第 3 章 → [[1,2],[4,7]]（第二段 start 和 end 都减 1）', () => {
    expect(shiftChapterSpans([[1, 2], [5, 8]], createChapterRenumberSpec(3))).toEqual([[1, 2], [4, 7]])
  })

  it('空数组不变', () => {
    expect(shiftChapterSpans([], createChapterRenumberSpec(3))).toEqual([])
  })

  it('非法跨度（start > end）原样返回，不做修复', () => {
    expect(shiftChapterSpans([[5, 3]], createChapterRenumberSpec(2))).toEqual([[5, 3]])
  })
})

describe('ChapterRenumberSpec - appear_chapters JSON 列表 shift', () => {
  it('列表 [1,2,5,7] 删第 3 章 → [1,2,4,6]（大于被删章的全减 1）', () => {
    expect(shiftChapterList([1, 2, 5, 7], createChapterRenumberSpec(3))).toEqual([1, 2, 4, 6])
  })

  it('列表 [1,2,3,5] 删第 3 章 → [1,2,4]（被删章本身移除）', () => {
    expect(shiftChapterList([1, 2, 3, 5], createChapterRenumberSpec(3))).toEqual([1, 2, 4])
  })

  it('空列表不变', () => {
    expect(shiftChapterList([], createChapterRenumberSpec(3))).toEqual([])
  })

  it('含重复值 [1,1,3,3] 删第 3 章 → [1,1]（两个 3 都被移除）', () => {
    expect(shiftChapterList([1, 1, 3, 3], createChapterRenumberSpec(3))).toEqual([1, 1])
  })
})

describe('ChapterRenumberSpec - 离散事件链 shift', () => {
  it('删除事件所在章节并前移后续事件，同时保留事件类型和备注', () => {
    expect(shiftChapterEvents([
      { chapter: 1, type: 'plant', note: '埋设' },
      { chapter: 3, type: 'reinforce', note: '删除此章' },
      { chapter: 5, type: 'payoff', note: '回收' },
    ], createChapterRenumberSpec(3))).toEqual([
      { chapter: 1, type: 'plant', note: '埋设' },
      { chapter: 4, type: 'payoff', note: '回收' },
    ])
  })
})

describe('NovelStore.deleteChapter 集成 - 章节重排', () => {
  let db: Database.Database
  let store: NovelStore
  let projectId: string

  beforeEach(() => {
    db = createTestDb()
    store = new NovelStore(db)
    const project = store.createProject({
      id: randomUUID(),
      title: '测试项目',
      genre: 'test',
      synopsis: '',
      targetWords: 0,
      currentVolume: 1,
      currentChapter: 0,
      currentStage: 'setup',
      status: 'active',
    })
    projectId = project.id
    // 创建 5 章
    for (let i = 1; i <= 5; i++) {
      store.createChapter({
        id: randomUUID(),
        projectId,
        volume: 1,
        chapterNumber: i,
        title: `第${i}章`,
        content: '',
        wordCount: 0,
        status: 'planned',
        narrativeTask: '',
        acceptanceResult: null,
      })
    }
  })

  afterEach(() => db.close())

  it('删除第 3 章后，第 4、5 章号自动前移为 3、4', () => {
    const chapters = store.listChapters(projectId)
    const ch3 = chapters.find((c) => c.chapterNumber === 3)!
    store.deleteChapter(ch3.id)
    const after = store.listChapters(projectId).sort((a, b) => a.chapterNumber - b.chapterNumber)
    expect(after.map((c) => c.chapterNumber)).toEqual([1, 2, 3, 4])
    expect(after[2].title).toBe('第4章')
    expect(after[3].title).toBe('第5章')
  })

  it('删除第 1 章后，所有后续章节号前移', () => {
    const chapters = store.listChapters(projectId)
    const ch1 = chapters.find((c) => c.chapterNumber === 1)!
    store.deleteChapter(ch1.id)
    const after = store.listChapters(projectId).sort((a, b) => a.chapterNumber - b.chapterNumber)
    expect(after.map((c) => c.chapterNumber)).toEqual([1, 2, 3, 4])
    expect(after[0].title).toBe('第2章')
  })

  it('删除末章（第 5 章）后，其他章节号不变', () => {
    const chapters = store.listChapters(projectId)
    const ch5 = chapters.find((c) => c.chapterNumber === 5)!
    store.deleteChapter(ch5.id)
    const after = store.listChapters(projectId).sort((a, b) => a.chapterNumber - b.chapterNumber)
    expect(after.map((c) => c.chapterNumber)).toEqual([1, 2, 3, 4])
  })

  it('删除章节时同步重排 markers.chapter', () => {
    const chapters = store.listChapters(projectId)
    const ch3 = chapters.find((c) => c.chapterNumber === 3)!
    // 在第 5 章放一个 marker
    store.createMarker({
      id: randomUUID(),
      projectId,
      chapter: 5,
      title: '测试标记',
      type: 'bookmark',
      color: 'blue',
      note: '',
      entityType: null,
      entityId: null,
    })
    store.deleteChapter(ch3.id)
    const markers = store.listMarkers(projectId)
    expect(markers).toHaveLength(1)
    expect(markers[0].chapter).toBe(4) // 5 → 4
  })

  it('删除章节时同步重排 conflict.chapter_spans', () => {
    const chapters = store.listChapters(projectId)
    const ch3 = chapters.find((c) => c.chapterNumber === 3)!
    // 创建一个跨度 [4, 5] 的冲突
    store.createConflict({
      id: randomUUID(),
      projectId,
      description: '冲突1',
      type: 'interest',
      intensity: 5,
      stage: 'latent',
      participants: '[]',
      chapterSpans: [[4, 5]],
      tier: 'secondary',
    })
    store.deleteChapter(ch3.id)
    const conflicts = store.listConflicts(projectId)
    expect(conflicts[0].chapterSpans).toEqual([[3, 4]]) // [4,5] - 1 = [3,4]
  })

  it('删除章节时同步重排 location.appear_chapters', () => {
    const chapters = store.listChapters(projectId)
    const ch3 = chapters.find((c) => c.chapterNumber === 3)!
    store.createLocation({
      id: randomUUID(),
      projectId,
      name: '酒馆',
      description: '',
      type: 'building',
      parentId: null,
      factionId: null,
      significance: 'minor',
      firstChapter: null,
      status: 'normal',
      appearChapters: [1, 3, 5],
    })
    store.deleteChapter(ch3.id)
    const locations = store.listLocations(projectId)
    expect(locations[0].appearChapters).toEqual([1, 4]) // 3 被移除，5 → 4
  })

  it('删除章节时同步重排伏笔事件链和兼容端点字段', () => {
    const ch3 = store.listChapters(projectId).find((c) => c.chapterNumber === 3)!
    store.createForeshadow({
      id: randomUUID(), projectId, description: '旧钥匙', category: 'item', status: 'planned',
      firstChapter: null, lastChapter: null, recoverByChapter: null, chapterSpans: [],
      beats: [
        { chapter: 1, type: 'plant' },
        { chapter: 3, type: 'reinforce' },
        { chapter: 5, type: 'payoff' },
      ],
    })

    store.deleteChapter(ch3.id)

    const foreshadow = store.listForeshadowing(projectId)[0]
    expect(foreshadow.beats).toEqual([
      { chapter: 1, type: 'plant' },
      { chapter: 4, type: 'payoff' },
    ])
    expect(foreshadow.firstChapter).toBe(1)
    // recoverByChapter 是"计划回收章"，不由 payoff beat 派生；本例从未设置计划，故为空。
    // 真实回收点由 beats 里的 payoff@4 表示（上面已断言）。
    expect(foreshadow.recoverByChapter).toBeNull()
  })

  it('删除伏笔埋设章时清空整条孤立事件链', () => {
    const ch1 = store.listChapters(projectId).find((c) => c.chapterNumber === 1)!
    store.createForeshadow({
      id: randomUUID(), projectId, description: '旧钥匙', category: 'item', status: 'planned',
      firstChapter: null, lastChapter: null, recoverByChapter: null, chapterSpans: [],
      beats: [
        { chapter: 1, type: 'plant' },
        { chapter: 3, type: 'reinforce' },
        { chapter: 5, type: 'payoff' },
      ],
    })

    store.deleteChapter(ch1.id)

    const foreshadow = store.listForeshadowing(projectId)[0]
    expect(foreshadow.beats).toEqual([])
    expect(foreshadow.firstChapter).toBeNull()
    expect(foreshadow.recoverByChapter).toBeNull()
    expect(foreshadow.status).toBe('planned')
  })

  it('删除伏笔回收章时保留此前节点并恢复为未回收', () => {
    const ch5 = store.listChapters(projectId).find((c) => c.chapterNumber === 5)!
    store.createForeshadow({
      id: randomUUID(), projectId, description: '旧钥匙', category: 'item', status: 'planned',
      firstChapter: null, lastChapter: null, recoverByChapter: null, chapterSpans: [],
      beats: [
        { chapter: 1, type: 'plant' },
        { chapter: 3, type: 'reinforce' },
        { chapter: 5, type: 'payoff' },
      ],
    })

    store.deleteChapter(ch5.id)

    const foreshadow = store.listForeshadowing(projectId)[0]
    expect(foreshadow.beats).toEqual([
      { chapter: 1, type: 'plant' },
      { chapter: 3, type: 'reinforce' },
    ])
    expect(foreshadow.recoverByChapter).toBeNull()
    expect(foreshadow.status).toBe('reinforced')
  })

  it('NOT NULL chapter_number 列（memory_events）等于被删章时删除行，不报约束错误', () => {
    const chapters = store.listChapters(projectId)
    const ch3 = chapters.find((c) => c.chapterNumber === 3)!
    // 直接插入两条 memory_events：一条 chapter_number=3（应被删除），一条=5（应 shift 为 4）
    const eventId1 = randomUUID()
    const eventId2 = randomUUID()
    db.prepare(
      `INSERT INTO novel_memory_events (id, project_id, chapter_id, chapter_number, event_type, entity_id, entity_type, description)
       VALUES (?, ?, NULL, ?, 'state_change', ?, 'character', '测试事件')`,
    ).run(eventId1, projectId, 3, 'char-1')
    db.prepare(
      `INSERT INTO novel_memory_events (id, project_id, chapter_id, chapter_number, event_type, entity_id, entity_type, description)
       VALUES (?, ?, NULL, ?, 'state_change', ?, 'character', '测试事件2')`,
    ).run(eventId2, projectId, 5, 'char-2')
    // 删除第 3 章：应触发 memory_events 重排
    store.deleteChapter(ch3.id)
    const remaining = db.prepare(
      'SELECT chapter_number FROM novel_memory_events WHERE project_id = ? ORDER BY chapter_number',
    ).all(projectId) as Array<{ chapter_number: number }>
    // eventId1（chapter_number=3）应被删除；eventId2（chapter_number=5）应 shift 为 4
    expect(remaining).toHaveLength(1)
    expect(remaining[0].chapter_number).toBe(4)
  })

  it('可空 chapter_number 列（character_history）等于被删章时置 NULL，保留行', () => {
    const chapters = store.listChapters(projectId)
    const ch3 = chapters.find((c) => c.chapterNumber === 3)!
    const historyId1 = randomUUID()
    const historyId2 = randomUUID()
    db.prepare(
      `INSERT INTO novel_character_history (id, project_id, character_id, chapter_number, field_name, old_value, new_value)
       VALUES (?, ?, ?, ?, 'arc_stage', 'introduction', 'rising')`,
    ).run(historyId1, projectId, 'char-1', 3)
    db.prepare(
      `INSERT INTO novel_character_history (id, project_id, character_id, chapter_number, field_name, old_value, new_value)
       VALUES (?, ?, ?, ?, 'arc_stage', 'rising', 'climax')`,
    ).run(historyId2, projectId, 'char-2', 5)
    store.deleteChapter(ch3.id)
    // 不依赖 UUID 排序，按 chapter_number 升序（NULL 在前）取值后断言
    const remaining = db.prepare(
      'SELECT chapter_number FROM novel_character_history WHERE project_id = ? ORDER BY chapter_number IS NULL DESC, chapter_number ASC',
    ).all(projectId) as Array<{ chapter_number: number | null }>
    // historyId1（chapter_number=3）应置 NULL；historyId2（chapter_number=5）应 shift 为 4
    expect(remaining).toHaveLength(2)
    expect(remaining[0].chapter_number).toBeNull()
    expect(remaining[1].chapter_number).toBe(4)
  })
})

describe('ChapterRenumberSpec - 边界场景补充', () => {
  it('单段跨度 [[2,4]] 删第 3 章 → [[2,3]]（被删章在跨度中段，start 不变 end -1）', () => {
    expect(shiftChapterSpans([[2, 4]], createChapterRenumberSpec(3))).toEqual([[2, 3]])
  })

  it('单段跨度 [[2,3]] 删第 3 章 → [[2,2]]（终点等于被删章，退化为单点）', () => {
    expect(shiftChapterSpans([[2, 3]], createChapterRenumberSpec(3))).toEqual([[2, 2]])
  })
})

describe('NovelStore.deleteChapter 事务原子性', () => {
  let db: Database.Database
  let store: NovelStore
  let projectId: string

  beforeEach(() => {
    db = createTestDb()
    store = new NovelStore(db)
    const project = store.createProject({
      id: randomUUID(),
      title: '测试项目',
      genre: 'test',
      synopsis: '',
      targetWords: 0,
      currentVolume: 1,
      currentChapter: 0,
      currentStage: 'setup',
      status: 'active',
    })
    projectId = project.id
    for (let i = 1; i <= 3; i++) {
      store.createChapter({
        id: randomUUID(),
        projectId,
        volume: 1,
        chapterNumber: i,
        title: `第${i}章`,
        content: '',
        wordCount: 0,
        status: 'planned',
        narrativeTask: '',
        acceptanceResult: null,
      })
    }
  })

  afterEach(() => db.close())

  it('renumberChapterReferences 抛错时整个 deleteChapter 回滚', () => {
    // 先在 conflicts 表中插入非法 chapter_spans JSON 制造错误
    db.prepare(
      `INSERT INTO novel_conflicts (id, project_id, description, type, intensity, stage, participants, tier, chapter_spans)
       VALUES (?, ?, '非法', 'interest', 5, 'latent', '[]', 'secondary', ?)`,
    ).run(randomUUID(), projectId, 'not-json')

    const chapters = store.listChapters(projectId)
    const ch2 = chapters.find((c) => c.chapterNumber === 2)!

    // deleteChapter 应抛错（renumber 时 JSON.parse 失败）
    expect(() => store.deleteChapter(ch2.id)).toThrow()

    // 验证回滚：章节未删除，第 3 章号未变
    const after = store.listChapters(projectId).sort((a, b) => a.chapterNumber - b.chapterNumber)
    expect(after).toHaveLength(3)
    expect(after.map((c) => c.chapterNumber)).toEqual([1, 2, 3])
  })
})
