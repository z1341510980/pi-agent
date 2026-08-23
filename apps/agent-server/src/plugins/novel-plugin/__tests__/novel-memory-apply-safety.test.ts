/**
 * Memory applyChanges 安全性回归（2026-08-11 生成链路专项审查）：
 * 1. characterCreates 按名查重：同名角色合并为更新，不产生重复角色；
 *    近似名（包含关系）仍各自独立；结构字段 plotRole 不被合并覆盖。
 * 2. applyChanges 事务化：批内任一写入失败整体回滚，不留半成品。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelStore } from '../core/novel-store.js'
import { NovelMemoryGenerator } from '../core/generation/novel-memory-generator.js'
import { MemoryOperationLedger } from '../core/memory/memory-operation-ledger.js'
import { novelMigrations } from '../novel-migrations.js'
import type { NovelCharacter } from '../core/types.js'

const PROJECT_ID = 'proj-memory-apply-safety'

function baseCharacter(
  name: string,
  overrides: Partial<Omit<NovelCharacter, 'id' | 'projectId'>> = {},
): Omit<NovelCharacter, 'createdAt' | 'updatedAt'> {
  return {
    id: randomUUID(),
    projectId: PROJECT_ID,
    name,
    description: '原描述',
    identity: '原身份',
    personality: '原性格',
    appearance: '原外貌',
    currentState: '原状态',
    currentGoal: '原目标',
    currentPressure: '原压力',
    secret: '原秘密',
    arcStage: 'introduction',
    arcHistory: '[]',
    speechStyle: '原口吻',
    isProtagonist: false,
    longTermDesire: '原欲望',
    plotRole: 'supporting' as const,
    removalImpact: '原影响',
    ...overrides,
  }
}

describe('Memory applyChanges - characterCreates 查重与事务化', () => {
  let db: Database.Database
  let store: NovelStore
  let generator: NovelMemoryGenerator

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    for (const m of novelMigrations) db.exec(m.sql)
    store = new NovelStore(db)
    store.createProject({
      id: PROJECT_ID, title: '安全回归', genre: 't', synopsis: '', outline: '',
      targetWords: 0, currentVolume: 1, currentChapter: 1,
      currentStage: 'setup', status: 'active',
    })
    const context = { logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
    generator = new NovelMemoryGenerator({} as never, {} as never, context as never, store, {} as never)
  })

  afterEach(() => db.close())

  it('同名角色重复提交：合并为更新，不产生重复角色', () => {
    store.createCharacter(baseCharacter('林晚', { currentState: '在城中' }))

    const stats = (generator as any).applyChanges(PROJECT_ID, {
      characterCreates: [{
        name: '林晚',
        currentState: '已逃出城',
        currentGoal: '追查旧案',
        description: '', // 空串不应覆盖原描述
      }],
    }, 2)

    const characters = store.listCharacters(PROJECT_ID)
    expect(characters).toHaveLength(1) // 没有产生第二个"林晚"
    expect(characters[0].currentState).toBe('已逃出城')
    expect(characters[0].currentGoal).toBe('追查旧案')
    expect(characters[0].description).toBe('原描述') // 空串保留现值
    expect(stats.characterCreatesApplied).toBe(0)
    expect(stats.characterCreatesDeduped).toBe(1)
  })

  it('近似名（包含关系）不合并：林晚 vs 林晚儿 各自独立', () => {
    store.createCharacter(baseCharacter('林晚儿'))

    const stats = (generator as any).applyChanges(PROJECT_ID, {
      characterCreates: [{ name: '林晚', currentState: '新角色' }],
    }, 2)

    const characters = store.listCharacters(PROJECT_ID)
    expect(characters).toHaveLength(2)
    expect(stats.characterCreatesApplied).toBe(1)
    expect(stats.characterCreatesDeduped).toBe(0)
  })

  it('合并路径不覆盖结构字段 plotRole（防止误降级主角）', () => {
    store.createCharacter(baseCharacter('林晚', { plotRole: 'protagonist', isProtagonist: true }))

    ;(generator as any).applyChanges(PROJECT_ID, {
      characterCreates: [{ name: '林晚', plotRole: 'background', currentState: '新状态' }],
    }, 2)

    const character = store.listCharacters(PROJECT_ID)[0]
    expect(character.plotRole).toBe('protagonist')
    expect(character.isProtagonist).toBe(true)
    expect(character.currentState).toBe('新状态')
  })

  it('同一 payload 内重复创建同名角色：第二条并入第一条创建的角色', () => {
    const stats = (generator as any).applyChanges(PROJECT_ID, {
      characterCreates: [
        { name: '陈三', currentState: '第一版状态' },
        { name: '陈三', currentState: '第二版状态' },
      ],
    }, 2)

    const characters = store.listCharacters(PROJECT_ID)
    expect(characters).toHaveLength(1)
    expect(characters[0].currentState).toBe('第二版状态')
    expect(stats.characterCreatesApplied).toBe(1)
    expect(stats.characterCreatesDeduped).toBe(1)
  })

  it('同一 payload 新建的角色可立即成为物品持有者和关系端点', () => {
    store.createCharacter(baseCharacter('林晚'))

    const stats = (generator as any).applyChanges(PROJECT_ID, {
      characterCreates: [{ name: '陆川' }],
      itemCreates: [{ name: '钟楼残页', type: 'info', ownerName: '陆川' }],
      relationshipCreates: [{ characterA: '林晚', characterB: '陆川', relationType: '同盟' }],
    }, 2)

    const createdCharacter = store.listCharacters(PROJECT_ID).find(character => character.name === '陆川')
    const createdItem = store.listItems(PROJECT_ID).find(item => item.name === '钟楼残页')
    const relationship = store.listRelationships(PROJECT_ID)[0]
    expect(createdItem?.ownerId).toBe(createdCharacter?.id)
    expect(new Set([relationship.characterA, relationship.characterB])).toEqual(
      new Set([store.listCharacters(PROJECT_ID).find(character => character.name === '林晚')?.id, createdCharacter?.id]),
    )
    expect(stats).toMatchObject({
      characterCreatesApplied: 1,
      itemCreatesApplied: 1,
      relationshipCreatesApplied: 1,
    })
    expect(db.prepare(`
      SELECT target_type
      FROM novel_memory_operations
      ORDER BY seq
    `).all()).toEqual([
      { target_type: 'character' },
      { target_type: 'item' },
      { target_type: 'relationship' },
    ])
  })

  it('同名角色合并也写入 update 审计，且快照只包含实际改动字段', () => {
    store.createCharacter(baseCharacter('林晚', { currentState: '原状态' }))

    ;(generator as any).applyChanges(PROJECT_ID, {
      characterCreates: [{ name: '林晚', currentState: '新状态' }],
    }, 2)

    const operation = db.prepare(`
      SELECT operation, target_type, before_json, after_json
      FROM novel_memory_operations
      WHERE operation = 'update'
    `).get() as any
    expect(operation).toMatchObject({ operation: 'update', target_type: 'character' })
    expect(JSON.parse(operation.before_json)).toEqual({ currentState: '原状态' })
    expect(JSON.parse(operation.after_json)).toEqual({ currentState: '新状态' })
  })

  it('批内写入失败整体回滚：角色更新不残留（事务化回归）', () => {
    store.createCharacter(baseCharacter('林晚', { currentState: '原状态' }))
    store.createForeshadow({
      id: randomUUID(),
      projectId: PROJECT_ID,
      description: '旧钥匙',
      category: 'item',
      status: 'planted',
      firstChapter: null,
      lastChapter: null,
      recoverByChapter: null,
      chapterSpans: [],
      beats: [],
    })
    // 让伏笔更新抛错：此时角色更新已先行执行，若无事务则残留半成品
    const spy = vi.spyOn(store, 'updateForeshadow').mockImplementation(() => {
      throw new Error('模拟写入失败')
    })

    expect(() => (generator as any).applyChanges(PROJECT_ID, {
      characterUpdates: [{ name: '林晚', currentState: '被更新的状态' }],
      foreshadowUpdates: [{ description: '旧钥匙', status: 'reinforced' }],
    }, 2)).toThrow('模拟写入失败')

    spy.mockRestore()
    const character = store.listCharacters(PROJECT_ID)[0]
    expect(character.currentState).toBe('原状态') // 已回滚，不残留
  })
})

describe('Memory 操作审计（T02-6，2026-08-12 逻辑统一：恒开启）', () => {
  let db: Database.Database
  let store: NovelStore
  let generator: NovelMemoryGenerator

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    for (const m of novelMigrations) db.exec(m.sql)
    store = new NovelStore(db)
    store.createProject({
      id: PROJECT_ID, title: '审计回归', genre: 't', synopsis: '', outline: '',
      targetWords: 0, currentVolume: 1, currentChapter: 1,
      currentStage: 'setup', status: 'active',
    })
    const context = { logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
    generator = new NovelMemoryGenerator({} as never, {} as never, context as never, store, {} as never)
  })

  afterEach(() => db.close())

  it('默认即审计：applyChanges 写 run committed + operation 记录（create/update/link 三类）', () => {
    store.createCharacter(baseCharacter('林晚'))
    const stats = (generator as any).applyChanges(PROJECT_ID, {
      characterUpdates: [{ name: '林晚', currentState: '被审计更新' }],
      foreshadowCreates: [{
        description: '审计伏笔', category: 'event', linkedCharacters: ['林晚'],
        importance: 'major', narrativeRole: 'dark_line',
        hiddenQuestion: '这把旧钥匙指向哪个未解真相', plannedPayoff: '第三卷揭示钥匙来源',
      }],
    }, 2)
    expect(stats.foreshadowCreatesApplied).toBe(1) // 前置断言：伏笔确实被创建

    const run = db.prepare('SELECT * FROM novel_memory_operation_runs').get() as any
    expect(run.status).toBe('committed')
    expect(run.project_id).toBe(PROJECT_ID)
    const ops = db.prepare('SELECT * FROM novel_memory_operations ORDER BY seq').all() as any[]
    expect(ops.map((op) => [op.target_type, op.operation])).toEqual([
      ['character', 'update'],
      ['foreshadow', 'create'],
      ['foreshadow', 'link'],
    ])
    // 实体更新确实生效
    expect(store.listCharacters(PROJECT_ID)[0].currentState).toBe('被审计更新')
  })

  it('更新审计记录 Store 归一化后的最终值，而非请求 patch', () => {
    store.createClue({
      id: 'clue-normalized-audit', projectId: PROJECT_ID,
      description: '钟楼残页', pointsTo: '旧港钟楼', progress: 10,
      currentStep: '核对纸张', nextStep: '寻找缺页', isMisleading: false,
      chapterSpans: [[1, 1]],
    })

    ;(generator as any).applyChanges(PROJECT_ID, {
      clueUpdates: [{ description: '钟楼残页', progress: 30 }],
    }, 2)

    const operation = db.prepare(`
      SELECT before_json, after_json
      FROM novel_memory_operations
      WHERE target_type = 'clue' AND operation = 'update'
    `).get() as { before_json: string; after_json: string }
    expect(JSON.parse(operation.before_json)).toEqual({
      progress: 10,
      chapterSpans: [[1, 1]],
    })
    expect(JSON.parse(operation.after_json)).toEqual({
      progress: 30,
      chapterSpans: [[1, 1]],
    })
  })

  it('所有 Memory 实体写入都记录对应的操作类型', () => {
    const linWan = store.createCharacter(baseCharacter('林晚'))
    const luChuan = store.createCharacter(baseCharacter('陆川'))
    const suYao = store.createCharacter(baseCharacter('苏遥'))
    store.createFaction({
      id: 'faction-audit', projectId: PROJECT_ID, name: '观星会', description: '', type: 'organization',
      leaderId: null, ideology: '', strength: 'medium', resources: [], allies: [], enemies: [],
      status: 'active', chapterSpans: [],
    })
    store.createLocation({
      id: 'location-audit', projectId: PROJECT_ID, name: '旧港', description: '', type: 'city',
      parentId: null, factionId: null, significance: 'major', firstChapter: 1,
      status: 'normal', appearChapters: [1],
    })
    store.createItem({
      id: 'item-audit', projectId: PROJECT_ID, name: '铜钥匙', description: '', type: 'key',
      ownerId: null, status: 'active', abilities: '', origin: '', firstChapter: 1, chapterSpans: [[1, 1]],
    })
    store.createRelationship({
      id: 'relationship-audit', projectId: PROJECT_ID,
      characterA: linWan.id, characterB: luChuan.id,
      relationType: '同盟', currentStage: '试探', stageHistory: '[]', dynamicRole: '',
      alignment: 'temporary_ally', trend: 'stable', chapterHint: '', lastUpdatedChapter: 1,
    })
    store.createHook({
      id: 'hook-audit', projectId: PROJECT_ID, chapterNumber: 1,
      hookType: 'suspense', description: '钟声为何提前响起', status: 'thrown',
      fulfilledAtChapter: null, fulfilledDescription: null,
    })
    store.createCharacterArc({
      id: 'arc-audit-existing', projectId: PROJECT_ID, characterId: linWan.id,
      arcType: 'growth', currentStage: 'denial', stageHistory: [], description: null,
    })
    store.createNarrative({
      projectId: PROJECT_ID, description: '追查旧港失踪案', type: 'advance',
      chapterSpans: [[1, 1]], status: 'active',
    })
    const chapter = store.createChapter({
      id: 'chapter-audit-2', projectId: PROJECT_ID, volume: 1, chapterNumber: 2,
      title: '旧港钟声', content: '', wordCount: 0, status: 'planned',
      narrativeTask: '', outline: '', volumeId: null, acceptanceResult: null,
    })
    const plan = store.createPlanRevision({
      chapterId: chapter.id, projectId: PROJECT_ID, positioning: 'advancement',
      budget: { baseTarget: 3000, adjustmentPct: 0, resolvedTarget: 3000, min: 2550, max: 3450 },
    })
    store.createSceneRevisions(plan, [{
      sceneKey: 'audit-scene', order: 1, title: '钟楼会面', goal: '交换线索',
      locationText: '旧港钟楼', timeText: '深夜', povMode: 'single', povCharacterId: linWan.id,
      focusCharacterIds: [linWan.id], presentCharacterIds: [luChuan.id], functionalCast: [],
      targetWords: 3000, progresses: [],
    }])
    store.transitionPlan(plan.id, 'approved', 'draft')

    ;(generator as any).applyChanges(PROJECT_ID, {
      conflictCreates: [{ description: '观星会封锁旧港', participants: ['林晚', '陆川'] }],
      narrativeUpdates: [{ description: '追查旧港失踪案', status: 'resolved' }],
      narrativeCreates: [{ description: '追查提前响起的钟声', type: 'advance' }],
      factionUpdates: [{ name: '观星会', strength: 'weak' }],
      locationUpdates: [{ name: '旧港', status: 'sealed' }],
      itemUpdates: [{ name: '铜钥匙', ownerName: '林晚', status: 'transferred' }],
      itemCreates: [{ name: '钟楼残页', type: 'info', ownerName: '陆川' }],
      relationshipUpdates: [{
        characterA: '林晚', characterB: '陆川', currentStage: '互信', alignment: 'ally', trend: 'warming',
      }],
      hookUpdates: [{ hookId: 'hook-audit', status: 'fulfilled', fulfilledDescription: '苏遥拨快了钟表' }],
      arcStageChanges: [
        { characterId: linWan.id, newStage: 'acceptance', triggerEvent: '承认判断失误' },
        { characterId: suYao.id, arcType: 'redemption', newStage: 'confession', triggerEvent: '说出真相' },
      ],
      storylineProgresses: [{
        storylineName: '旧港谜案', type: 'advance', primary: true,
        beforeState: '无从下手', afterState: '锁定钟楼', summary: '找到第一处入口',
      }],
    }, 2)

    const operations = db.prepare(`
      SELECT operation, target_type
      FROM novel_memory_operations
      ORDER BY seq
    `).all() as Array<{ operation: string; target_type: string }>
    const recorded = new Set(operations.map(op => `${op.target_type}:${op.operation}`))

    const expectedOperations = [
      'entity_candidate:create',
      'narrative:create',
      'narrative:update',
      'faction:update',
      'location:update',
      'item:create',
      'item:update',
      'relationship:update',
      'hook:update',
      'character_arc:create',
      'character_arc:update',
      'character:update',
      'storyline_progress:create',
      'storyline_progress:update',
    ]
    for (const expectedOperation of expectedOperations) {
      expect(recorded.has(expectedOperation), expectedOperation).toBe(true)
    }

    const retryStats = (generator as any).applyChanges(PROJECT_ID, {
      storylineProgresses: [{
        storylineName: '旧港谜案', type: 'advance', primary: true,
        beforeState: '无从下手', afterState: '锁定钟楼', summary: '找到第一处入口',
      }],
    }, 2)
    expect(retryStats.storylineProgressesApplied).toBe(0)
    expect(db.prepare(`
      SELECT COUNT(*) AS n
      FROM novel_memory_operations
      WHERE run_id = (SELECT id FROM novel_memory_operation_runs ORDER BY rowid DESC LIMIT 1)
    `).get()).toEqual({ n: 0 })

    const sceneRevision = store.listSceneRevisionsByPlan(plan.id)[0]
    store.recordProgressForScene(PROJECT_ID, sceneRevision.id, [{
      storylineName: '苏遥赎罪线', type: 'setup', beforeState: '隐瞒', afterState: '动摇',
    }], 'planned')
    const plannedStats = (generator as any).applyChanges(PROJECT_ID, {
      storylineProgresses: [{
        storylineName: '苏遥赎罪线', type: 'setup', beforeState: '隐瞒', afterState: '动摇',
      }],
    }, 2)
    expect(plannedStats.storylineProgressesApplied).toBe(1)
    expect(db.prepare(`
      SELECT operation, target_type
      FROM novel_memory_operations
      WHERE run_id = (SELECT id FROM novel_memory_operation_runs ORDER BY rowid DESC LIMIT 1)
    `).all()).toEqual([{ operation: 'update', target_type: 'storyline_progress' }])
  })

  it('写入失败：实体回滚，run 标记 failed 留痕', () => {
    store.createCharacter(baseCharacter('林晚', { currentState: '原状态' }))
    store.createForeshadow({
      id: randomUUID(),
      projectId: PROJECT_ID,
      description: '旧钥匙',
      category: 'item',
      status: 'planted',
      firstChapter: null,
      lastChapter: null,
      recoverByChapter: null,
      chapterSpans: [],
      beats: [],
    })
    const spy = vi.spyOn(store, 'updateForeshadow').mockImplementation(() => {
      throw new Error('模拟失败')
    })

    expect(() => (generator as any).applyChanges(PROJECT_ID, {
      characterUpdates: [{ name: '林晚', currentState: '不该残留' }],
      foreshadowUpdates: [{ description: '旧钥匙', status: 'reinforced' }],
    }, 2)).toThrow('模拟失败')

    spy.mockRestore()
    // 实体回滚
    expect(store.listCharacters(PROJECT_ID)[0].currentState).toBe('原状态')
    // 审计留痕：run failed，且 operation 与实体同事务被回滚（不残留半套）
    const run = db.prepare('SELECT * FROM novel_memory_operation_runs').get() as any
    expect(run.status).toBe('failed')
    expect(run.error).toContain('模拟失败')
    const ops = db.prepare('SELECT COUNT(*) AS n FROM novel_memory_operations').get() as { n: number }
    expect(ops.n).toBe(0)
  })

  it('账本提交后外层事务回滚：重新标记 failed 不丢失 run', () => {
    const ledger = new MemoryOperationLedger(db, {
      projectId: PROJECT_ID,
      source: 'test',
      payloadHash: 'rollback-case',
    })
    ledger.push({
      operation: 'update',
      targetType: 'character',
      targetId: 'missing-character',
      beforeJson: '{}',
      afterJson: '{}',
    })

    expect(() => store.withTransaction(() => {
      ledger.commit()
      throw new Error('外层事务回滚')
    })).toThrow('外层事务回滚')

    store.withTransaction(() => ledger.markFailed('外层事务回滚'))
    const run = db.prepare('SELECT status, error FROM novel_memory_operation_runs').get() as any
    expect(run.status).toBe('failed')
    expect(run.error).toBe('外层事务回滚')
    expect(db.prepare('SELECT COUNT(*) AS n FROM novel_memory_operations').get()).toEqual({ n: 0 })
  })

  it('空 payload 仍留下 committed run，便于审计无变化的 Memory 应用', () => {
    ;(generator as any).applyChanges(PROJECT_ID, {}, 2)
    const run = db.prepare('SELECT status FROM novel_memory_operation_runs').get() as any
    expect(run.status).toBe('committed')
    expect(db.prepare('SELECT COUNT(*) AS n FROM novel_memory_operations').get()).toEqual({ n: 0 })
  })
})
