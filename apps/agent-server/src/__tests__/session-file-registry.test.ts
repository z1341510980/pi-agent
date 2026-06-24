import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { SessionFileRegistry } from '../core/session/session-file-registry.js'
import { runMigrations } from '../core/db/migrations.js'

let tempDir: string
let dataDir: string
let sessionDir: string
let db: Database.Database
let registry: SessionFileRegistry

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'pi-sfr-test-'))
  dataDir = join(tempDir, 'data')
  sessionDir = join(tempDir, 'sessions', 'session-1')
  mkdirSync(sessionDir, { recursive: true })
  db = new Database(join(tempDir, 'test.db'))
  runMigrations(db)
  registry = new SessionFileRegistry(db, dataDir)
})

afterEach(() => {
  db.close()
  rmSync(tempDir, { recursive: true, force: true })
})

/** 创建临时源文件 */
function createSourceFile(name: string, content: string): string {
  const filePath = join(tempDir, 'sources', name)
  mkdirSync(join(tempDir, 'sources'), { recursive: true })
  writeFileSync(filePath, content, 'utf-8')
  return filePath
}

describe('SessionFileRegistry — registerFile', () => {
  it('注册 managed_cache 文件并复制到 session-files 目录', () => {
    const sourcePath = createSourceFile('artifact.txt', 'Hello World')
    const record = registry.registerFile({
      filePath: sourcePath,
      sessionPath: sessionDir,
      label: 'artifact.txt',
      origin: 'agent_output',
      storageKind: 'managed_cache',
    })

    expect(record.fileId).toBeTruthy()
    expect(record.createdAt).toBeTruthy()
    expect(record.storageKind).toBe('managed_cache')
    expect(record.contentHash).toBeTruthy()
    // 文件应被复制到 managed_cache 目录
    expect(existsSync(record.filePath)).toBe(true)
    expect(record.filePath).toContain('session-files')
    expect(record.sizeBytes).toBeGreaterThan(0)
  })

  it('注册 external 文件不复制', () => {
    const sourcePath = createSourceFile('external.txt', 'External content')
    const record = registry.registerFile({
      filePath: sourcePath,
      sessionPath: sessionDir,
      label: 'external.txt',
      origin: 'stage_files',
      storageKind: 'external',
    })

    expect(record.storageKind).toBe('external')
    expect(record.contentHash).toBeUndefined()
    // external 文件路径不变
    expect(record.filePath).toBe(sourcePath)
  })

  it('注册 install_source 文件不复制', () => {
    const sourcePath = createSourceFile('template.txt', 'Template content')
    const record = registry.registerFile({
      filePath: sourcePath,
      sessionPath: sessionDir,
      label: 'template.txt',
      origin: 'plugin_output',
      storageKind: 'install_source',
    })

    expect(record.storageKind).toBe('install_source')
    expect(record.contentHash).toBeUndefined()
    expect(record.filePath).toBe(sourcePath)
  })

  it('相同内容的 managed_cache 文件去重（共享存储）', () => {
    const source1 = createSourceFile('file1.txt', 'Same content')
    const source2 = createSourceFile('file2.txt', 'Same content')

    const record1 = registry.registerFile({
      filePath: source1,
      sessionPath: sessionDir,
      label: 'file1.txt',
      origin: 'agent_output',
      storageKind: 'managed_cache',
    })
    const record2 = registry.registerFile({
      filePath: source2,
      sessionPath: sessionDir,
      label: 'file2.txt',
      origin: 'agent_output',
      storageKind: 'managed_cache',
    })

    // 内容相同 → hash 相同 → 共享同一物理文件
    expect(record1.contentHash).toBe(record2.contentHash)
    expect(record1.filePath).toBe(record2.filePath)
  })

  it('不同内容的 managed_cache 文件分别存储', () => {
    const source1 = createSourceFile('file1.txt', 'Content A')
    const source2 = createSourceFile('file2.txt', 'Content B')

    const record1 = registry.registerFile({
      filePath: source1,
      sessionPath: sessionDir,
      label: 'file1.txt',
      origin: 'agent_output',
      storageKind: 'managed_cache',
    })
    const record2 = registry.registerFile({
      filePath: source2,
      sessionPath: sessionDir,
      label: 'file2.txt',
      origin: 'agent_output',
      storageKind: 'managed_cache',
    })

    expect(record1.contentHash).not.toBe(record2.contentHash)
    expect(record1.filePath).not.toBe(record2.filePath)
  })
})

