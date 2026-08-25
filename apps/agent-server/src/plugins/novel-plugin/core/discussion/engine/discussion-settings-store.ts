/**
 * 群聊模式设置存储
 *
 * 单行 key-value 表，存储：
 * - moderatorModel：Moderator 使用的模型（JSON: {provider, modelId}）
 * - maxRounds：总轮数上限（默认 20）
 * - maxRoundsPerScene：单场景轮数上限（默认 10）
 * - characterTemperature：角色 Agent 温度（默认 0.8）
 */

import type Database from 'better-sqlite3'

export interface DiscussionSettings {
  moderatorModel?: { provider: string; modelId: string }
  maxRounds?: number
  maxRoundsPerScene?: number
  characterTemperature?: number
  /** Moderator 单次调用超时毫秒（2026-08-24）：思考型模型延迟普遍 70-150s，默认 90s 可按需调大 */
  moderatorTimeoutMs?: number
}

export class DiscussionSettingsStore {
  private stmtGet: Database.Statement
  private stmtUpsert: Database.Statement

  constructor(private db: Database.Database) {
    this.stmtGet = db.prepare('SELECT value FROM novel_discussion_settings WHERE key = ?')
    this.stmtUpsert = db.prepare(`
      INSERT INTO novel_discussion_settings (key, value, updated_at)
      VALUES (?, ?, unixepoch())
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
    `)
  }

  get(): DiscussionSettings {
    const settings: DiscussionSettings = {}
    const moderatorModel = this.getValue('moderatorModel')
    if (moderatorModel) {
      try { settings.moderatorModel = JSON.parse(moderatorModel) } catch { /* ignore */ }
    }
    const maxRounds = this.getValue('maxRounds')
    if (maxRounds) settings.maxRounds = parseInt(maxRounds, 10)
    const maxRoundsPerScene = this.getValue('maxRoundsPerScene')
    if (maxRoundsPerScene) settings.maxRoundsPerScene = parseInt(maxRoundsPerScene, 10)
    const characterTemperature = this.getValue('characterTemperature')
    if (characterTemperature) settings.characterTemperature = parseFloat(characterTemperature)
    const moderatorTimeoutMs = this.getValue('moderatorTimeoutMs')
    if (moderatorTimeoutMs) {
      const parsed = parseInt(moderatorTimeoutMs, 10)
      if (Number.isFinite(parsed) && parsed > 0) settings.moderatorTimeoutMs = parsed
    }
    return settings
  }

  update(settings: Partial<DiscussionSettings>): void {
    if (settings.moderatorModel !== undefined) {
      this.setValue('moderatorModel', JSON.stringify(settings.moderatorModel))
    }
    if (settings.maxRounds !== undefined) {
      this.setValue('maxRounds', String(settings.maxRounds))
    }
    if (settings.maxRoundsPerScene !== undefined) {
      this.setValue('maxRoundsPerScene', String(settings.maxRoundsPerScene))
    }
    if (settings.characterTemperature !== undefined) {
      this.setValue('characterTemperature', String(settings.characterTemperature))
    }
    if (settings.moderatorTimeoutMs !== undefined) {
      this.setValue('moderatorTimeoutMs', String(settings.moderatorTimeoutMs))
    }
  }

  private getValue(key: string): string | undefined {
    const row = this.stmtGet.get(key) as { value: string } | undefined
    return row?.value
  }

  private setValue(key: string, value: string): void {
    this.stmtUpsert.run(key, value)
  }
}
