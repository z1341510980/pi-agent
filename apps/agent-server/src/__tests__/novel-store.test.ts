import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelStore } from '../plugins/novel-plugin/core/novel-store.js'
import { novelMigrations } from '../plugins/novel-plugin/novel-migrations.js'

let db: Database.Database
let store: NovelStore

beforeEach(() => {
  db = new Database(':memory:')
  // 关闭外键约束的延迟检查，使 ON DELETE CASCADE 在内存库中正常工作
  db.pragma('foreign_keys = ON')
  for (const m of novelMigrations) {
    db.exec(m.sql)
  }
  store = new NovelStore(db)
})

afterEach(() => {
  db.close()
})

describe('NovelStore - 项目 CRUD', () => {
  it('createProject 创建项目并返回完整对象', () => {
    const project = store.createProject({
      id: 'p-1',
      title: '测试小说',
      genre: '玄幻',
      synopsis: '一个测试故事',
      targetWords: 100000,
      currentVolume: 1,
      currentChapter: 0,
      currentStage: 'setup',
      status: 'active',
    })
    expect(project.id).toBe('p-1')
    expect(project.title).toBe('测试小说')
    expect(project.createdAt).toBeGreaterThan(0)
    expect(project.updatedAt).toBe(project.createdAt)
  })

  it('getProject 读取已存在的项目', () => {
    store.createProject({
      id: 'p-1', title: '小说', genre: '玄幻', synopsis: '', targetWords: 0,
      currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
    })
    const project = store.getProject('p-1')
    expect(project).toBeDefined()
    expect(project!.title).toBe('小说')
  })

  it('getProject 不存在时返回 undefined', () => {
    expect(store.getProject('nonexistent')).toBeUndefined()
  })

  it('updateProject 更新字段', () => {
    store.createProject({
      id: 'p-1', title: '原标题', genre: '玄幻', synopsis: '', targetWords: 0,
      currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
    })
    const updated = store.updateProject('p-1', { title: '新标题', currentStage: 'rising' })
    expect(updated).toBeDefined()
    expect(updated!.title).toBe('新标题')
    expect(updated!.currentStage).toBe('rising')
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(updated!.createdAt)
  })

  it('updateProject 不存在时返回 undefined', () => {
    expect(store.updateProject('nonexistent', { title: 'x' })).toBeUndefined()
  })

  it('deleteProject 删除项目', () => {
    store.createProject({
      id: 'p-1', title: 'x', genre: 'x', synopsis: '', targetWords: 0,
      currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
    })
    expect(store.deleteProject('p-1')).toBe(true)
    expect(store.getProject('p-1')).toBeUndefined()
  })

  it('deleteProject 不存在返回 false', () => {
    expect(store.deleteProject('nonexistent')).toBe(false)
  })

  it('listProjects 返回所有项目', () => {
    store.createProject({
      id: 'p-1', title: 'A', genre: 'x', synopsis: '', targetWords: 0,
      currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
    })
    store.createProject({
      id: 'p-2', title: 'B', genre: 'x', synopsis: '', targetWords: 0,
      currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
    })
    const list = store.listProjects()
    expect(list).toHaveLength(2)
    expect(list.map((p) => p.id).sort()).toEqual(['p-1', 'p-2'])
  })
})