describe('SessionFileRegistry — getFilesForSession', () => {
  it('返回会话的所有文件记录', () => {
    const source1 = createSourceFile('file1.txt', 'Content A')
    const source2 = createSourceFile('file2.txt', 'Content B')

    registry.registerFile({
      filePath: source1,
      sessionPath: sessionDir,
      label: 'file1.txt',
      origin: 'agent_output',
      storageKind: 'managed_cache',
    })
    registry.registerFile({
      filePath: source2,
      sessionPath: sessionDir,
      label: 'file2.txt',
      origin: 'agent_output',
      storageKind: 'external',
    })

    const files = registry.getFilesForSession(sessionDir)
    expect(files).toHaveLength(2)
    expect(files.map((f) => f.label).sort()).toEqual(['file1.txt', 'file2.txt'])
  })

  it('无文件的会话返回空数组', () => {
    const files = registry.getFilesForSession(sessionDir)
    expect(files).toEqual([])
  })

  it('文件记录持久化到 SQLite session_files 表', () => {
    const source = createSourceFile('file1.txt', 'Content A')
    registry.registerFile({
      filePath: source,
      sessionPath: sessionDir,
      label: 'file1.txt',
      origin: 'agent_output',
      storageKind: 'managed_cache',
    })

    // 直接查询 SQLite session_files 表验证持久化
    const rows = db.prepare('SELECT * FROM session_files WHERE session_path = ?').all(sessionDir) as any[]
    expect(rows).toHaveLength(1)
    expect(rows[0].label).toBe('file1.txt')
  })
})

describe('SessionFileRegistry — getFileById', () => {
  it('按 ID 查找文件记录', () => {
    const source = createSourceFile('file1.txt', 'Content A')
    const record = registry.registerFile({
      filePath: source,
      sessionPath: sessionDir,
      label: 'file1.txt',
      origin: 'agent_output',
      storageKind: 'managed_cache',
    })

    const found = registry.getFileById(record.fileId)
    expect(found).not.toBeNull()
    expect(found!.fileId).toBe(record.fileId)
    expect(found!.label).toBe('file1.txt')
  })

  it('不存在的 ID 返回 null', () => {
    const found = registry.getFileById('nonexistent-id')
    expect(found).toBeNull()
  })
})

