/**
 * Database 插件
 *
 * 统一管理 SQLite 连接，所有持久化存储共享同一个数据库文件。
 * 数据库路径：{dataDir}/wenlang-agent.db
 *
 * 使用 WAL 模式实现并发读写，无需手动加锁。
 * 迁移在插件初始化时自动执行（幂等）。
 */

import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { mkdirSync, existsSync, renameSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { runMigrations } from '../core/db/migrations.js'

export const databasePlugin: FastifyPluginAsync = fp(async (app) => {
  const dataDir = process.env.PI_DATA_DIR ?? join(homedir(), '.pi')
  const agentDir = join(dataDir, 'agent')
  mkdirSync(agentDir, { recursive: true })

  const dbPath = join(dataDir, 'wenlang-agent.db')
  const oldDbPath = join(dataDir, 'pi-agent.db')

  // 迁移旧数据库文件：pi-agent.db → wenlang-agent.db
  // 仅当新文件不存在但旧文件存在时执行，避免覆盖已有数据
  if (!existsSync(dbPath) && existsSync(oldDbPath)) {
    try {
      // 优先重命名（原子操作），失败则回退到复制
      renameSync(oldDbPath, dbPath)
      app.log.info({ oldDbPath, dbPath }, '已迁移旧数据库 pi-agent.db → wenlang-agent.db')
      // 同步迁移 WAL/SHM 辅助文件（WAL 模式下可能存在）
      for (const ext of ['-wal', '-shm']) {
        const oldAux = oldDbPath + ext
        const newAux = dbPath + ext
        if (existsSync(oldAux) && !existsSync(newAux)) {
          renameSync(oldAux, newAux)
        }
      }
    } catch (renameErr) {
      // 重命名失败（如跨盘符），回退到复制
      try {
        copyFileSync(oldDbPath, dbPath)
        app.log.info({ oldDbPath, dbPath }, '已复制旧数据库 pi-agent.db → wenlang-agent.db（旧文件保留）')
      } catch (copyErr) {
        app.log.error({ oldDbPath, copyErr }, '旧数据库迁移失败，将使用新空数据库启动')
      }
    }
  }

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // 执行迁移
  runMigrations(db)

  app.decorate('db', db)

  app.addHook('onClose', () => {
    db.close()
  })

  app.log.info({ dbPath }, 'SQLite 数据库已初始化')
})