describe('NovelStore - 角色 CRUD', () => {
  beforeEach(() => {
    store.createProject({
      id: 'p-1', title: 'x', genre: 'x', synopsis: '', targetWords: 0,
      currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
    })
  })

  it('createCharacter 创建角色', () => {
    const c = store.createCharacter({
      id: 'c-1', projectId: 'p-1', name: '主角', description: '描述',
      identity: '身份', personality: '性格', appearance: '外貌',
      currentState: '初始', currentGoal: '目标', currentPressure: '压力',
      secret: '秘密', arcStage: 'setup', arcHistory: '[]', speechStyle: '口语',
      isProtagonist: false,
      longTermDesire: '', plotRole: 'supporting' as const, removalImpact: '',
    })
    expect(c.id).toBe('c-1')
    expect(c.name).toBe('主角')
    expect(c.createdAt).toBeGreaterThan(0)
  })

  it('getCharacter 读取角色', () => {
    store.createCharacter({
      id: 'c-1', projectId: 'p-1', name: '主角', description: '',
      identity: '', personality: '', appearance: '',
      currentState: '', currentGoal: '', currentPressure: '',
      secret: '', arcStage: '', arcHistory: '[]', speechStyle: '',
      isProtagonist: false,
      longTermDesire: '', plotRole: 'supporting' as const, removalImpact: '',
    })
    const c = store.getCharacter('c-1')
    expect(c).toBeDefined()
    expect(c!.name).toBe('主角')
  })

  it('getCharacter 不存在返回 undefined', () => {
    expect(store.getCharacter('nonexistent')).toBeUndefined()
  })

  it('updateCharacter 更新角色', () => {
    store.createCharacter({
      id: 'c-1', projectId: 'p-1', name: '原名', description: '',
      identity: '', personality: '', appearance: '',
      currentState: '旧状态', currentGoal: '', currentPressure: '',
      secret: '', arcStage: '', arcHistory: '[]', speechStyle: '',
      isProtagonist: false,
      longTermDesire: '', plotRole: 'supporting' as const, removalImpact: '',
    })
    const updated = store.updateCharacter('c-1', { name: '新名', currentState: '新状态' })
    expect(updated).toBeDefined()
    expect(updated!.name).toBe('新名')
    expect(updated!.currentState).toBe('新状态')
  })

  it('updateCharacter 不存在返回 undefined', () => {
    expect(store.updateCharacter('nonexistent', { name: 'x' })).toBeUndefined()
  })

  it('deleteCharacter 删除角色', () => {
    store.createCharacter({
      id: 'c-1', projectId: 'p-1', name: 'x', description: '',
      identity: '', personality: '', appearance: '',
      currentState: '', currentGoal: '', currentPressure: '',
      secret: '', arcStage: '', arcHistory: '[]', speechStyle: '',
      isProtagonist: false,
      longTermDesire: '', plotRole: 'supporting' as const, removalImpact: '',
    })
    expect(store.deleteCharacter('c-1')).toBe(true)
    expect(store.getCharacter('c-1')).toBeUndefined()
  })

  it('deleteCharacter 不存在返回 false', () => {
    expect(store.deleteCharacter('nonexistent')).toBe(false)
  })

  it('listCharacters 返回项目下所有角色', () => {
    store.createCharacter({
      id: 'c-1', projectId: 'p-1', name: 'A', description: '',
      identity: '', personality: '', appearance: '',
      currentState: '', currentGoal: '', currentPressure: '',
      secret: '', arcStage: '', arcHistory: '[]', speechStyle: '',
      isProtagonist: false,
      longTermDesire: '', plotRole: 'supporting' as const, removalImpact: '',
    })
    store.createCharacter({
      id: 'c-2', projectId: 'p-1', name: 'B', description: '',
      identity: '', personality: '', appearance: '',
      currentState: '', currentGoal: '', currentPressure: '',
      secret: '', arcStage: '', arcHistory: '[]', speechStyle: '',
      isProtagonist: false,
      longTermDesire: '', plotRole: 'supporting' as const, removalImpact: '',
    })
    expect(store.listCharacters('p-1')).toHaveLength(2)
  })
})

