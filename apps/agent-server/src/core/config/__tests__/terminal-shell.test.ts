import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { ProviderConfigStore } from '../provider-config-store.js'
import { runMigrations } from '../../db/migrations.js'

/**
 * Agent 终端 Shell 设置的持久化与非法值兜底
 * （自宿主 core/config/media-generator.test.ts 迁出，与媒体体系无关）。
 */
describe('ProviderConfigStore terminal shell', () => {
  it('persists and validates the Agent terminal shell setting', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const store = new ProviderConfigStore(db)

    expect(store.getTerminalShell()).toBe('git-bash')

    store.setTerminalShell('pwsh')
    expect(store.getTerminalShell()).toBe('pwsh')

    db.prepare("UPDATE app_settings SET value = 'unsupported' WHERE key = 'terminal_shell'").run()
    expect(store.getTerminalShell()).toBe('git-bash')

    db.close()
  })
})
