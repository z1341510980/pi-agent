/**
 * ProxyConfigStore：出站代理配置存储
 *
 * 持久化到 SQLite（proxy_config 表，单行 id=1），进程重启后自动恢复。
 * 与前端 settings/general-settings.tsx 的 ProxyConfig 类型对齐。
 *
 * 内存中保存配置作为读缓存，写操作同步落库。
 */

import type Database from 'better-sqlite3'

export type ProxyMode = 'none' | 'system' | 'manual'

export interface ProxyConfig {
  mode: ProxyMode
  host: string
  port: string
  username: string
  password: string
}

export const defaultProxyConfig: ProxyConfig = {
  mode: 'system',
  host: '',
  port: '',
  username: '',
  password: '',
}

/**
 * 校验并规范化 ProxyConfig，防止脏数据写入
 */
export function normalizeProxyConfig(data: unknown): ProxyConfig {
  if (!data || typeof data !== 'object') return { ...defaultProxyConfig }
  const obj = data as Record<string, unknown>
  const mode: ProxyMode =
    obj.mode === 'none' || obj.mode === 'system' || obj.mode === 'manual'
      ? obj.mode
      : defaultProxyConfig.mode
  return {
    mode,
    host: typeof obj.host === 'string' ? obj.host : '',
    port: typeof obj.port === 'string' ? obj.port : '',
    username: typeof obj.username === 'string' ? obj.username : '',
    password: typeof obj.password === 'string' ? obj.password : '',
  }
}

/** proxy_config 表行结构 */
interface ProxyRow {
  id: number
  mode: string
  host: string
  port: string
  username: string
  password: string
}

export class ProxyConfigStore {
  private config: ProxyConfig = { ...defaultProxyConfig }
  private readonly stmtSelect: Database.Statement
  private readonly stmtUpsert: Database.Statement

  constructor(db: Database.Database) {
    // 预编译 SQL
    this.stmtSelect = db.prepare('SELECT * FROM proxy_config WHERE id = 1')
    this.stmtUpsert = db.prepare(`
      INSERT INTO proxy_config (id, mode, host, port, username, password)
      VALUES (1, @mode, @host, @port, @username, @password)
      ON CONFLICT(id) DO UPDATE SET
        mode     = excluded.mode,
        host     = excluded.host,
        port     = excluded.port,
        username = excluded.username,
        password = excluded.password
    `)

    // 启动时从 SQLite 加载配置到内存
    const row = this.stmtSelect.get() as ProxyRow | undefined
    if (row) {
      this.config = normalizeProxyConfig({
        mode: row.mode,
        host: row.host,
        port: row.port,
        username: row.username,
        password: row.password,
      })
    }
  }

  /** 设置代理配置 */
  set(config: ProxyConfig): void {
    // 先更新内存
    this.config = { ...config }
    // 同步写入 SQLite（UPSERT）
    this.stmtUpsert.run({
      mode: config.mode,
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
    })
  }

  /** 获取代理配置 */
  get(): ProxyConfig {
    return { ...this.config }
  }
}
