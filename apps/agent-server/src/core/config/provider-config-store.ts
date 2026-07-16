/**
 * ProviderConfigStore：前端动态注册的 Provider 配置存储
 *
 * 持久化到 SQLite（providers 表），进程重启后自动恢复。
 * 与 ModelRegistry 互补：
 * - ModelRegistry：Pi SDK 内置模型 + models.json 自定义模型
 * - 本存储：前端用户在设置页面配置的 Provider（含 API Key）
 *
 * 内存 Map 作为读缓存，写操作同步落库以保证一致性。
 * models 字段在 SQLite 中以 JSON 字符串存储；auth_header 以 0/1 存储。
 */

import type Database from 'better-sqlite3'

export interface ProviderModelConfig {
  id: string
  name: string
  reasoning?: boolean
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  contextWindow?: number
  maxTokens?: number
}

export interface ProviderConfig {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  api: string
  authHeader?: boolean
  models: ProviderModelConfig[]
}

/** providers 表行结构 */
interface ProviderRow {
  id: string
  name: string
  base_url: string
  api_key: string
  api: string
  auth_header: number
  models: string
  updated_at: number
}

export class ProviderConfigStore {
  private readonly providers = new Map<string, ProviderConfig>()
  private readonly stmtSelectAll: Database.Statement
  private readonly stmtUpsert: Database.Statement
  private readonly stmtDelete: Database.Statement
  private readonly stmtGetSetting: Database.Statement
  private readonly stmtSetSetting: Database.Statement
  private readonly stmtDeleteSetting: Database.Statement

  constructor(db: Database.Database) {
    // 预编译 SQL，提升反复执行性能
    this.stmtSelectAll = db.prepare('SELECT * FROM providers')
    this.stmtUpsert = db.prepare(`
      INSERT INTO providers (id, name, base_url, api_key, api, auth_header, models, updated_at)
      VALUES (@id, @name, @base_url, @api_key, @api, @auth_header, @models, unixepoch())
      ON CONFLICT(id) DO UPDATE SET
        name        = excluded.name,
        base_url    = excluded.base_url,
        api_key     = excluded.api_key,
        api         = excluded.api,
        auth_header = excluded.auth_header,
        models      = excluded.models,
        updated_at  = unixepoch()
    `)
    this.stmtDelete = db.prepare('DELETE FROM providers WHERE id = ?')
    this.stmtGetSetting = db.prepare('SELECT value FROM app_settings WHERE key = ?')
    this.stmtSetSetting = db.prepare(`
      INSERT INTO app_settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `)
    this.stmtDeleteSetting = db.prepare('DELETE FROM app_settings WHERE key = ?')

    // 启动时把所有 providers 加载到内存 Map 作为读缓存
    const rows = this.stmtSelectAll.all() as ProviderRow[]
    for (const row of rows) {
      this.providers.set(row.id, this.rowToConfig(row))
    }
  }

  /** 将数据库行转换为 ProviderConfig */
  private rowToConfig(row: ProviderRow): ProviderConfig {
    let models: ProviderModelConfig[] = []
    try {
      const parsed = JSON.parse(row.models)
      if (Array.isArray(parsed)) models = parsed
    } catch {
      // models 字段损坏时回退为空数组
    }
    return {
      id: row.id,
      name: row.name,
      baseUrl: row.base_url,
      apiKey: row.api_key,
      api: row.api,
      authHeader: row.auth_header === 1,
      models,
    }
  }

  /** 注册或更新 Provider 配置 */
  upsert(config: ProviderConfig): void {
    // 先更新内存 Map
    this.providers.set(config.id, config)
    // 同步写入 SQLite（UPSERT）
    this.stmtUpsert.run({
      id: config.id,
      name: config.name,
      base_url: config.baseUrl,
      api_key: config.apiKey,
      api: config.api,
      auth_header: config.authHeader === false ? 0 : 1,
      models: JSON.stringify(config.models ?? []),
    })
  }

  /** 获取 Provider 配置 */
  get(id: string): ProviderConfig | undefined {
    return this.providers.get(id)
  }

  /** 列出所有 Provider 配置 */
  list(): ProviderConfig[] {
    return Array.from(this.providers.values())
  }

  /** 删除 Provider 配置；若被删的是默认 Provider，同步清空默认设置 */
  delete(id: string): boolean {
    const result = this.providers.delete(id)
    if (result) {
      this.stmtDelete.run(id)
      // 清理默认 Provider 设置（如果被删的正好是默认的）
      if (this.getDefaultProviderId() === id) {
        this.clearDefaultProviderId()
      }
    }
    return result
  }

  /** 获取指定 Provider 的 API Key */
  getApiKey(providerId: string): string | undefined {
    return this.providers.get(providerId)?.apiKey
  }

  // ── 默认 Provider 设置 ──

  private static readonly DEFAULT_PROVIDER_KEY = 'default_provider_id'

  /** 读取默认 Provider ID；未设置或指向已不存在的 Provider 时返回 undefined */
  getDefaultProviderId(): string | undefined {
    const row = this.stmtGetSetting.get(ProviderConfigStore.DEFAULT_PROVIDER_KEY) as { value: string } | undefined
    const id = row?.value
    if (!id) return undefined
    // 校验对应的 Provider 仍然存在，避免脏数据
    return this.providers.has(id) ? id : undefined
  }

  /** 设置默认 Provider ID */
  setDefaultProviderId(id: string): void {
    if (!this.providers.has(id)) {
      throw new Error(`Provider "${id}" 不存在，无法设为默认`)
    }
    this.stmtSetSetting.run(ProviderConfigStore.DEFAULT_PROVIDER_KEY, id)
  }

  /** 清除默认 Provider 设置 */
  clearDefaultProviderId(): void {
    this.stmtDeleteSetting.run(ProviderConfigStore.DEFAULT_PROVIDER_KEY)
  }

  // ── stream_options 屏蔽开关 ──

  private static readonly STRIP_STREAM_OPTIONS_KEY = 'strip_stream_options'

  /**
   * 读取 stream_options 屏蔽开关。
   *
   * 某些 OpenAI 兼容中转（如 fastaitoken.com）不兼容 OpenAI 1.x 的
   * `stream_options.include_usage` 参数，收到后会断流导致
   * `Stream ended without finish_reason`。开启后 Pi SDK 发请求前会移除该字段。
   *
   * 默认关闭（false）以保留 token 用量统计能力。
   */
  getStripStreamOptions(): boolean {
    const row = this.stmtGetSetting.get(ProviderConfigStore.STRIP_STREAM_OPTIONS_KEY) as { value: string } | undefined
    return row?.value === 'true'
  }

  /** 设置 stream_options 屏蔽开关 */
  setStripStreamOptions(enabled: boolean): void {
    this.stmtSetSetting.run(ProviderConfigStore.STRIP_STREAM_OPTIONS_KEY, enabled ? 'true' : 'false')
  }
}