describe('NovelStore - 章节 CRUD', () => {
  beforeEach(() => {
    store.createProject({
      id: 'p-1', title: 'x', genre: 'x', synopsis: '', targetWords: 0,
      currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
    })
  })

  it('createChapter 创建章节', () => {
    const ch = store.createChapter({
      id: 'ch-1', projectId: 'p-1', volume: 1, chapterNumber: 1,
      title: '第一章', content: '', wordCount: 0, status: 'planned',
      narrativeTask: '任务', acceptanceResult: null,
    })
    expect(ch.id).toBe('ch-1')
    expect(ch.chapterNumber).toBe(1)
  })

  it('getChapter 按 chapterNumber 读取', () => {
    store.createChapter({
      id: 'ch-1', projectId: 'p-1', volume: 1, chapterNumber: 1,
      title: '第一章', content: '', wordCount: 0, status: 'planned',
      narrativeTask: '', acceptanceResult: null,
    })
    const ch = store.getChapter('p-1', 1)
    expect(ch).toBeDefined()
    expect(ch!.title).toBe('第一章')
  })

  it('getChapterById 按 id 读取', () => {
    store.createChapter({
      id: 'ch-1', projectId: 'p-1', volume: 1, chapterNumber: 1,
      title: '第一章', content: '', wordCount: 0, status: 'planned',
      narrativeTask: '', acceptanceResult: null,
    })
    const ch = store.getChapterById('ch-1')
    expect(ch).toBeDefined()
    expect(ch!.title).toBe('第一章')
  })

  it('updateChapter 更新章节', () => {
    store.createChapter({
      id: 'ch-1', projectId: 'p-1', volume: 1, chapterNumber: 1,
      title: '旧标题', content: '', wordCount: 0, status: 'planned',
      narrativeTask: '', acceptanceResult: null,
    })
    const updated = store.updateChapter('ch-1', { title: '新标题', status: 'published' })
    expect(updated).toBeDefined()
    expect(updated!.title).toBe('新标题')
    expect(updated!.status).toBe('published')
  })

  it('updateChapterContent 仅更新内容与字数', () => {
    store.createChapter({
      id: 'ch-1', projectId: 'p-1', volume: 1, chapterNumber: 1,
      title: '标题', content: '', wordCount: 0, status: 'planned',
      narrativeTask: '', acceptanceResult: null,
    })
    const updated = store.updateChapterContent('ch-1', '正文内容', 4)
    expect(updated).toBeDefined()
    expect(updated!.content).toBe('正文内容')
    expect(updated!.wordCount).toBe(4)
    expect(updated!.title).toBe('标题') // 标题不变
  })

  it('listChapters 返回项目下所有章节', () => {
    store.createChapter({
      id: 'ch-1', projectId: 'p-1', volume: 1, chapterNumber: 1,
      title: '一', content: '', wordCount: 0, status: 'planned',
      narrativeTask: '', acceptanceResult: null,
    })
    store.createChapter({
      id: 'ch-2', projectId: 'p-1', volume: 1, chapterNumber: 2,
      title: '二', content: '', wordCount: 0, status: 'planned',
      narrativeTask: '', acceptanceResult: null,
    })
    const list = store.listChapters('p-1')
    expect(list).toHaveLength(2)
    expect(list[0].chapterNumber).toBe(1) // 按 chapter_number ASC
    expect(list[1].chapterNumber).toBe(2)
  })

  it('deleteChapter 删除章节', () => {
    store.createChapter({
      id: 'ch-1', projectId: 'p-1', volume: 1, chapterNumber: 1,
      title: 'x', content: '', wordCount: 0, status: 'planned',
      narrativeTask: '', acceptanceResult: null,
    })
    expect(store.deleteChapter('ch-1')).toBe(true)
    expect(store.getChapterById('ch-1')).toBeUndefined()
  })

  it('deleteChapter 不存在返回 false', () => {
    expect(store.deleteChapter('nonexistent')).toBe(false)
  })
})

describe('NovelStore - 冲突 CRUD', () => {
  beforeEach(() => {
    store.createProject({
      id: 'p-1', title: 'x', genre: 'x', synopsis: '', targetWords: 0,
      currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
    })
  })

  it('createConflict 创建冲突', () => {
    const c = store.createConflict({
      id: 'cf-1', projectId: 'p-1', description: '主要冲突',
      type: 'inner', intensity: 7, stage: 'latent', participants: '[]',
      chapterSpans: [], tier: 'secondary',
    })
    expect(c.id).toBe('cf-1')
    expect(c.intensity).toBe(7)
  })

  it('getConflict 读取冲突', () => {
    store.createConflict({
      id: 'cf-1', projectId: 'p-1', description: 'x',
      type: 'inner', intensity: 5, stage: 'latent', participants: '[]',
      chapterSpans: [], tier: 'secondary',
    })
    expect(store.getConflict('cf-1')?.description).toBe('x')
  })

  it('updateConflict 更新冲突', () => {
    store.createConflict({
      id: 'cf-1', projectId: 'p-1', description: 'x',
      type: 'inner', intensity: 5, stage: 'latent', participants: '[]',
      chapterSpans: [], tier: 'secondary',
    })
    const updated = store.updateConflict('cf-1', { intensity: 9, stage: 'erupting' })
    expect(updated).toBeDefined()
    expect(updated!.intensity).toBe(9)
    expect(updated!.stage).toBe('erupting')
  })

  it('deleteConflict 删除冲突', () => {
    store.createConflict({
      id: 'cf-1', projectId: 'p-1', description: 'x',
      type: 'inner', intensity: 5, stage: 'latent', participants: '[]',
      chapterSpans: [], tier: 'secondary',
    })
    expect(store.deleteConflict('cf-1')).toBe(true)
    expect(store.getConflict('cf-1')).toBeUndefined()
  })

  it('listConflicts 返回项目下所有冲突', () => {
    store.createConflict({
      id: 'cf-1', projectId: 'p-1', description: 'A',
      type: 'inner', intensity: 5, stage: 'latent', participants: '[]',
      chapterSpans: [], tier: 'secondary',
    })
    store.createConflict({
      id: 'cf-2', projectId: 'p-1', description: 'B',
      type: 'faction', intensity: 6, stage: 'emerging', participants: '[]',
      chapterSpans: [], tier: 'secondary',
    })
    expect(store.listConflicts('p-1')).toHaveLength(2)
  })
})

