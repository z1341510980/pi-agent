/**
 * ProviderConfigStore：前端动态注册的 Provider 配置存储
 *
 * 持久化到 JSON 文件，进程重启后自动恢复。
 * 与 ModelRegistry 互补：
 * - ModelRegistry：Pi SDK 内置模型 + models.json 自定义模型
 * - 本存储：前端用户在设置页面配置的 Provider（含 API Key）
 *
 * 持久化路径：${dataDir}/agent/providers.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

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

export class ProviderConfigStore {
  private readonly providers = new Map<string, ProviderConfig>()
  private readonly filePath: string
  private writeTimer: ReturnType<typeof setTimeout> | null = null

  constructor(filePath?: string) {
    this.filePath = filePath ?? ''
    if (this.filePath) {
      this.loadFromDisk()
    }
  }

  /** 从磁盘加载配置 */
  private loadFromDisk(): void {
    if (!this.filePath || !existsSync(this.filePath)) return
    try {
      const raw = readFileSync(this.filePath, 'utf-8')
      const data = JSON.parse(raw) as ProviderConfig[]
      if (Array.isArray(data)) {
        for (const config of data) {
          if (config && typeof config.id === 'string') {
            this.providers.set(config.id, config)
          }
        }
      }
    } catch {
      // 文件损坏或不存在，忽略错误，使用空存储
    }
  }

  /** 延迟写入磁盘（防抖，避免频繁写入） */
  private schedulePersist(): void {
    if (!this.filePath) return
    if (this.writeTimer) clearTimeout(this.writeTimer)
    this.writeTimer = setTimeout(() => {
      this.persistNow()
    }, 100)
  }

  /** 立即写入磁盘 */
  persistNow(): void {
    if (!this.filePath) return
    try {
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      const data = Array.from(this.providers.values())
      writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8')
    } catch {
      // 写入失败不影响内存中的配置
    }
  }

  /** 注册或更新 Provider 配置 */
  upsert(config: ProviderConfig): void {
    this.providers.set(config.id, config)
    this.schedulePersist()
  }

  /** 获取 Provider 配置 */
  get(id: string): ProviderConfig | undefined {
    return this.providers.get(id)
  }

  /** 列出所有 Provider 配置 */
  list(): ProviderConfig[] {
    return Array.from(this.providers.values())
  }

  /** 删除 Provider 配置 */
  delete(id: string): boolean {
    const result = this.providers.delete(id)
    if (result) {
      this.schedulePersist()
    }
    return result
  }

  /** 获取指定 Provider 的 API Key */
  getApiKey(providerId: string): string | undefined {
    return this.providers.get(providerId)?.apiKey
  }
}
