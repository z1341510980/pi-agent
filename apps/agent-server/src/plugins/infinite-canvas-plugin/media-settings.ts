import type Database from 'better-sqlite3'
import {
  normalizeMediaProtocol,
  type MediaProtocol
} from '../../core/config/provider-config-store.js'

export interface CanvasMediaSettings {
  imageBaseUrl: string
  imageApiKey: string
  imageModel: string
  imageSize: string
  imageProtocol: MediaProtocol
  imageResolution: string
  imageLanguage: string
}

interface MediaSettingsRow {
  image_base_url: string
  image_api_key: string
  image_model: string
  image_size: string
  image_protocol?: string
  image_resolution?: string
  image_language?: string
}

const DEFAULTS: CanvasMediaSettings = {
  imageBaseUrl: '',
  imageApiKey: '',
  imageModel: '',
  imageSize: '1024x1024',
  imageProtocol: 'openai-images',
  imageResolution: '',
  imageLanguage: 'en'
}

/** 画布独立的生图配置：与 LLM Provider 的 Key/Base URL 完全分离。 */
export class CanvasMediaSettingsService {
  private readonly db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
    this.db
      .prepare('INSERT OR IGNORE INTO infinite_canvas_media_settings (id) VALUES (?)')
      .run('default')
  }

  get(): CanvasMediaSettings {
    const row = this.db
      .prepare('SELECT * FROM infinite_canvas_media_settings WHERE id = ?')
      .get('default') as MediaSettingsRow | undefined
    if (!row) return { ...DEFAULTS }
    return {
      imageBaseUrl: row.image_base_url,
      imageApiKey: row.image_api_key,
      imageModel: row.image_model,
      imageSize: row.image_size,
      imageProtocol: normalizeMediaProtocol(row.image_protocol),
      imageResolution: row.image_resolution || '',
      imageLanguage: row.image_language || 'en'
    }
  }

  /** 返回脱敏后的配置（前端展示用，不回传完整 Key）。 */
  getStatus(): {
    configured: boolean
    baseUrl: string
    model: string
    imageSize: string
    imageProtocol: MediaProtocol
    imageResolution: string
    imageLanguage: string
    keyHint: string
  } {
    const config = this.get()
    const key = config.imageApiKey
    return {
      configured: Boolean(config.imageBaseUrl && config.imageApiKey),
      baseUrl: config.imageBaseUrl,
      model: config.imageModel,
      imageSize: config.imageSize,
      imageProtocol: config.imageProtocol,
      imageResolution: config.imageResolution,
      imageLanguage: config.imageLanguage,
      keyHint: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : ''
    }
  }

  update(patch: Partial<CanvasMediaSettings>): CanvasMediaSettings {
    const current = this.get()
    const next: CanvasMediaSettings = {
      imageBaseUrl: patch.imageBaseUrl ?? current.imageBaseUrl,
      imageApiKey: patch.imageApiKey ?? current.imageApiKey,
      imageModel: patch.imageModel ?? current.imageModel,
      imageSize: patch.imageSize ?? current.imageSize,
      imageProtocol: normalizeMediaProtocol(patch.imageProtocol ?? current.imageProtocol),
      imageResolution: patch.imageResolution ?? current.imageResolution,
      imageLanguage: patch.imageLanguage?.trim() || current.imageLanguage || 'en'
    }
    this.db
      .prepare(
        `UPDATE infinite_canvas_media_settings
         SET image_base_url = ?, image_api_key = ?, image_model = ?, image_size = ?,
             image_protocol = ?, image_resolution = ?, image_language = ?, updated_at = unixepoch()
         WHERE id = 'default'`
      )
      .run(
        next.imageBaseUrl,
        next.imageApiKey,
        next.imageModel,
        next.imageSize,
        next.imageProtocol,
        next.imageResolution,
        next.imageLanguage
      )
    return next
  }

  /** 是否已配置了画布独立的生图端点。 */
  isConfigured(): boolean {
    const config = this.get()
    return Boolean(config.imageBaseUrl && config.imageApiKey)
  }
}
