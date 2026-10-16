import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { novelMigrations } from '../novel-migrations.js'
import { NovelMemoryStore } from '../core/novel-memory-store.js'
import { NovelPromptBuilder } from '../core/prompting/prompt-builder.js'
import { NovelStore } from '../core/novel-store.js'

function promptStores(store: NovelStore) {
  return {
    getProject: (id: string) => store.getProject(id),
    getChapter: (id: string, chapter: number) => store.getChapter(id, chapter),
    listRecentChapters: (id: string, limit: number) => store.listRecentChapters(id, limit),
    listCharacters: (id: string) => store.listCharacters(id),
    listRelationships: (id: string) => store.listRelationships(id),
    listConflicts: (id: string) => store.listConflicts(id),
    listForeshadowing: (id: string) => store.listForeshadowing(id),
    listClues: (id: string) => store.listClues(id),
    listFactions: (id: string) => store.listFactions(id),
    listLocations: (id: string) => store.listLocations(id),
    listItems: (id: string) => store.listItems(id),
    listWorldElements: (id: string) => store.listWorldElements(id),
    listInformationLayers: (id: string) => store.listInformationLayers(id),
    listEdges: (id: string) => store.listEdges(id),
  }
}

/**
 * 章节边界上下文的快照选取回归：
 * - 历史快照被时间线重建/后续章节打成 stale 后仍必须可用（否则重写旧章节时
 *   回退到实体表当前全局状态，把未来章节的事实注入进过去——矩阵穿越）；
 * - 时间线重建写入的重放摘要行（kind:'timeline_rebuild'）不是实体状态，必须跳过；
 * - 无任何快照回退时必须标记 stateAheadOfBoundary，让上下文附带越界警告。
 */
function createBuilder(db: Database.Database): NovelPromptBuilder {
  const store = new NovelStore(db)
  const memoryStore = new NovelMemoryStore(db)
  const promptManager = {
    getSystemPrompt: () => '',
    getAgentPrompt: () => '',
    listTemplates: () => [],
  } as never
  return new NovelPromptBuilder(promptManager, promptStores(store) as never, memoryStore as never)
}

describe('getChapterBoundaryContext 快照选取', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    for (const migration of novelMigrations) db.exec(migration.sql)
    const store = new NovelStore(db)
    store.createProject({
      id: 'p1', title: '测试', genre: '玄幻', synopsis: '', outline: '', targetWords: 0,
      currentVolume: 1, currentChapter: 4, currentStage: 'rising', status: 'active',
    })
    // 第 3 章已有正文（最新写入），第 2 章待重写
    store.createChapter({
      id: 'ch3', projectId: 'p1', volume: 1, chapterNumber: 3, title: '', content: '第三章正文',
      wordCount: 5, status: 'drafted', narrativeTask: '',
    } as never)
    store.createChapter({
      id: 'ch2', projectId: 'p1', volume: 1, chapterNumber: 2, title: '', content: '',
      wordCount: 0, status: 'planned', narrativeTask: '',
    } as never)
    // 实体表当前态是"未来"（第3章之后）
    db.prepare(`INSERT INTO novel_characters (id, project_id, name, identity, current_state) VALUES ('cx', 'p1', '叶明远', '主角', '已被带入据点（未来状态）')`).run()
  })

  function saveFullSnapshot(chapterNumber: number, data: unknown, createdAtSeconds: number): void {
    db.prepare(`
      INSERT INTO novel_memory_snapshots (id, project_id, chapter_number, snapshot_type, entity_id, snapshot_data, status, created_at)
      VALUES (?, 'p1', ?, 'full', NULL, ?, 'active', ?)
    `).run(randomUUID(), chapterNumber, JSON.stringify(data), createdAtSeconds)
  }

  const entitySnapshot = {
    characters: [{ id: 'c1', name: '叶明远', currentState: '困在废墟（第2章末历史状态）' }],
    relationships: [], conflicts: [], foreshadowing: [], clues: [],
    factions: [], locations: [], items: [], worldElements: [], informationLayers: [], edges: [],
  }

  it('stale 的历史 full 快照仍作为边界来源（不被 active 过滤丢弃）', () => {
    saveFullSnapshot(1, entitySnapshot, 1000)
    db.prepare(`UPDATE novel_memory_snapshots SET status = 'stale' WHERE project_id = 'p1'`).run()

    const boundary = createBuilder(db).getChapterBoundaryContext('p1', 2)
    expect(boundary.fromSnapshot).toBe(true)
    expect(boundary.stateAheadOfBoundary).toBe(false)
    expect(boundary.state.characters[0]).toMatchObject({ currentState: '困在废墟（第2章末历史状态）' })
  })

  it('timeline_rebuild 重放摘要行被跳过，选到真实实体快照', () => {
    saveFullSnapshot(1, entitySnapshot, 1000)
    // 更晚写入的重放摘要行（active、created_at 更大）
    db.prepare(`
      INSERT INTO novel_memory_snapshots (id, project_id, chapter_number, snapshot_type, entity_id, snapshot_data, status, created_at)
      VALUES (?, 'p1', 1, 'full', NULL, ?, 'active', 2000)
    `).run(randomUUID(), JSON.stringify({ kind: 'timeline_rebuild', jobId: 'j1', summary: '', proposedChanges: {} }))
    db.prepare(`UPDATE novel_memory_snapshots SET status = 'stale' WHERE project_id = 'p1'`).run()

    const boundary = createBuilder(db).getChapterBoundaryContext('p1', 2)
    expect(boundary.fromSnapshot).toBe(true)
    expect(boundary.state.characters[0]).toMatchObject({ currentState: '困在废墟（第2章末历史状态）' })
  })

  it('无任何快照时回退当前态并标记 stateAheadOfBoundary', () => {
    const boundary = createBuilder(db).getChapterBoundaryContext('p1', 2)
    expect(boundary.fromSnapshot).toBe(false)
    expect(boundary.stateAheadOfBoundary).toBe(true)
    expect(boundary.state.characters[0]).toMatchObject({ currentState: '已被带入据点（未来状态）' })

    const warning = (createBuilder(db) as never as { buildStoryStateChunk: (b: unknown, o?: unknown) => string })
      .buildStoryStateChunk(boundary, {})
    expect(warning).toContain('状态边界警告')
    expect(warning).toContain('以「用户章纲」和「本章叙事任务」为准')
  })

  it('顺序写下一章（第4章）时回退不标记越界', () => {
    // 第1~3章已写、无任何快照：写第4章时全局当前态 ≈ 第3章末，属正常来源
    const boundary = createBuilder(db).getChapterBoundaryContext('p1', 4)
    expect(boundary.fromSnapshot).toBe(false)
    expect(boundary.stateAheadOfBoundary).toBe(false)
  })
})