describe('NovelStore - 线索 CRUD', () => {
  it('持久化并更新线索的章节节点', () => {
    store.createProject({
      id: 'p-1', title: 'x', genre: 'x', synopsis: '', targetWords: 0,
      currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
    })
    const created = store.createClue({
      id: 'clue-1', projectId: 'p-1', description: '铜扣', pointsTo: '真凶', progress: 20,
      currentStep: '发现', nextStep: '查来源', isMisleading: false,
      chapterSpans: [[2, 2]],
    })
    expect(created.chapterSpans).toEqual([[2, 2]])
    expect(store.listClues('p-1')[0].chapterSpans).toEqual([[2, 2]])

    const updated = store.updateClue('clue-1', { chapterSpans: [[2, 2], [5, 5]], progress: 40 })
    expect(updated?.chapterSpans).toEqual([[2, 2], [5, 5]])
    expect(updated?.progress).toBe(40)
  })
})

describe('NovelStore - 伏笔 CRUD', () => {
  beforeEach(() => {
    store.createProject({
      id: 'p-1', title: 'x', genre: 'x', synopsis: '', targetWords: 0,
      currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
    })
  })

  it('createForeshadow 创建伏笔', () => {
    const f = store.createForeshadow({
      id: 'f-1', projectId: 'p-1', description: '神秘物品',
      category: 'item', status: 'planned', firstChapter: 1, lastChapter: null,
      recoverByChapter: 10, chapterSpans: [[1, 10]],
    })
    expect(f.id).toBe('f-1')
    expect(f.firstChapter).toBe(1)
  })

  it('getForeshadow 读取伏笔', () => {
    store.createForeshadow({
      id: 'f-1', projectId: 'p-1', description: 'x',
      category: 'item', status: 'planned', firstChapter: null, lastChapter: null,
      recoverByChapter: null, chapterSpans: [],
    })
    expect(store.getForeshadow('f-1')?.description).toBe('x')
  })

  it('updateForeshadow 更新伏笔', () => {
    store.createForeshadow({
      id: 'f-1', projectId: 'p-1', description: 'x',
      category: 'item', status: 'planned', firstChapter: null, lastChapter: null,
      recoverByChapter: null, chapterSpans: [],
    })
    const updated = store.updateForeshadow('f-1', { status: 'planted', firstChapter: 3 })
    expect(updated).toBeDefined()
    expect(updated!.status).toBe('planted')
    expect(updated!.firstChapter).toBe(3)
  })

  it('用离散事件链持久化伏笔，并同步兼容字段和状态', () => {
    const created = store.createForeshadow({
      id: 'f-chain', projectId: 'p-1', description: '旧钥匙',
      category: 'item', status: 'planned', firstChapter: null, lastChapter: null,
      recoverByChapter: null, chapterSpans: [],
      beats: [
        { chapter: 2, type: 'plant' },
        { chapter: 5, type: 'reinforce', note: '再次出现' },
        { chapter: 8, type: 'reinforce' },
        { chapter: 11, type: 'reveal' },
      ],
    })
    expect(created.firstChapter).toBe(2)
    expect(created.lastChapter).toBe(11)
    expect(created.status).toBe('partially_revealed')
    expect(store.getForeshadow('f-chain')?.beats).toEqual(created.beats)

    const recovered = store.updateForeshadow('f-chain', {
      beats: [...created.beats!, { chapter: 14, type: 'payoff' }],
    })!
    expect(recovered.recoverByChapter).toBe(14)
    expect(recovered.lastChapter).toBe(14)
    expect(recovered.status).toBe('recovered')
  })

  it('事件链 PATCH 删除节点时不被旧兼容端点重新补回', () => {
    store.createForeshadow({
      id: 'f-remove-beat', projectId: 'p-1', description: '将被修改的事件链',
      category: 'item', status: 'planned', firstChapter: null, lastChapter: null,
      recoverByChapter: null, chapterSpans: [],
      beats: [
        { chapter: 2, type: 'plant' },
        { chapter: 5, type: 'reinforce' },
        { chapter: 9, type: 'payoff' },
      ],
    })

    const updated = store.updateForeshadow('f-remove-beat', {
      beats: [
        { chapter: 2, type: 'plant' },
        { chapter: 5, type: 'reinforce' },
      ],
    })!

    expect(updated.beats).toEqual([
      { chapter: 2, type: 'plant' },
      { chapter: 5, type: 'reinforce' },
    ])
    expect(updated.recoverByChapter).toBeNull()
    expect(updated.lastChapter).toBe(5)
    expect(updated.status).toBe('reinforced')
  })

  it('丢弃未埋设、埋设前和回收后的无效伏笔节点', () => {
    const created = store.createForeshadow({
      id: 'f-invalid', projectId: 'p-1', description: '异常链',
      category: 'item', status: 'planned', firstChapter: null, lastChapter: null,
      recoverByChapter: null, chapterSpans: [],
      beats: [
        { chapter: 1, type: 'reinforce' },
        { chapter: 3, type: 'plant' },
        { chapter: 6, type: 'payoff' },
        { chapter: 9, type: 'reveal' },
      ],
    })
    expect(created.beats).toEqual([
      { chapter: 3, type: 'plant' },
      { chapter: 6, type: 'payoff' },
    ])
  })

  it('deleteForeshadow 删除伏笔', () => {
    store.createForeshadow({
      id: 'f-1', projectId: 'p-1', description: 'x',
      category: 'item', status: 'planned', firstChapter: null, lastChapter: null,
      recoverByChapter: null, chapterSpans: [],
    })
    expect(store.deleteForeshadow('f-1')).toBe(true)
    expect(store.getForeshadow('f-1')).toBeUndefined()
  })

  it('listForeshadowing 返回项目下所有伏笔', () => {
    store.createForeshadow({
      id: 'f-1', projectId: 'p-1', description: 'A',
      category: 'item', status: 'planned', firstChapter: null, lastChapter: null,
      recoverByChapter: null, chapterSpans: [],
    })
    store.createForeshadow({
      id: 'f-2', projectId: 'p-1', description: 'B',
      category: 'item', status: 'planted', firstChapter: null, lastChapter: null,
      recoverByChapter: null, chapterSpans: [],
    })
    expect(store.listForeshadowing('p-1')).toHaveLength(2)
  })
})

