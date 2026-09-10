import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { applyMigrations, MIGRATIONS } from '../core/db/migrations.js'
import { MediaProviderStore } from '../core/media/media-provider-store.js'

const MEDIA_MIGRATION_ID = '017_create_media_providers'
const mediaMigration = MIGRATIONS.find((item) => item.id === MEDIA_MIGRATION_ID)
const legacyMigrations = MIGRATIONS.filter((item) => item.id !== MEDIA_MIGRATION_ID)

/** 建库：真实执行 001–016 宿主迁移，按需补建画布媒体设置表（插件迁移 119/120 的最终形态）。 */
function createLegacyDb(withCanvasSettings: boolean): Database.Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY);')
  applyMigrations(db, legacyMigrations)
  if (withCanvasSettings) {
    db.exec(`
      CREATE TABLE infinite_canvas_media_settings (
        id TEXT PRIMARY KEY DEFAULT 'default',
        image_base_url TEXT NOT NULL DEFAULT '',
        image_api_key TEXT NOT NULL DEFAULT '',
        image_model TEXT NOT NULL DEFAULT '',
        image_size TEXT NOT NULL DEFAULT '1024x1024',
        updated_at INTEGER,
        image_protocol TEXT NOT NULL DEFAULT 'openai-images',
        image_resolution TEXT NOT NULL DEFAULT '',
        image_language TEXT NOT NULL DEFAULT 'en'
      )
    `)
  }
  return db
}

interface LegacyProviderSeed {
  id: string
  name: string
  baseUrl?: string
  apiKey?: string
  mediaProtocol?: string
  mediaModel?: string
  mediaResolution?: string
  mediaLanguage?: string
  updatedAt?: number
}

function seedProvider(db: Database.Database, seed: LegacyProviderSeed): void {
  db.prepare(
    `INSERT INTO providers (
      id, name, base_url, api_key, api, auth_header, models,
      media_protocol, media_model, media_resolution, media_language, updated_at
    ) VALUES (?, ?, ?, ?, 'openai-completions', 1, '[]', ?, ?, ?, ?, ?)`
  ).run(
    seed.id,
    seed.name,
    seed.baseUrl ?? 'https://legacy.example.com/v1',
    seed.apiKey ?? 'sk-legacy',
    seed.mediaProtocol ?? 'openai-images',
    seed.mediaModel ?? '',
    seed.mediaResolution ?? '',
    seed.mediaLanguage ?? 'en',
    seed.updatedAt ?? 100
  )
}

function seedCanvasSettings(
  db: Database.Database,
  values: {
    baseUrl?: string
    apiKey?: string
    model?: string
    size?: string
    protocol?: string
    resolution?: string
    language?: string
  }
): void {
  db.prepare(
    `INSERT INTO infinite_canvas_media_settings (
      id, image_base_url, image_api_key, image_model, image_size,
      updated_at, image_protocol, image_resolution, image_language
    ) VALUES ('default', ?, ?, ?, ?, 1, ?, ?, ?)`
  ).run(
    values.baseUrl ?? '',
    values.apiKey ?? '',
    values.model ?? '',
    values.size ?? '1024x1024',
    values.protocol ?? 'openai-images',
    values.resolution ?? '',
    values.language ?? 'en'
  )
}

function applyMediaMigration(db: Database.Database): void {
  applyMigrations(db, [mediaMigration!])
}

