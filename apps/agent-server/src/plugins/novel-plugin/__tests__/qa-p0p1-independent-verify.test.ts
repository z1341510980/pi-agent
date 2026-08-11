/**
 * QA 独立验证（非工程师自测）：P0+P1 关键验收口径的交叉验证。
 *
 * 独立于工程师的 context-section-metrics / scene-cast-merge / log-payload-store /
 * content-revision-store 测试，从「Flag 全关 = 现状一致」与「Flag 全开 = 新行为正确」
 * 两条主线做端到端验证，并核验迁移编号顺序在全新库上的列状态。
 *
 * 重点覆盖（对齐 PRD §4 验收口径）：
 * 1. Flag 全关：版本双写仍在、日志仍全量写主表、scene 仍写三表（现状不被破坏）
 * 2. versionChainV2Write 开启：真实 updateChapter 流程后旧表新增行 = 0，
 *    current_content_revision_id 指向版本与正文一致
 * 3. logPayloadExternalized 开启：主表大文本列空串、payload 表 gzip、详情可回读、
 *    cleanup 只删 payload 不删元数据
 * 4. sceneCastV2Write/Read 开启：focus/present/functional 往返一致、功能位不丢、
 *    三表停止新增、focus+present 去重规则
 * 5. 迁移顺序：新库 087a(087b)→088→089 后列状态正确（payload_id 存在、废弃列不存在、
 *    cast 表 CHECK 约束生效）
 */
import { describe, it, expect, beforeAll } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'
import type { NovelChapter } from '../core/types.js'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of novelMigrations) db.exec(migration.sql)
  return db
}

function dbOf(store: NovelStore): Database.Database {
  return (store as unknown as { db: Database.Database }).db
}

function setupProject(store: NovelStore, flags?: Record<string, boolean>): string {
  const projectId = randomUUID()
  store.createProject({
    id: projectId, title: 'qa', genre: 'qa', synopsis: '', outline: '',
    targetWords: 3000, currentVolume: 1, currentChapter: 1,
    currentStage: 'rising', status: 'active', flags,
  })
  return projectId
}

function setupChapter(store: NovelStore, projectId: string): NovelChapter {
  return store.createChapter({
    id: randomUUID(), projectId, volume: 1, chapterNumber: 1,
    title: '第一章', content: 'v0 正文', wordCount: 4,
    status: 'planned', narrativeTask: '', outline: '', volumeId: null,
    acceptanceResult: null, tension: null, positioning: null,
    timeOffset: null, chapterEndingHook: null, recap: null,
  })
}

/** 构造一条完整 Agent 日志入参 */
function makeLogInput(projectId: string, chapterNumber = 1) {
  return {
    projectId, chapterNumber, agentType: 'writer', agentName: 'w',
    displayAgentType: 'writer', displayAgentName: 'w', phase: 'writing',
    systemPrompt: '系统提示'.repeat(20),
    chapterContext: '上下文'.repeat(30),
    userMessage: '用户消息'.repeat(8),
    taskInput: '任务输入'.repeat(8),
    userInstructions: [{ text: '指令' }] as never[],
    tools: [{ name: 't', description: 'd' }] as never[],
    toolNames: ['t'],
    result: '结果'.repeat(20),
    resultLength: 40, durationMs: 5, status: 'success' as const, error: '',
    sessionId: 's', inputTokens: 10, outputTokens: 5, cacheReadTokens: 1,
    cacheWriteTokens: 0, llmProvider: 'p', llmModel: 'm',
    payloadMessagesChars: 1, payloadToolsChars: 1, payloadToolCount: 1,
    payloadTotalChars: 2, llmRoundTrips: 1,
    askStoryPolicy: 'legacy' as const, askStoryEnabled: true,
  }
}

