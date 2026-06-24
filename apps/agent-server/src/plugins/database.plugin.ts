/**
 * Database 插件
 *
 * 统一管理 SQLite 连接，所有持久化存储共享同一个数据库文件。
 * 数据库路径：{dataDir}/pi-agent.db
 *
 * 使用 WAL 模式实现并发读写，无需手动加锁。
 * 迁移在插件初始化时自动执行（幂等）。
 */

import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { runMigrations } from '../core/db/migrations.js'

export const databasePlugin: FastifyPluginAsync = fp(async (app) => {
  const dataDir = process.env.PI_DATA_DIR ?? join(homedir(), '.pi')
  const agentDir = join(dataDir, 'agent')
  mkdirSync(agentDir, { recursive: true })

  const dbPath = join(dataDir, 'pi-agent.db')
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
