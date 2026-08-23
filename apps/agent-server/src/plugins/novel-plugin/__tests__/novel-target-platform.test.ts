import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'

let db: Database.Database
let store: NovelStore

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const m of novelMigrations) {
    db.exec(m.sql)
  }
  store = new NovelStore(db)
})

afterEach(() => {
  db.close()
})

describe('targetPlatform 全链路验证', () => {
  it('迁移 061 已创建 target_platform 列', () => {
    const columns = db.prepare("PRAGMA table_info(novel_projects)").all() as Array<{ name: string }>
    const columnNames = columns.map(c => c.name)
    expect(columnNames).toContain('target_platform')
  })

  it('createProject 存储 targetPlatform 并读取', () => {
    const project = store.createProject({
      id: 'p-tp-1',
      title: '测试平台',
      genre: '玄幻',
      synopsis: '',
      targetWords: 2000000,
      targetPlatform: 'fanqie',
      currentVolume: 1,
      currentChapter: 0,
      currentStage: 'setup',
      status: 'active',
    })
    expect(project.targetPlatform).toBe('fanqie')

    // 从数据库重新读取，验证持久化
    const reloaded = store.getProject('p-tp-1')
    expect(reloaded).toBeDefined()
    expect(reloaded!.targetPlatform).toBe('fanqie')
  })

  it('createProject 不传 targetPlatform 时为 null', () => {
    store.createProject({
      id: 'p-tp-2',
      title: '无平台',
      genre: '科幻',
      synopsis: '',
      targetWords: 100000,
      currentVolume: 1,
      currentChapter: 0,
      currentStage: 'setup',
      status: 'active',
    })
    const project = store.getProject('p-tp-2')
    expect(project).toBeDefined()
    expect(project!.targetPlatform).toBeNull()
  })

  it('updateProject 更新 targetPlatform', () => {
    store.createProject({
      id: 'p-tp-3',
      title: '改平台',
      genre: '悬疑',
      synopsis: '',
      targetWords: 50000,
      targetPlatform: 'qidian',
      currentVolume: 1,
      currentChapter: 0,
      currentStage: 'setup',
      status: 'active',
    })

    const updated = store.updateProject('p-tp-3', { targetPlatform: 'zhihu_yanyan' })
    expect(updated).toBeDefined()
    expect(updated!.targetPlatform).toBe('zhihu_yanyan')

    // 验证持久化
    const reloaded = store.getProject('p-tp-3')
    expect(reloaded!.targetPlatform).toBe('zhihu_yanyan')
  })

  it('updateProject 把 targetPlatform 设为 null', () => {
    store.createProject({
      id: 'p-tp-4',
      title: '清空平台',
      genre: '都市',
      synopsis: '',
      targetWords: 300000,
      targetPlatform: 'fanqie',
      currentVolume: 1,
      currentChapter: 0,
      currentStage: 'setup',
      status: 'active',
    })

    const updated = store.updateProject('p-tp-4', { targetPlatform: null })
    expect(updated).toBeDefined()
    expect(updated!.targetPlatform).toBeNull()
  })

  it('支持所有平台枚举值', () => {
    const platforms: Array<'fanqie' | 'qidian' | 'zhihu_yanyan' | 'general'> = [
      'fanqie', 'qidian', 'zhihu_yanyan', 'general',
    ]
    for (const p of platforms) {
      const id = `p-tp-${p}`
      store.createProject({
        id,
        title: `测试${p}`,
        genre: 'x',
        synopsis: '',
        targetWords: 100000,
        targetPlatform: p,
        currentVolume: 1,
        currentChapter: 0,
        currentStage: 'setup',
        status: 'active',
      })
      const project = store.getProject(id)
      expect(project!.targetPlatform).toBe(p)
    }
  })
})