describe('QA-1 Flag 全关 = 现状一致（回归不破坏旧行为）', () => {
  it('版本双写仍在：updateChapter 后 novel_chapter_versions 新增行', () => {
    const store = new NovelStore(createDb())
    const projectId = setupProject(store)
    const chapter = setupChapter(store, projectId)

    store.updateChapter(chapter.id, { content: 'v1 正文改版', wordCount: 6 })
    const db = dbOf(store)
    const oldRows = db.prepare(
      'SELECT COUNT(*) AS n FROM novel_chapter_versions WHERE chapter_id = ?',
    ).get(chapter.id) as { n: number }
    expect(oldRows.n).toBeGreaterThanOrEqual(1)
    // V2 链也在写（双写并存）
    const v2Rows = db.prepare(
      'SELECT COUNT(*) AS n FROM novel_chapter_content_revisions WHERE chapter_id = ?',
    ).get(chapter.id) as { n: number }
    expect(v2Rows.n).toBeGreaterThanOrEqual(1)
  })

  it('日志仍全量写主表：大文本列有值、payload 表无行', () => {
    const store = new NovelStore(createDb())
    const projectId = setupProject(store)
    store.insertAgentLog(makeLogInput(projectId))
    const db = dbOf(store)
    const main = db.prepare('SELECT system_prompt, chapter_context, payload_id FROM novel_agent_logs').get() as any
    expect(main.system_prompt.length).toBeGreaterThan(0)
    expect(main.chapter_context.length).toBeGreaterThan(0)
    expect(main.payload_id).toBeNull()
    const payloadCount = db.prepare('SELECT COUNT(*) AS n FROM novel_agent_log_payloads').get() as { n: number }
    expect(payloadCount.n).toBe(0)
  })

  it('scene 仍写三表：cast 表无行、三表有行', () => {
    const store = new NovelStore(createDb())
    const projectId = setupProject(store)
    const chapter = setupChapter(store, projectId)
    store.submitPlanWithScenes({
      chapterId: chapter.id, projectId,
      budget: { baseTarget: 3000, adjustmentPct: 0, resolvedTarget: 3000, min: 2550, max: 3450 },
      scenes: [{
        sceneKey: 's1', order: 1, title: '场景', goal: '目标', locationText: '地点',
        timeText: '当日', povMode: 'single', povCharacterId: 'c1',
        focusCharacterIds: ['c1'], presentCharacterIds: ['c1', 'c2'],
        functionalCast: [{ characterId: 'c3', function: '情报', prominence: 'brief' }],
        targetWords: 3000, progresses: [],
      }],
    })
    const db = dbOf(store)
    const cast = db.prepare('SELECT COUNT(*) AS n FROM novel_scene_cast').get() as { n: number }
    const focus = db.prepare('SELECT COUNT(*) AS n FROM novel_scene_focus').get() as { n: number }
    const present = db.prepare('SELECT COUNT(*) AS n FROM novel_scene_presence').get() as { n: number }
    const fn = db.prepare('SELECT COUNT(*) AS n FROM novel_scene_functions').get() as { n: number }
    expect(cast.n).toBe(0)
    expect(focus.n).toBe(1)
    expect(present.n).toBe(2)
    expect(fn.n).toBe(1)
  })
})