describe('NovelStore - P3-2 伏笔↔信息差双向联动', () => {
  beforeEach(() => {
    store.createProject({
      id: 'p-1', title: 'x', genre: 'x', synopsis: '', targetWords: 0,
      currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
    })
  })

  function seedForeshadowAndInfoLayer() {
    store.createForeshadow({
      id: 'f-1', projectId: 'p-1', description: '神秘戒指',
      category: 'item', status: 'planned', firstChapter: 1, lastChapter: null,
      recoverByChapter: 10, chapterSpans: [[1, 10]],
      plantMethod: 'implicit', recoverMethod: 'explicit',
    })
    store.createInformationLayer({
      id: 'il-1', projectId: 'p-1', infoDescription: '读者不知道戒指是神器',
      authorKnows: true, readerKnows: false, characterKnowledge: '{}',
      revealStage: null, revealChapter: null, isRevealed: false,
    })
  }

  it('getInformationLayer 按 ID 查询单个信息差', () => {
    seedForeshadowAndInfoLayer()
    const layer = store.getInformationLayer('il-1')
    expect(layer).toBeDefined()
    expect(layer!.infoDescription).toBe('读者不知道戒指是神器')
  })

  it('getInformationLayer 不存在返回 undefined', () => {
    expect(store.getInformationLayer('nonexistent')).toBeUndefined()
  })
})

