import type Database from 'better-sqlite3'
import type { PluginContext } from '../../core/plugin/plugin-types.js'

export interface PromptSourceRow {
  id: string
  name: string
  url: string
  homepage: string
  enabled: number
  last_fetched_at: number | null
  last_error: string | null
}

export interface PromptItemRow {
  id: string
  source_id: string
  title: string
  prompt: string
  description: string
  tags_json: string
  cover_url: string
  fetched_at: number
}

/** 归一化后的提示词条目（返回给前端）。 */
export interface NormalizedPromptItem {
  id: string
  sourceId: string
  sourceName: string
  title: string
  prompt: string
  description: string
  tags: string[]
  coverUrl: string
}

export interface PromptSourceInfo {
  id: string
  name: string
  url: string
  homepage: string
  enabled: boolean
  lastFetchedAt: number | null
  lastError: string | null
  itemCount: number
}

const PROMPT_REGISTRY_SOURCE_BASE =
  'https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources'

export const DEFAULT_PROMPT_SOURCES = [
  { id: 'banana-prompt-quicker', name: 'Banana Prompt Quicker', homepage: 'https://glidea.github.io/banana-prompt-quicker/' },
  { id: 'davidwu-gpt-image2-prompts', name: 'DavidWu GPT Image 2', homepage: 'https://github.com/davidwuw0811-boop/awesome-gpt-image2-prompts' },
  { id: 'freestylefly-gpt-image-2', name: 'Freestylefly GPT Image 2', homepage: 'https://github.com/freestylefly/awesome-gpt-image-2' },
  { id: 'awesome-gpt-image', name: 'Awesome GPT Image', homepage: 'https://github.com/ZeroLu/awesome-gpt-image' },
  { id: 'awesome-gpt4o-image-prompts', name: 'Awesome GPT-4o', homepage: 'https://github.com/ImgEdify/Awesome-GPT4o-Image-Prompts' },
  { id: 'youmind-gpt-image-2', name: 'YouMind GPT Image 2', homepage: 'https://github.com/YouMind-OpenLab/awesome-gpt-image-2' },
  { id: 'youmind-nano-banana-pro', name: 'YouMind Nano Banana Pro', homepage: 'https://github.com/YouMind-OpenLab/awesome-nano-bana-pro-prompts' }
].map((source) => ({
  ...source,
  url: `${PROMPT_REGISTRY_SOURCE_BASE}/${source.id}.json`
}))

function absoluteUrl(base: string, value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return ''
  try {
    return new URL(value, base).toString()
  } catch {
    return ''
  }
}

export class PromptSourceService {
  private readonly db: Database.Database
  private readonly networkFetch: typeof fetch

  constructor(db: Database.Database, networkFetch: typeof fetch) {
    this.db = db
    this.networkFetch = networkFetch
    this.seedDefaults()
  }

  private seedDefaults(): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO infinite_canvas_prompt_sources (id, name, url, homepage, enabled) VALUES (?, ?, ?, ?, 1)`
    )
    for (const source of DEFAULT_PROMPT_SOURCES) {
      insert.run(source.id, source.name, source.url, source.homepage)
    }
  }

  listSources(): PromptSourceInfo[] {
    const rows = this.db.prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM infinite_canvas_prompt_items i WHERE i.source_id = s.id) AS item_count
       FROM infinite_canvas_prompt_sources s ORDER BY s.id`
    ).all() as Array<PromptSourceRow & { item_count: number }>
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      homepage: row.homepage,
      enabled: row.enabled === 1,
      lastFetchedAt: row.last_fetched_at,
      lastError: row.last_error,
      itemCount: row.item_count
    }))
  }

  listItems(sourceId?: string): NormalizedPromptItem[] {
    const rows = sourceId
      ? this.db.prepare(
          `SELECT i.*, s.name AS source_name FROM infinite_canvas_prompt_items i
           JOIN infinite_canvas_prompt_sources s ON s.id = i.source_id
           WHERE i.source_id = ? ORDER BY i.fetched_at DESC, i.id`
        ).all(sourceId) as Array<PromptItemRow & { source_name: string }>
      : this.db.prepare(
          `SELECT i.*, s.name AS source_name FROM infinite_canvas_prompt_items i
           JOIN infinite_canvas_prompt_sources s ON s.id = i.source_id
           ORDER BY i.source_id, i.fetched_at DESC, i.id`
        ).all() as Array<PromptItemRow & { source_name: string }>
    return rows.map((row) => ({
      id: row.id,
      sourceId: row.source_id,
      sourceName: row.source_name,
      title: row.title,
      prompt: row.prompt,
      description: row.description,
      tags: JSON.parse(row.tags_json) as string[],
      coverUrl: row.cover_url
    }))
  }

  toggleSource(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE infinite_canvas_prompt_sources SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
  }

  /** 从所有已启用的源抓取并归一化，写入缓存。返回 { 成功数, 失败数 }。 */
  async refreshAll(): Promise<{ successCount: number; failureCount: number }> {
    const sources = this.db.prepare(
      'SELECT * FROM infinite_canvas_prompt_sources WHERE enabled = 1'
    ).all() as PromptSourceRow[]
    let successCount = 0
    let failureCount = 0
    const updateStatus = this.db.prepare(
      'UPDATE infinite_canvas_prompt_sources SET last_fetched_at = ?, last_error = ? WHERE id = ?'
    )
    const deleteOld = this.db.prepare('DELETE FROM infinite_canvas_prompt_items WHERE source_id = ?')
    const insertItem = this.db.prepare(
      `INSERT OR REPLACE INTO infinite_canvas_prompt_items (id, source_id, title, prompt, description, tags_json, cover_url, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const source of sources) {
      try {
        const response = await this.networkFetch(source.url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(15_000)
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data: unknown = await response.json()
        if (!Array.isArray(data)) throw new Error('响应不是数组')
        const now = Date.now()
        const seen = new Set<string>()
        const items: Array<[string, string, string, string, string, string, string, number]> = []
        for (const [index, raw] of data.entries()) {
          if (!raw || typeof raw !== 'object') continue
          const record = raw as Record<string, unknown>
          const title = String(record.title ?? '').trim()
          const prompt = String(record.prompt ?? '').trim()
          if (!title || !prompt) continue
          const id = String(record.id ?? '').trim() || `${source.id}-${index + 1}`
          if (seen.has(id)) continue
          seen.add(id)
          const tags = Array.isArray(record.tags) ? record.tags.map((tag) => String(tag)).filter(Boolean) : []
          const referenceImageUrls = Array.isArray(record.referenceImageUrls)
            ? record.referenceImageUrls.map((url) => absoluteUrl(source.url, url)).filter(Boolean)
            : []
          const coverUrl = absoluteUrl(source.url, record.coverUrl) || referenceImageUrls[0] || ''
          items.push([id, source.id, title, prompt, String(record.description ?? ''), JSON.stringify(tags), coverUrl, now])
        }
        const transaction = this.db.transaction(() => {
          deleteOld.run(source.id)
          for (const item of items) insertItem.run(...item)
          updateStatus.run(now, null, source.id)
        })
        transaction()
        successCount += 1
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        updateStatus.run(null, message, source.id)
        failureCount += 1
      }
    }
    return { successCount, failureCount }
  }
}

/** 从 PluginContext 构建 PromptSourceService；network.fetch 由宿主按 capability 注入。 */
export function createPromptSourceService(db: Database.Database, context: PluginContext): PromptSourceService {
  const fetchFn: typeof fetch = context.network?.fetch ?? globalThis.fetch
  return new PromptSourceService(db, fetchFn)
}
