/**
 * ThreadSettingsStore 单元测试
 *
 * 验证每个 thread 独立存储 thinkingLevel 的核心契约：
 * - 内存 Map + SQLite 同步落库
 * - get / set / clear 行为正确
 * - 无效 level 抛错（防止脏数据）
 * - 启动时从 SQLite 加载已有记录
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { ThreadSettingsStore } from '../core/agent/thread-settings-store.js'

describe('ThreadSettingsStore：基础读写', () => {
  let db: Database.Database
  let store: ThreadSettingsStore

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_thinking_levels (
        thread_id      TEXT PRIMARY KEY,
        thinking_level TEXT NOT NULL,
        updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `)
    store = new ThreadSettingsStore(db)
  })

  afterEach(() => {
    db.close()
  })

  it('未设置的 thread 返回 undefined', () => {
    expect(store.getThinkingLevel('thread-1')).toBeUndefined()
  })

  it('set + get 正确读取', () => {
    store.setThinkingLevel('thread-1', 'high')
    expect(store.getThinkingLevel('thread-1')).toBe('high')
  })

  it('不同 thread 互不干扰', () => {
    store.setThinkingLevel('thread-a', 'low')
    store.setThinkingLevel('thread-b', 'xhigh')
    expect(store.getThinkingLevel('thread-a')).toBe('low')
    expect(store.getThinkingLevel('thread-b')).toBe('xhigh')
  })

  it('重复 set 同一 thread 会覆盖', () => {
    store.setThinkingLevel('thread-1', 'low')
    store.setThinkingLevel('thread-1', 'high')
    expect(store.getThinkingLevel('thread-1')).toBe('high')
  })

  it('set 后立即写入 SQLite', () => {
    store.setThinkingLevel('thread-1', 'medium')
    const row = db
      .prepare('SELECT thinking_level FROM thread_thinking_levels WHERE thread_id = ?')
      .get('thread-1') as { thinking_level: string } | undefined
    expect(row?.thinking_level).toBe('medium')
  })
})

describe('ThreadSettingsStore：clear 行为', () => {
  let db: Database.Database
  let store: ThreadSettingsStore

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_thinking_levels (
        thread_id      TEXT PRIMARY KEY,
        thinking_level TEXT NOT NULL,
        updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `)
    store = new ThreadSettingsStore(db)
  })

  afterEach(() => {
    db.close()
  })

  it('clearThinkingLevel 删除存在的记录', () => {
    store.setThinkingLevel('thread-1', 'high')
    const existed = store.clearThinkingLevel('thread-1')
    expect(existed).toBe(true)
    expect(store.getThinkingLevel('thread-1')).toBeUndefined()
    // SQLite 行也被删除
    const row = db
      .prepare('SELECT 1 FROM thread_thinking_levels WHERE thread_id = ?')
      .get('thread-1')
    expect(row).toBeUndefined()
  })

  it('clearThinkingLevel 对不存在的 thread 返回 false', () => {
    expect(store.clearThinkingLevel('nonexistent')).toBe(false)
  })
})

describe('ThreadSettingsStore：校验', () => {
  let db: Database.Database
  let store: ThreadSettingsStore

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_thinking_levels (
        thread_id      TEXT PRIMARY KEY,
        thinking_level TEXT NOT NULL,
        updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `)
    store = new ThreadSettingsStore(db)
  })

  afterEach(() => {
    db.close()
  })

  it('setThinkingLevel 拒绝无效 level', () => {
    expect(() => store.setThinkingLevel('thread-1', 'invalid-level' as never)).toThrow(
      /无效的 thinkingLevel/
    )
  })

  it('setThinkingLevel 接受 6 档 SDK ThinkingLevel 枚举', () => {
    for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
      store.setThinkingLevel('thread-1', level as never)
      expect(store.getThinkingLevel('thread-1')).toBe(level)
    }
  })
})

describe('ThreadSettingsStore：启动加载', () => {
  it('从已有 SQLite 行加载到内存', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_thinking_levels (
        thread_id      TEXT PRIMARY KEY,
        thinking_level TEXT NOT NULL,
        updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `)
    // 模拟"已有数据"：直接 SQL 写入
    db.prepare(
      'INSERT INTO thread_thinking_levels (thread_id, thinking_level) VALUES (?, ?)'
    ).run('preloaded', 'xhigh')
    db.prepare(
      'INSERT INTO thread_thinking_levels (thread_id, thinking_level) VALUES (?, ?)'
    ).run('preloaded-invalid', 'bogus-value') // 应当被忽略

    const store = new ThreadSettingsStore(db)
    expect(store.getThinkingLevel('preloaded')).toBe('xhigh')
    // 无效值不进入内存 Map
    expect(store.getThinkingLevel('preloaded-invalid')).toBeUndefined()
    db.close()
  })
})