describe('NovelStore - 节点位置 CRUD', () => {
  beforeEach(() => {
    store.createProject({
      id: 'p-1', title: 'x', genre: 'x', synopsis: '', targetWords: 0,
      currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
    })
  })

  it('upsertNodePosition 新建节点位置', () => {
    const pos = store.upsertNodePosition('p-1', 'character', 'c-1', 100, 200)
    expect(pos.id).toBe('character:c-1')
    expect(pos.posX).toBe(100)
    expect(pos.posY).toBe(200)
    expect(pos.projectId).toBe('p-1')
  })

  it('upsertNodePosition 重复调用更新而非插入', () => {
    store.upsertNodePosition('p-1', 'character', 'c-1', 100, 200)
    store.upsertNodePosition('p-1', 'character', 'c-1', 300, 400)
    const list = store.listNodePositions('p-1')
    expect(list).toHaveLength(1)
    expect(list[0].posX).toBe(300)
    expect(list[0].posY).toBe(400)
  })

  it('listNodePositions 返回所有节点', () => {
    store.upsertNodePosition('p-1', 'character', 'c-1', 1, 2)
    store.upsertNodePosition('p-1', 'chapter', 'ch-1', 3, 4)
    const list = store.listNodePositions('p-1')
    expect(list).toHaveLength(2)
  })

  it('deleteNodePosition 删除节点位置', () => {
    store.upsertNodePosition('p-1', 'character', 'c-1', 1, 2)
    expect(store.deleteNodePosition('p-1', 'character', 'c-1')).toBe(true)
    expect(store.listNodePositions('p-1')).toHaveLength(0)
  })

  it('deleteNodePosition 不存在返回 false', () => {
    expect(store.deleteNodePosition('p-1', 'character', 'nonexistent')).toBe(false)
  })
})

describe('NovelStore - 角色历史 CRUD', () => {
  beforeEach(() => {
    store.createProject({
      id: 'p-1', title: 'x', genre: 'x', synopsis: '', targetWords: 0,
      currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
    })
    store.createCharacter({
      id: 'c-1', projectId: 'p-1', name: '主角', description: '',
      identity: '', personality: '', appearance: '',
      currentState: '初始', currentGoal: '', currentPressure: '',
      secret: '', arcStage: '', arcHistory: '[]', speechStyle: '',
      isProtagonist: false,
      longTermDesire: '', plotRole: 'supporting' as const, removalImpact: '',
    })
  })

  it('createCharacterHistory 创建历史记录', () => {
    const h = store.createCharacterHistory({
      projectId: 'p-1', characterId: 'c-1', chapterId: null, chapterNumber: 1,
      fieldName: 'currentState', oldValue: '初始', newValue: '改变后', reason: '剧情推进',
    })
    expect(h.id).toBeTruthy()
    expect(h.fieldName).toBe('currentState')
    expect(h.newValue).toBe('改变后')
  })

  it('listCharacterHistory 按项目返回历史', () => {
    store.createCharacterHistory({
      projectId: 'p-1', characterId: 'c-1', chapterId: null, chapterNumber: 1,
      fieldName: 'currentState', oldValue: 'A', newValue: 'B', reason: '',
    })
    store.createCharacterHistory({
      projectId: 'p-1', characterId: 'c-1', chapterId: null, chapterNumber: 2,
      fieldName: 'currentGoal', oldValue: 'X', newValue: 'Y', reason: '',
    })
    const list = store.listCharacterHistory('p-1')
    expect(list).toHaveLength(2)
  })

  it('listCharacterHistory 按角色过滤', () => {
    store.createCharacterHistory({
      projectId: 'p-1', characterId: 'c-1', chapterId: null, chapterNumber: 1,
      fieldName: 'currentState', oldValue: null, newValue: 'A', reason: null,
    })
    store.createCharacterHistory({
      projectId: 'p-1', characterId: 'c-other', chapterId: null, chapterNumber: 1,
      fieldName: 'currentState', oldValue: null, newValue: 'B', reason: null,
    })
    const list = store.listCharacterHistory('p-1', 'c-1')
    expect(list).toHaveLength(1)
    expect(list[0].characterId).toBe('c-1')
  })
})