describe('QA-2 versionChainV2Write/Read 开启 = 新行为正确', () => {
  it('真实 updateChapter 流程：旧表新增行 = 0，current 指针正文与 novel_chapters.content 一致', () => {
    const store = new NovelStore(createDb())
    const projectId = setupProject(store, { versionChainV2Write: true, versionChainV2Read: true })
    const chapter = setupChapter(store, projectId)

    store.updateChapter(chapter.id, { content: 'v2 正文第二次修改', wordCount: 9 })
    store.updateChapter(chapter.id, { content: 'v3 正文第三次修改', wordCount: 12 })

    const db = dbOf(store)
    const oldRows = db.prepare(
      'SELECT COUNT(*) AS n FROM novel_chapter_versions WHERE chapter_id = ?',
    ).get(chapter.id) as { n: number }
    expect(oldRows.n).toBe(0) // P1-1-1：观察期内无写入

    const current = db.prepare(
      'SELECT content, current_content_revision_id FROM novel_chapters WHERE id = ?',
    ).get(chapter.id) as { content: string; current_content_revision_id: string | null }
    expect(current.current_content_revision_id).not.toBeNull()
    const revision = db.prepare(
      'SELECT content FROM novel_chapter_content_revisions WHERE id = ?',
    ).get(current.current_content_revision_id!) as { content: string }
    expect(revision.content).toBe(current.content) // P1-1-2：当前正文与指针一致

    // V2 读源：listChapterVersions 能读到 3 个版本（初始 + 2 次更新）
    const versions = store.listChapterVersions(chapter.id)
    expect(versions.length).toBeGreaterThanOrEqual(3)
    // 最新版是当前正文（getLatestVersion 返回完整对象含 content）
    const latest = store.getLatestVersion(chapter.id)
    expect(latest?.content).toBe(current.content)
  })

  it('reconcileVersionChains：纯双写期数据一致 → mismatch/orphan/duplicate 全 0', () => {
    const store = new NovelStore(createDb())
    const projectId = setupProject(store)
    const chapter = setupChapter(store, projectId)
    // 双写期（flag 关）：旧表快照 + V2 链同路径写入
    store.updateChapter(chapter.id, { content: '版本A', wordCount: 5 })
    store.updateChapter(chapter.id, { content: '版本B', wordCount: 5 })

    const report = store.reconcileVersionChains(projectId)
    expect(report.mismatchRows).toBe(0)
    expect(report.duplicateRows).toBe(0)
    expect(report.orphanRows).toBe(0)
    expect(report.rollbackVerified).toBe(false)
    expect(report.mismatchedChapters).toHaveLength(0)

    // 灰度开启 V2 写后：旧表行数冻结（不再新增）
    dbOf(store).prepare('UPDATE novel_projects SET feature_flags = ? WHERE id = ?')
      .run(JSON.stringify({ versionChainV2Write: true, versionChainV2Read: true }), projectId)
    const oldBefore = (dbOf(store).prepare(
      'SELECT COUNT(*) AS n FROM novel_chapter_versions WHERE chapter_id = ?',
    ).get(chapter.id) as { n: number }).n
    store.updateChapter(chapter.id, { content: '版本C', wordCount: 5 })
    const oldAfter = (dbOf(store).prepare(
      'SELECT COUNT(*) AS n FROM novel_chapter_versions WHERE chapter_id = ?',
    ).get(chapter.id) as { n: number }).n
    expect(oldAfter).toBe(oldBefore) // P1-1-1：停旧写后旧表冻结
    // 当前指针仍一致
    const current = dbOf(store).prepare(
      'SELECT content, current_content_revision_id FROM novel_chapters WHERE id = ?',
    ).get(chapter.id) as { content: string; current_content_revision_id: string | null }
    const revision = dbOf(store).prepare(
      'SELECT content FROM novel_chapter_content_revisions WHERE id = ?',
    ).get(current.current_content_revision_id!) as { content: string }
    expect(revision.content).toBe(current.content)
  })
})

describe('QA-3 logPayloadExternalized 开启 = 冷热分离正确', () => {
  it('主表瘦身 + payload gzip + 详情兼容 + cleanup 保留策略', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = setupProject(store, { logPayloadExternalized: true })
    const log = store.insertAgentLog(makeLogInput(projectId))

    const main = db.prepare(
      'SELECT system_prompt, chapter_context, user_message, task_input, result, error, payload_id FROM novel_agent_logs WHERE id = ?',
    ).get(log.id) as any
    for (const col of ['system_prompt', 'chapter_context', 'user_message', 'task_input', 'result', 'error']) {
      expect(main[col]).toBe('') // 主表大文本不再写入
    }
    expect(main.payload_id).toBe(log.id)

    const payload = db.prepare(
      'SELECT compression, system_prompt_blob, content_hash, expires_at FROM novel_agent_log_payloads WHERE agent_log_id = ?',
    ).get(log.id) as any
    expect(payload.compression).toBe('gzip')
    expect(payload.system_prompt_blob).toBeInstanceOf(Buffer)
    expect(payload.content_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(payload.expires_at).toBeGreaterThan(0)

    // 读取兼容：默认 loadPayload=true → 字段与迁移前一致
    const detail = store.getAgentLog(log.id)!
    expect(detail.systemPrompt).toBe('系统提示'.repeat(20))
    expect(detail.chapterContext).toBe('上下文'.repeat(30))
    expect(detail.userMessage).toBe('用户消息'.repeat(8))
    expect(detail.result).toBe('结果'.repeat(20))

    // cleanup：过期 payload 删除，元数据保留
    db.prepare('UPDATE novel_agent_log_payloads SET expires_at = 1 WHERE agent_log_id = ?').run(log.id)
    const cleaned = store.cleanupExpiredPayloads(Date.now())
    expect(cleaned.deleted).toBe(1)
    const mainStill = db.prepare('SELECT id FROM novel_agent_logs WHERE id = ?').get(log.id)
    expect(mainStill).toBeTruthy()
  })
})

