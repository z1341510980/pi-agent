/**
 * 项目级「创作主模型」（novelModelId）治理测试。
 *
 * 背景（实测数据驱动）：项目 8 个模型混用导致 promptCacheScope 缓存反复失效
 * （cache/in 仅 31-46%），且 Director 失败中 5/27 属"404 model not supported / 401"
 * 配置类失败。治理方案：项目设置 novelModelId（provider:modelId），创作流程所有
 * Agent 统一使用 → 缓存全程命中 + 配置类失败消除。
 *
 * 本测试守护：
 * 1. project-store 的 novelModelId 读写与持久化；
 * 2. parseNovelModelRef 的复合串解析（合法/非法/空）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'
import { parseNovelModelRef } from '../core/domain/novel-model-ref.js'

describe('项目级创作主模型（novelModelId）', () => {
  let db: Database.Database
  let store: NovelStore
  let projectId: string

  beforeAll(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    for (const migration of novelMigrations) db.exec(migration.sql)
    store = new NovelStore(db)
    const project = store.createProject({
      id: 'model-fix-project',
      title: '主模型治理测试',
      genre: '科幻',
      synopsis: '',
      targetWords: 3000,
      currentVolume: 1,
      currentChapter: 0,
      currentStage: 'setup',
      status: 'active',
    })
    projectId = project.id
  })

  afterAll(() => {
    db.close()
  })

  it('默认未设置：getNovelModelId 返回 undefined', () => {
    expect(store.getNovelModelId(projectId)).toBeUndefined()
  })

  it('updateNovelModelId 写入后可读回（provider:modelId 复合串）', () => {
    expect(store.updateNovelModelId(projectId, 'openai:gpt-5.6-luna')).toBe(true)
    expect(store.getNovelModelId(projectId)).toBe('openai:gpt-5.6-luna')
  })

  it('updateProject patch 也能持久化 novelModelId（前端表单走该路径）', () => {
    const updated = store.updateProject(projectId, { novelModelId: 'deepseek:deepseek-v4-flash' })
    expect(updated?.novelModelId).toBe('deepseek:deepseek-v4-flash')
    expect(store.getNovelModelId(projectId)).toBe('deepseek:deepseek-v4-flash')
  })

  it('置空（null）即清除主模型，恢复各 Agent 各自配置', () => {
    store.updateProject(projectId, { novelModelId: null })
    expect(store.getNovelModelId(projectId)).toBeUndefined()
  })

  describe('resolveModelRef（复合串解析）', () => {
    const resolve = parseNovelModelRef

    it('合法 "provider:modelId" 解析为对象', () => {
      expect(resolve('openai:gpt-5.6-luna')).toEqual({ provider: 'openai', modelId: 'gpt-5.6-luna' })
    })

    it('未设置返回 undefined（各 Agent 用各自配置）', () => {
      expect(resolve(undefined)).toBeUndefined()
    })

    it('非法格式（无冒号 / 冒号在首尾）返回 undefined，不生效', () => {
      expect(resolve('gpt-5.6-luna')).toBeUndefined()
      expect(resolve(':gpt-5.6-luna')).toBeUndefined()
      expect(resolve('openai:')).toBeUndefined()
    })

    it('首尾空白被清理', () => {
      expect(resolve(' openai : gpt-5.6-luna ')).toEqual({ provider: 'openai', modelId: 'gpt-5.6-luna' })
    })
  })
})
