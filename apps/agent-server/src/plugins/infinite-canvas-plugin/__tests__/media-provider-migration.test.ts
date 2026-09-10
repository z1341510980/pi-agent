import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { applyMigrations, MIGRATIONS } from '../../../core/db/migrations.js'
import { infiniteCanvasMigrations } from '../migrations.js'
import { MediaProviderStore } from '../media/media-provider-store.js'
import { applyPluginMediaMigration } from '../media/__tests__/plugin-media-db.js'

const PLUGIN_MEDIA_MIGRATION_ID = '018_create_infinite_canvas_media_providers'
const pluginMediaMigration = infiniteCanvasMigrations.find(
  (item) => item.id === PLUGIN_MEDIA_MIGRATION_ID
)
const legacyPluginMigrations = infiniteCanvasMigrations.filter(
  (item) => item.id !== PLUGIN_MEDIA_MIGRATION_ID
)

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  )
}

/** 建库：真实执行 001–017 宿主迁移（含 017 建宿主 media_providers）+ 插件 116–123。 */
function createDb(withHostTable: boolean): Database.Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY);')
  const hostMigrations = withHostTable
    ? MIGRATIONS
    : MIGRATIONS.filter((item) => item.id !== '017_create_media_providers')
  applyMigrations(db, hostMigrations)
  applyMigrations(db, legacyPluginMigrations)
  return db
}

interface HostProviderSeed {
  id: string
  name: string
  modality?: string
  adapter?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  params?: string
  enabled?: number
  isDefault?: number
}

function seedHostMediaProvider(db: Database.Database, seed: HostProviderSeed): void {
  db.prepare(
    `INSERT INTO media_providers (
      id, name, modality, adapter, base_url, api_key, model, params,
      enabled, is_default, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 100, 100)`
  ).run(
    seed.id,
    seed.name,
    seed.modality ?? 'image',
    seed.adapter ?? 'openai-images',
    seed.baseUrl ?? 'https://host.example.com/v1',
    seed.apiKey ?? 'sk-host',
    seed.model ?? 'gpt-image-1',
    seed.params ?? '{}',
    seed.enabled ?? 1,
    seed.isDefault ?? 0
  )
}

describe('018_create_infinite_canvas_media_providers', () => {
  it('migrates host rows into the plugin table and drops the host table (存量库)', () => {
    const db = createDb(true)
    seedHostMediaProvider(db, {
      id: 'host-default',
      name: '宿主默认',
      isDefault: 1,
      params: '{"size":"1024x1024"}'
    })
    seedHostMediaProvider(db, {
      id: 'host-second',
      name: '宿主第二',
      adapter: 'apimart',
      model: 'gpt-image-2',
      params: '{"resolution":"2k","language":"ja"}'
    })

    applyPluginMediaMigration(db)

    expect(tableExists(db, 'media_providers')).toBe(false)
    const store = new MediaProviderStore(db)
    const rows = store.list('image')
    expect(rows.map((row) => row.id)).toEqual(['host-default', 'host-second'])
    expect(rows[0]).toMatchObject({
      name: '宿主默认',
      adapter: 'openai-images',
      baseUrl: 'https://host.example.com/v1',
      apiKey: 'sk-host',
      model: 'gpt-image-1',
      params: { size: '1024x1024' },
      enabled: true,
      isDefault: true
    })
    expect(rows[1]).toMatchObject({
      adapter: 'apimart',
      params: { resolution: '2k', language: 'ja' },
      isDefault: false
    })
    expect(store.resolveDefault('image')?.id).toBe('host-default')
    db.close()
  })

  it('leaves an empty plugin table and removes the fresh empty host table (全新库)', () => {
    // 全新库：宿主 017 先建空表 → 018 建插件表、搬 0 行、DROP 宿主表
    const db = createDb(true)
    expect(tableExists(db, 'media_providers')).toBe(true)

    applyPluginMediaMigration(db)

    expect(tableExists(db, 'media_providers')).toBe(false)
    expect(tableExists(db, 'infinite_canvas_media_providers')).toBe(true)
    expect(new MediaProviderStore(db).list()).toEqual([])
    db.close()
  })

  it('applies cleanly when the host table never existed (极旧库)', () => {
    const db = createDb(false)
    applyPluginMediaMigration(db)

    expect(tableExists(db, 'media_providers')).toBe(false)
    expect(tableExists(db, 'infinite_canvas_media_providers')).toBe(true)
    expect(new MediaProviderStore(db).list()).toEqual([])
    db.close()
  })

  it('is idempotent across ledger re-runs and re-applies', () => {
    const db = createDb(true)
    seedHostMediaProvider(db, { id: 'host-default', name: '宿主默认', isDefault: 1 })

    applyPluginMediaMigration(db)
    const firstRun = new MediaProviderStore(db).list('image')
    expect(firstRun).toHaveLength(1)

    // 正常重跑：迁移已被 ledger 记录，直接跳过（宿主表也不会复活）
    applyPluginMediaMigration(db)
    expect(new MediaProviderStore(db).list('image')).toEqual(firstRun)
    expect(tableExists(db, 'media_providers')).toBe(false)

    // ledger 记录丢失时重跑：宿主表已不存在 → 守卫直接跳过，插件表数据不重复
    db.prepare('DELETE FROM schema_migrations WHERE id = ?').run(PLUGIN_MEDIA_MIGRATION_ID)
    applyPluginMediaMigration(db)
    expect(new MediaProviderStore(db).list('image')).toEqual(firstRun)
    expect(db.prepare('SELECT COUNT(*) AS n FROM infinite_canvas_media_providers').get()).toEqual({
      n: 1
    })
    db.close()
  })

  it('runs as part of the plugin migration list in order (随插件迁移列表执行)', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY);')
    applyMigrations(db, MIGRATIONS.filter((item) => item.id !== '017_create_media_providers'))
    // 插件迁移 018 接在 123 后：一次 applyMigrations 全列表执行
    applyMigrations(db, infiniteCanvasMigrations)

    expect(tableExists(db, 'media_providers')).toBe(false)
    expect(tableExists(db, 'infinite_canvas_media_providers')).toBe(true)
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE id = ?')
      .get(PLUGIN_MEDIA_MIGRATION_ID)).toBeTruthy()
    db.close()
  })
})