describe('QA-4 sceneCastV2Write/Read 开启 = 三表合并正确', () => {
  it('停旧写 + cast 主写：三表停止新增，往返一致、功能位不丢、focus 优先去重', () => {
    const store = new NovelStore(createDb())
    const projectId = setupProject(store, { sceneCastV2Write: true, sceneCastV2Read: true })
    const chapter = setupChapter(store, projectId)
    const { scenes } = store.submitPlanWithScenes({
      chapterId: chapter.id, projectId,
      budget: { baseTarget: 3000, adjustmentPct: 0, resolvedTarget: 3000, min: 2550, max: 3450 },
      scenes: [{
        sceneKey: 's1', order: 1, title: '场景', goal: '目标', locationText: '地点',
        timeText: '当日', povMode: 'single', povCharacterId: 'c1',
        focusCharacterIds: ['c1'], presentCharacterIds: ['c1', 'c2'],
        functionalCast: [{ characterId: 'c3', function: '传递情报', prominence: 'lead' }],
        targetWords: 3000, progresses: [],
      }],
    })

    const db = dbOf(store)
    // P1-3-4：三表停止新增
    expect((db.prepare('SELECT COUNT(*) AS n FROM novel_scene_focus').get() as { n: number }).n).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM novel_scene_presence').get() as { n: number }).n).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM novel_scene_functions').get() as { n: number }).n).toBe(0)

    // 往返一致：读 cast 表
    const cast = store.getSceneRevisionCast(scenes[0].id)
    expect(cast.focus).toEqual(['c1'])
    expect(cast.present).toEqual(['c2']) // c1 已在 focus，present 排除（去重规则）
    expect(cast.functions).toEqual([
      { characterId: 'c3', function: '传递情报', prominence: 'lead', note: '' },
    ])

    // 数据层保真：getSceneCast 原样返回 focus+present 并存
    const raw = store.getSceneCast(scenes[0].id)
    const c1Roles = raw.filter((r) => r.characterId === 'c1').map((r) => r.role)
    expect(c1Roles).toContain('focus')
    expect(c1Roles).toContain('present')
  })

  it('sceneCastV2Write + scenePlanV2DualWrite：影子写对账 mismatch=0（P1-3-3）', () => {
    const store = new NovelStore(createDb())
    const projectId = setupProject(store, {
      sceneCastV2Write: true,
      scenePlanV2DualWrite: true,
    })
    const chapter = setupChapter(store, projectId)
    store.submitPlanWithScenes({
      chapterId: chapter.id, projectId,
      budget: { baseTarget: 3000, adjustmentPct: 0, resolvedTarget: 3000, min: 2550, max: 3450 },
      scenes: [{
        sceneKey: 's1', order: 1, title: '场景', goal: '目标', locationText: '地点',
        timeText: '当日', povMode: 'single', povCharacterId: 'c1',
        focusCharacterIds: ['c1'], presentCharacterIds: ['c2'],
        functionalCast: [{ characterId: 'c3', function: '情报', prominence: 'brief' }],
        targetWords: 3000, progresses: [],
      }],
    })
    // 双写期：三表与 cast 同时有数据，往返一致
    const db = dbOf(store)
    expect((db.prepare('SELECT COUNT(*) AS n FROM novel_scene_focus').get() as { n: number }).n).toBe(1)
    expect((db.prepare('SELECT COUNT(*) AS n FROM novel_scene_cast').get() as { n: number }).n).toBeGreaterThan(0)
    const report = store.reconcileSceneCast(projectId)
    expect(report.mismatchRows).toBe(0)
    expect(report.mismatchByRole).toEqual({ focus: 0, present: 0, functional: 0 })
    expect(report.checkedSceneRevisions).toBeGreaterThanOrEqual(1)
  })
})

