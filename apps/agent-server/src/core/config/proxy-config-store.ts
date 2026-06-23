/**
 * ProxyConfigStore：出站代理配置存储
 *
 * 持久化到 JSON 文件，进程重启后自动恢复。
 * 与前端 settings/general-settings.tsx 的 ProxyConfig 类型对齐。
 *
 * 持久化路径：${dataDir}/agent/proxy.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

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

export class ProxyConfigStore {
  private config: ProxyConfig = { ...defaultProxyConfig }
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
      const data = JSON.parse(raw)
      this.config = normalizeProxyConfig(data)
    } catch {
      // 文件损坏或不存在，忽略错误，使用默认配置
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
      writeFileSync(this.filePath, JSON.stringify(this.config, null, 2), 'utf-8')
    } catch {
      // 写入失败不影响内存中的配置
    }
  }

  /** 设置代理配置 */
  set(config: ProxyConfig): void {
    this.config = { ...config }
    this.schedulePersist()
  }

  /** 获取代理配置 */
  get(): ProxyConfig {
    return { ...this.config }
  }
}
