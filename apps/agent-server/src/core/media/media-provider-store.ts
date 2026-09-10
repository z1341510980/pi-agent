/**
 * MediaProviderStore：媒体生成 Provider 配置存储（media_providers 表）。
 *
 * 与 provider-config-store 同款模式：better-sqlite3 同步语句 + 预编译，
 * DB 由构造注入；表结构由宿主迁移 017_create_media_providers 创建，本 store 只读写。
 * text 模态复用现有 provider-config-store（spec §4），不入本表。
 * params 列以 JSON 字符串存储，读写边界在此转换，坏数据回退空对象。
 */

import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { MediaModality, MediaProviderRow } from './adapter.js'

/** 实际落库的模态集合（不含 text）。 */
export const STORED_MEDIA_MODALITIES = ['image', 'audio', 'video'] as const
export type StoredMediaModality = (typeof STORED_MEDIA_MODALITIES)[number]

/** media_providers 表行结构 */
interface MediaProviderDbRow {
  id: string
  name: string
  modality: string
  adapter: string
  base_url: string
  api_key: string
  model: string
  params: string
  enabled: number
  is_default: number
  created_at: number
  updated_at: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/** params 列 JSON 反序列化；损坏或非对象数据回退空对象。 */
function parseParams(raw: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function rowToProvider(row: MediaProviderDbRow): MediaProviderRow {
  return {
    id: row.id,
    name: row.name,
    modality: row.modality as MediaProviderRow['modality'],
    adapter: row.adapter,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    model: row.model,
    params: parseParams(row.params),
    enabled: row.enabled === 1,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export interface CreateMediaProviderInput {
  name: string
  modality: StoredMediaModality
  adapter: string
  baseUrl?: string
  apiKey?: string
  model?: string
  params?: Record<string, string>
}

export type UpdateMediaProviderPatch = Partial<{
  name: string
  modality: StoredMediaModality
  adapter: string
  baseUrl: string
  apiKey: string
  model: string
  params: Record<string, string>
  enabled: boolean
}>

export class MediaProviderStore {
  private readonly db: Database.Database
  private readonly stmtSelectAll: Database.Statement
  private readonly stmtSelectByModality: Database.Statement
  private readonly stmtSelectById: Database.Statement
  private readonly stmtSelectDefault: Database.Statement
  private readonly stmtInsert: Database.Statement
  private readonly stmtDelete: Database.Statement
  private readonly stmtClearDefault: Database.Statement
  private readonly stmtSetDefault: Database.Statement

  constructor(db: Database.Database) {
    this.db = db
    // 预编译 SQL，提升反复执行性能
    this.stmtSelectAll = db.prepare('SELECT * FROM media_providers ORDER BY created_at, id')
    this.stmtSelectByModality = db.prepare(
      'SELECT * FROM media_providers WHERE modality = ? ORDER BY created_at, id'
    )
    this.stmtSelectById = db.prepare('SELECT * FROM media_providers WHERE id = ?')
    this.stmtSelectDefault = db.prepare(
      'SELECT * FROM media_providers WHERE modality = ? AND enabled = 1 AND is_default = 1 LIMIT 1'
    )
    this.stmtInsert = db.prepare(`
      INSERT INTO media_providers (
        id, name, modality, adapter, base_url, api_key, model, params,
        enabled, is_default, created_at, updated_at
      )
      VALUES (
        @id, @name, @modality, @adapter, @base_url, @api_key, @model, @params,
        @enabled, 0, unixepoch(), unixepoch()
      )
    `)
    this.stmtDelete = db.prepare('DELETE FROM media_providers WHERE id = ?')
    this.stmtClearDefault = db.prepare(
      'UPDATE media_providers SET is_default = 0 WHERE modality = ?'
    )
    this.stmtSetDefault = db.prepare(
      'UPDATE media_providers SET is_default = 1, updated_at = unixepoch() WHERE id = ?'
    )
  }

  /** 列出 Provider；可按模态过滤（含未启用项，调用方按需过滤）。 */
  list(modality?: StoredMediaModality): MediaProviderRow[] {
    const rows = (
      modality ? this.stmtSelectByModality.all(modality) : this.stmtSelectAll.all()
    ) as MediaProviderDbRow[]
    return rows.map(rowToProvider)
  }

  /** 获取 Provider 配置 */
  get(id: string): MediaProviderRow | undefined {
    const row = this.stmtSelectById.get(id) as MediaProviderDbRow | undefined
    return row ? rowToProvider(row) : undefined
  }

  /** 创建 Provider；id 服务端生成（randomUUID），新行不自动成为默认。 */
  create(input: CreateMediaProviderInput): MediaProviderRow {
    // 运行时兜底：JS 调用方绕过类型时防止 text 行落库
    if ((input.modality as MediaModality) === 'text') {
      throw new Error('text 模态复用 LLM Provider 体系，不写入 media_providers')
    }
    const id = randomUUID()
    this.stmtInsert.run({
      id,
      name: input.name,
      modality: input.modality,
      adapter: input.adapter,
      base_url: input.baseUrl ?? '',
      api_key: input.apiKey ?? '',
      model: input.model ?? '',
      params: JSON.stringify(input.params ?? {}),
      enabled: 1
    })
    return this.get(id)!
  }

  /**
   * 更新 Provider（部分字段）。
   * 对齐 provider.route 的「空 Key 保留」语义：apiKey 为空串/纯空白时不覆盖旧值。
   * modality 变更时清掉自身的默认标记，避免跨模态默认冲突。
   */
  update(id: string, patch: UpdateMediaProviderPatch): MediaProviderRow | undefined {
    const existing = this.get(id)
    if (!existing) return undefined

    const sets: string[] = []
    const args: Record<string, unknown> = { id }
    if (patch.name !== undefined) {
      sets.push('name = @name')
      args.name = patch.name
    }
    if (patch.modality !== undefined && patch.modality !== existing.modality) {
      sets.push('modality = @modality', 'is_default = 0')
      args.modality = patch.modality
    }
    if (patch.adapter !== undefined) {
      sets.push('adapter = @adapter')
      args.adapter = patch.adapter
    }
    if (patch.baseUrl !== undefined) {
      sets.push('base_url = @base_url')
      args.base_url = patch.baseUrl
    }
    if (patch.apiKey !== undefined && patch.apiKey.trim() !== '') {
      sets.push('api_key = @api_key')
      args.api_key = patch.apiKey
    }
    if (patch.model !== undefined) {
      sets.push('model = @model')
      args.model = patch.model
    }
    if (patch.params !== undefined) {
      sets.push('params = @params')
      args.params = JSON.stringify(patch.params)
    }
    if (patch.enabled !== undefined) {
      sets.push('enabled = @enabled')
      args.enabled = patch.enabled ? 1 : 0
    }
    if (sets.length > 0) {
      this.db
        .prepare(
          `UPDATE media_providers SET ${sets.join(', ')}, updated_at = unixepoch() WHERE id = @id`
        )
        .run(args)
    }
    return this.get(id)
  }

  /** 删除 Provider 配置 */
  remove(id: string): boolean {
    return this.stmtDelete.run(id).changes > 0
  }

  /** 设为模态默认：事务内先清同模态旧默认再设置，保证每模态至多一个。 */
  setDefault(id: string): void {
    const existing = this.get(id)
    if (!existing) {
      throw new Error(`媒体 Provider "${id}" 不存在，无法设为默认`)
    }
    this.db.transaction(() => {
      this.stmtClearDefault.run(existing.modality)
      this.stmtSetDefault.run(id)
    })()
  }

  /** 解析模态默认 Provider：enabled 且 is_default；无则 null。 */
  resolveDefault(modality: StoredMediaModality): MediaProviderRow | null {
    const row = this.stmtSelectDefault.get(modality) as MediaProviderDbRow | undefined
    return row ? rowToProvider(row) : null
  }
}