describe('017_create_media_providers', () => {
  it('imports both legacy sources with the canvas override as image default', () => {
    const db = createLegacyDb(true)
    seedCanvasSettings(db, {
      baseUrl: 'https://canvas.example.com/v1',
      apiKey: 'sk-canvas',
      model: 'gpt-image-1',
      size: '1792x1024',
      protocol: 'apimart',
      resolution: '2k',
      language: 'zh'
    })
    seedProvider(db, {
      id: 'p1',
      name: '聚合平台',
      mediaProtocol: 'apimart',
      mediaModel: 'gpt-image-2',
      mediaResolution: '4k',
      mediaLanguage: 'ja'
    })
    applyMediaMigration(db)

    const store = new MediaProviderStore(db)
    const rows = store.list('image')
    expect(rows).toHaveLength(2)

    const canvas = rows.find((row) => row.id === 'mig-canvas-default')
    expect(canvas).toMatchObject({
      name: '画布生图（迁移）',
      modality: 'image',
      adapter: 'apimart',
      baseUrl: 'https://canvas.example.com/v1',
      apiKey: 'sk-canvas',
      model: 'gpt-image-1',
      params: { size: '1792x1024', resolution: '2k', language: 'zh' },
      enabled: true,
      isDefault: true
    })

    const provider = rows.find((row) => row.id === 'mig-provider-p1')
    expect(provider).toMatchObject({
      name: '聚合平台（媒体）',
      adapter: 'apimart',
      baseUrl: 'https://legacy.example.com/v1',
      apiKey: 'sk-legacy',
      model: 'gpt-image-2',
      params: { resolution: '4k', language: 'ja' },
      isDefault: false
    })

    expect(store.resolveDefault('image')?.id).toBe('mig-canvas-default')
    db.close()
  })

  it('imports only providers when the canvas settings table has never existed', () => {
    const db = createLegacyDb(false)
    seedProvider(db, {
      id: 'p1',
      name: '先配的',
      mediaModel: 'gpt-image-1',
      updatedAt: 100
    })
    seedProvider(db, {
      id: 'p2',
      name: '后配的',
      mediaProtocol: 'apimart',
      mediaModel: 'gpt-image-2',
      updatedAt: 200
    })
    // 未配置媒体列的 Provider（media_protocol 恒有默认值）不得导入
    seedProvider(db, { id: 'p3', name: '纯聊天', updatedAt: 300 })
    // 显式 apimart 协议但没填媒体模型的也算已配置
    seedProvider(db, {
      id: 'p4',
      name: '只选协议',
      mediaProtocol: 'apimart',
      updatedAt: 400
    })
    applyMediaMigration(db)

    const store = new MediaProviderStore(db)
    const rows = store.list('image')
    expect(rows.map((row) => row.id)).toEqual([
      'mig-provider-p1',
      'mig-provider-p2',
      'mig-provider-p4'
    ])
    expect(rows[0]).toMatchObject({
      name: '先配的（媒体）',
      adapter: 'openai-images',
      model: 'gpt-image-1',
      isDefault: true
    })
    expect(rows[1].isDefault).toBe(false)
    expect(rows[2].isDefault).toBe(false)
    db.close()
  })

  it('skips an unconfigured canvas row and defaults to the first provider import', () => {
    const db = createLegacyDb(true)
    seedCanvasSettings(db, { baseUrl: 'https://canvas.example.com/v1', apiKey: '' })
    seedProvider(db, { id: 'p1', name: '唯一', mediaModel: 'gpt-image-1' })
    applyMediaMigration(db)

    const store = new MediaProviderStore(db)
    const rows = store.list('image')
    expect(rows.map((row) => row.id)).toEqual(['mig-provider-p1'])
    expect(rows[0].isDefault).toBe(true)
    db.close()
  })

  it('imports nothing when there is no legacy configuration', () => {
    const db = createLegacyDb(true)
    seedCanvasSettings(db, {})
    applyMediaMigration(db)

    expect(new MediaProviderStore(db).list()).toEqual([])
    db.close()
  })

  it('is idempotent across ledger re-runs and re-applies', () => {
    const db = createLegacyDb(true)
    seedCanvasSettings(db, {
      baseUrl: 'https://canvas.example.com/v1',
      apiKey: 'sk-canvas',
      model: 'gpt-image-1'
    })
    seedProvider(db, { id: 'p1', name: '聚合', mediaModel: 'gpt-image-1' })

    applyMediaMigration(db)
    const firstRun = new MediaProviderStore(db).list('image')
    expect(firstRun).toHaveLength(2)

    // 正常重跑：迁移已被 ledger 记录，直接跳过
    applyMediaMigration(db)
    expect(new MediaProviderStore(db).list('image')).toEqual(firstRun)

    // ledger 记录丢失时重跑：insertIfAbsent 守卫保证不重复导入
    db.prepare('DELETE FROM schema_migrations WHERE id = ?').run(MEDIA_MIGRATION_ID)
    applyMediaMigration(db)
    expect(new MediaProviderStore(db).list('image')).toEqual(firstRun)
    expect(db.prepare('SELECT COUNT(*) AS n FROM media_providers').get()).toEqual({ n: 2 })
    db.close()
  })
})