describe('QA-5 迁移编号顺序：新库 087a/087b→088→089 列状态正确', () => {
  let db: Database.Database
  beforeAll(() => {
    db = createDb() // 顺序执行全部 novelMigrations（含 087/088/089）
  })

  it('087a：novel_agent_logs 有 payload_id，novel_agent_log_payloads 存在', () => {
    const logCols = db.prepare('PRAGMA table_info(novel_agent_logs)').all().map((c: any) => c.name)
    expect(logCols).toContain('payload_id')
    const payloadCols = db.prepare('PRAGMA table_info(novel_agent_log_payloads)').all().map((c: any) => c.name)
    expect(payloadCols).toEqual(expect.arrayContaining([
      'id', 'agent_log_id', 'compression', 'system_prompt_blob', 'chapter_context_blob',
      'user_message_blob', 'task_input_blob', 'user_instructions_blob', 'tools_blob',
      'result_blob', 'error_blob', 'content_hash', 'expires_at', 'created_at',
    ]))
  })

  it('087b：novel_context_section_metrics 存在且含六类所需列', () => {
    const cols = db.prepare('PRAGMA table_info(novel_context_section_metrics)').all().map((c: any) => c.name)
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'agent_log_id', 'project_id', 'chapter_number', 'agent_type',
      'section_type', 'section_id', 'chars', 'estimated_tokens', 'source_hash', 'mode', 'created_at',
    ]))
  })

  it('088：novel_scene_cast 存在，CHECK 约束生效（非法 role / functional 缺 function 被拒）', () => {
    const cols = db.prepare('PRAGMA table_info(novel_scene_cast)').all().map((c: any) => c.name)
    expect(cols).toEqual(expect.arrayContaining([
      'scene_revision_id', 'character_id', 'role', 'function', 'prominence', 'note',
    ]))
    // 通过 store 真实创建 scene revision（父行齐全，满足外键）
    const store = new NovelStore(db)
    const projectId = setupProject(store)
    const chapter = setupChapter(store, projectId)
    const { scenes } = store.submitPlanWithScenes({
      chapterId: chapter.id, projectId,
      budget: { baseTarget: 3000, adjustmentPct: 0, resolvedTarget: 3000, min: 2550, max: 3450 },
      scenes: [{
        sceneKey: 's1', order: 1, title: '场景', goal: '目标', locationText: '地点',
        timeText: '当日', povMode: 'single', povCharacterId: 'c1',
        focusCharacterIds: ['c1'], presentCharacterIds: [],
        functionalCast: [], targetWords: 3000, progresses: [],
      }],
    })
    const revisionId = scenes[0].id
    const rawDb = dbOf(store)
    // 合法行可插入
    rawDb.prepare('INSERT INTO novel_scene_cast (scene_revision_id, character_id, role, function, prominence, note) VALUES (?, ?, ?, ?, ?, ?)')
      .run(revisionId, 'c1', 'focus', null, null, null)
    // 非法 role → CHECK 失败
    expect(() => rawDb.prepare(
      'INSERT INTO novel_scene_cast (scene_revision_id, character_id, role) VALUES (?, ?, ?)',
    ).run(revisionId, 'c9', 'bad-role')).toThrow()
    // functional 无 function → CHECK 失败
    expect(() => rawDb.prepare(
      'INSERT INTO novel_scene_cast (scene_revision_id, character_id, role) VALUES (?, ?, ?)',
    ).run(revisionId, 'c8', 'functional')).toThrow()
  })

  it('089：novel_conflicts / novel_factions 不再含 first_chapter / last_chapter', () => {
    for (const table of ['novel_conflicts', 'novel_factions']) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c: any) => c.name)
      expect(cols).not.toContain('first_chapter')
      expect(cols).not.toContain('last_chapter')
      expect(cols).toContain('chapter_spans') // 兜底列仍在
    }
  })

  it('089 后写路径：conflict/faction 可正常创建（不引用废弃列）', () => {
    const store = new NovelStore(db)
    const projectId = setupProject(store)
    const conflict = store.createConflict({
      id: randomUUID(), projectId, description: '描述',
      type: 'interest', intensity: 5, stage: 'latent',
      participants: '[]', chapterSpans: [[1, 2]],
      tier: 'secondary', plotFunction: 'amplify_conflict', progressionMode: 'linear',
    })
    expect(conflict.id).toBeTruthy()
    const faction = store.createFaction({
      id: randomUUID(), projectId, name: '势力', description: '',
      type: 'sect', leaderId: null, ideology: '',
      strength: 'medium', resources: [], allies: [], enemies: [], status: 'active',
      chapterSpans: [[1, 2]],
    })
    expect(faction.id).toBeTruthy()
    // 读回：chapterSpans 仍在（可推导出场区间）
    const loaded = store.getConflict(conflict.id)
    expect(loaded?.chapterSpans).toEqual([[1, 2]])
  })
})