describe('NovelStore v0.2 — Hook CRUD', () => {
  let testProjectId: string

  beforeEach(() => {
    testProjectId = randomUUID()
    store.createProject({
      id: testProjectId, title: 'test', genre: 'test', synopsis: '', targetWords: 0,
      currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
    })
  })

  it('createHook + getHook round-trip', () => {
    const id = randomUUID()
    const hook = store.createHook({
      id, projectId: testProjectId, chapterNumber: 5,
      hookType: 'suspense', description: '尸体被发现的风险',
      status: 'thrown', fulfilledAtChapter: null, fulfilledDescription: null,
    })
    expect(hook.status).toBe('thrown')
    const got = store.getHook(id)
    expect(got?.description).toBe('尸体被发现的风险')
  })

  it('listUnfulfilledHooksBefore returns only thrown hooks before given chapter', () => {
    store.createHook({ id: randomUUID(), projectId: testProjectId, chapterNumber: 4, hookType: 'suspense', description: 'h4', status: 'thrown', fulfilledAtChapter: null, fulfilledDescription: null })
    store.createHook({ id: randomUUID(), projectId: testProjectId, chapterNumber: 5, hookType: 'action', description: 'h5', status: 'fulfilled', fulfilledAtChapter: 6, fulfilledDescription: 'done' })
    store.createHook({ id: randomUUID(), projectId: testProjectId, chapterNumber: 3, hookType: 'emotional', description: 'h3', status: 'thrown', fulfilledAtChapter: null, fulfilledDescription: null })
    // 第7章创作时查询未兑现钩子：应返回 h3（ch3, thrown）和 h4（ch4, thrown），不含 h5（fulfilled）
    const result = store.listUnfulfilledHooksBefore(testProjectId, 7)
    expect(result).toHaveLength(2)
    expect(result.map(h => h.chapterNumber)).toEqual([4, 3]) // DESC by chapter
  })

  it('listHooksByChapter returns hooks of given chapter', () => {
    store.createHook({ id: randomUUID(), projectId: testProjectId, chapterNumber: 4, hookType: 'suspense', description: 'h4', status: 'thrown', fulfilledAtChapter: null, fulfilledDescription: null })
    store.createHook({ id: randomUUID(), projectId: testProjectId, chapterNumber: 5, hookType: 'action', description: 'h5', status: 'thrown', fulfilledAtChapter: null, fulfilledDescription: null })
    const result = store.listHooksByChapter(testProjectId, 5)
    expect(result).toHaveLength(1)
    expect(result[0].description).toBe('h5')
  })

  it('updateHook marks fulfilled', () => {
    const id = randomUUID()
    store.createHook({ id, projectId: testProjectId, chapterNumber: 5, hookType: 'suspense', description: 'h', status: 'thrown', fulfilledAtChapter: null, fulfilledDescription: null })
    const updated = store.updateHook(id, { status: 'fulfilled', fulfilledAtChapter: 6, fulfilledDescription: '承接了' })
    expect(updated?.status).toBe('fulfilled')
    expect(updated?.fulfilledAtChapter).toBe(6)
  })

  it('updateHook 不存在返回 undefined', () => {
    expect(store.updateHook('nonexistent', { status: 'abandoned' })).toBeUndefined()
  })

  it('deleteHook', () => {
    const id = randomUUID()
    store.createHook({ id, projectId: testProjectId, chapterNumber: 5, hookType: 'suspense', description: 'h', status: 'thrown', fulfilledAtChapter: null, fulfilledDescription: null })
    expect(store.deleteHook(id)).toBe(true)
    expect(store.getHook(id)).toBeUndefined()
  })

  it('deleteHook 不存在返回 false', () => {
    expect(store.deleteHook('nonexistent')).toBe(false)
  })

  it('listHooks 按章节号升序', () => {
    store.createHook({ id: randomUUID(), projectId: testProjectId, chapterNumber: 5, hookType: 'suspense', description: 'h5', status: 'thrown', fulfilledAtChapter: null, fulfilledDescription: null })
    store.createHook({ id: randomUUID(), projectId: testProjectId, chapterNumber: 3, hookType: 'emotional', description: 'h3', status: 'thrown', fulfilledAtChapter: null, fulfilledDescription: null })
    const list = store.listHooks(testProjectId)
    expect(list.map(h => h.chapterNumber)).toEqual([3, 5])
  })
})