describe('SessionFileRegistry — cleanupSession', () => {
  it('清理 managed_cache 文件并删除 sidecar', () => {
    const source = createSourceFile('artifact.txt', 'To be cleaned')
    const record = registry.registerFile({
      filePath: source,
      sessionPath: sessionDir,
      label: 'artifact.txt',
      origin: 'agent_output',
      storageKind: 'managed_cache',
    })

    // 确认文件存在
    expect(existsSync(record.filePath)).toBe(true)

    const cleaned = registry.cleanupSession(sessionDir)
    expect(cleaned).toBe(1)
    // 物理文件应被删除
    expect(existsSync(record.filePath)).toBe(false)
    // sidecar 应被删除
    expect(existsSync(join(sessionDir, '.files.json'))).toBe(false)
  })

  it('不清理 external 和 install_source 文件', () => {
    const extSource = createSourceFile('external.txt', 'External')
    const instSource = createSourceFile('install.txt', 'Install')

    registry.registerFile({
      filePath: extSource,
      sessionPath: sessionDir,
      label: 'external.txt',
      origin: 'stage_files',
      storageKind: 'external',
    })
    registry.registerFile({
      filePath: instSource,
      sessionPath: sessionDir,
      label: 'install.txt',
      origin: 'plugin_output',
      storageKind: 'install_source',
    })

    const cleaned = registry.cleanupSession(sessionDir)
    // external 和 install_source 不计入清理
    expect(cleaned).toBe(0)
    // 原文件仍在
    expect(existsSync(extSource)).toBe(true)
    expect(existsSync(instSource)).toBe(true)
    // sidecar 仍被删除
    expect(existsSync(join(sessionDir, '.files.json'))).toBe(false)
  })

  it('多会话引用同一文件时，清理一个会话不删除物理文件', () => {
    const source = createSourceFile('shared.txt', 'Shared content')

    const sessionDir2 = join(tempDir, 'sessions', 'session-2')
    mkdirSync(sessionDir2, { recursive: true })

    const record1 = registry.registerFile({
      filePath: source,
      sessionPath: sessionDir,
      label: 'shared.txt',
      origin: 'agent_output',
      storageKind: 'managed_cache',
    })
    // 第二个会话注册相同内容文件
    const record2 = registry.registerFile({
      filePath: source,
      sessionPath: sessionDir2,
      label: 'shared.txt',
      origin: 'agent_output',
      storageKind: 'managed_cache',
    })

    // 两个会话共享同一物理文件
    expect(record1.filePath).toBe(record2.filePath)
    expect(existsSync(record1.filePath)).toBe(true)

    // 清理第一个会话
    const cleaned1 = registry.cleanupSession(sessionDir)
    expect(cleaned1).toBe(1)
    // 物理文件不应被删除（第二个会话仍在引用）
    expect(existsSync(record1.filePath)).toBe(true)

    // 清理第二个会话
    const cleaned2 = registry.cleanupSession(sessionDir2)
    expect(cleaned2).toBe(1)
    // 现在物理文件应被删除
    expect(existsSync(record1.filePath)).toBe(false)
  })

  it('清理无文件的会话返回 0', () => {
    const cleaned = registry.cleanupSession(sessionDir)
    expect(cleaned).toBe(0)
  })

  it('清理后 sidecar 被删除，getFilesForSession 返回空', () => {
    const source = createSourceFile('artifact.txt', 'Content')
    registry.registerFile({
      filePath: source,
      sessionPath: sessionDir,
      label: 'artifact.txt',
      origin: 'agent_output',
      storageKind: 'managed_cache',
    })

    registry.cleanupSession(sessionDir)

    const files = registry.getFilesForSession(sessionDir)
    expect(files).toEqual([])
  })
})

describe('SessionFileRegistry — 持久化', () => {
  it('重新创建 registry 实例后能读取已有 sidecar', () => {
    const source = createSourceFile('artifact.txt', 'Persistent content')
    const record = registry.registerFile({
      filePath: source,
      sessionPath: sessionDir,
      label: 'artifact.txt',
      origin: 'agent_output',
      storageKind: 'managed_cache',
    })

    // 新实例读取同一数据库文件
    const newDb = new Database(join(tempDir, 'test.db'))
    const newRegistry = new SessionFileRegistry(newDb, dataDir)
    const files = newRegistry.getFilesForSession(sessionDir)
    expect(files).toHaveLength(1)
    expect(files[0].fileId).toBe(record.fileId)
    expect(files[0].label).toBe('artifact.txt')
    newDb.close()
  })

  it('引用计数持久化到 SQLite file_refcount 表', () => {
    const source = createSourceFile('artifact.txt', 'Content')
    registry.registerFile({
      filePath: source,
      sessionPath: sessionDir,
      label: 'artifact.txt',
      origin: 'agent_output',
      storageKind: 'managed_cache',
    })

    // 直接查询 SQLite file_refcount 表验证持久化
    const rows = db.prepare('SELECT * FROM file_refcount').all() as any[]
    expect(rows).toHaveLength(1)
    expect(rows[0].refcount).toBe(1)
  })
})