describe('NovelStore v0.2 — CharacterArc CRUD', () => {
  let testProjectId: string
  let testCharacterId: string

  beforeEach(() => {
    testProjectId = randomUUID()
    testCharacterId = randomUUID()
    store.createProject({
      id: testProjectId, title: 'test', genre: 'test', synopsis: '', targetWords: 0,
      currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
    })
    store.createCharacter({
      id: testCharacterId, projectId: testProjectId, name: '叶明远', description: '',
      identity: '', personality: '', appearance: '',
      currentState: '', currentGoal: '', currentPressure: '',
      secret: '', arcStage: '', arcHistory: '[]', speechStyle: '',
      isProtagonist: true,
      longTermDesire: '', plotRole: 'protagonist' as const, removalImpact: '',
    })
  })

  it('createCharacterArc + getCharacterArc round-trip', () => {
    const id = randomUUID()
    store.createCharacterArc({
      id, projectId: testProjectId, characterId: testCharacterId,
      arcType: 'growth', currentStage: 'denial', stageHistory: [], description: '从懦弱到坚定',
    })
    const got = store.getCharacterArc(id)
    expect(got?.arcType).toBe('growth')
    expect(got?.currentStage).toBe('denial')
    expect(got?.description).toBe('从懦弱到坚定')
    expect(got?.stageHistory).toEqual([])
  })

  it('getCharacterArcByCharacter returns 1:1', () => {
    const id = randomUUID()
    store.createCharacterArc({
      id, projectId: testProjectId, characterId: testCharacterId,
      arcType: 'shift', currentStage: 'old_framework', stageHistory: [], description: '认知重构',
    })
    const got = store.getCharacterArcByCharacter(testProjectId, testCharacterId)
    expect(got?.id).toBe(id)
  })

  it('getCharacterArc 不存在返回 undefined', () => {
    expect(store.getCharacterArc('nonexistent')).toBeUndefined()
  })

  it('updateCharacterArc appends stage history', () => {
    const id = randomUUID()
    store.createCharacterArc({
      id, projectId: testProjectId, characterId: testCharacterId,
      arcType: 'growth', currentStage: 'denial', stageHistory: [], description: '',
    })
    const updated = store.updateCharacterArc(id, {
      currentStage: 'resistance',
      stageHistory: [{ stage: 'resistance', triggerEvent: '首次杀人', description: '心理冲击', chapterNumber: 7, changedAt: Date.now() }],
    })
    expect(updated?.currentStage).toBe('resistance')
    expect(updated?.stageHistory).toHaveLength(1)
    expect(updated?.stageHistory[0].triggerEvent).toBe('首次杀人')
  })

  it('updateCharacterArc 不存在返回 undefined', () => {
    expect(store.updateCharacterArc('nonexistent', { currentStage: 'x' })).toBeUndefined()
  })

  it('deleteCharacterArc', () => {
    const id = randomUUID()
    store.createCharacterArc({
      id, projectId: testProjectId, characterId: testCharacterId,
      arcType: 'growth', currentStage: 'denial', stageHistory: [], description: '',
    })
    expect(store.deleteCharacterArc(id)).toBe(true)
    expect(store.getCharacterArc(id)).toBeUndefined()
  })

  it('deleteCharacterArc 不存在返回 false', () => {
    expect(store.deleteCharacterArc('nonexistent')).toBe(false)
  })

  it('listCharacterArcs 返回项目下所有弧光', () => {
    const otherCharacterId = randomUUID()
    store.createCharacter({
      id: otherCharacterId, projectId: testProjectId, name: '配角', description: '',
      identity: '', personality: '', appearance: '',
      currentState: '', currentGoal: '', currentPressure: '',
      secret: '', arcStage: '', arcHistory: '[]', speechStyle: '',
      isProtagonist: false,
      longTermDesire: '', plotRole: 'supporting' as const, removalImpact: '',
    })
    store.createCharacterArc({
      id: randomUUID(), projectId: testProjectId, characterId: testCharacterId,
      arcType: 'growth', currentStage: 'denial', stageHistory: [], description: '',
    })
    store.createCharacterArc({
      id: randomUUID(), projectId: testProjectId, characterId: otherCharacterId,
      arcType: 'fall', currentStage: 'temptation', stageHistory: [], description: '',
    })
    const list = store.listCharacterArcs(testProjectId)
    expect(list).toHaveLength(2)
  })

  it('rowToArc 容错：损坏的 stage_history JSON 回退为空数组', () => {
    // 直接写入损坏的 JSON 验证容错
    const id = randomUUID()
    store.createCharacterArc({
      id, projectId: testProjectId, characterId: testCharacterId,
      arcType: 'growth', currentStage: 'denial', stageHistory: [], description: '',
    })
    // 直接 SQL 写入损坏的 stage_history
    store['db'].prepare('UPDATE novel_character_arcs SET stage_history = ? WHERE id = ?').run('{not valid json', id)
    const got = store.getCharacterArc(id)
    expect(got?.stageHistory).toEqual([])
  })
})
