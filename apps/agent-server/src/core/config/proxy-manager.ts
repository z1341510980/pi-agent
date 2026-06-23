/**
 * ProxyManager：出站代理管理器
 *
 * 将 ProxyConfig 应用到 Node.js 全局 HTTP 客户端（undici），
 * 使所有 fetch 调用（包括 LLM Provider 的 OpenAI/Anthropic SDK）走代理。
 *
 * 模式说明：
 * - none：直连，不使用代理（重置为默认 Agent）
 * - system：跟随系统环境变量 HTTP_PROXY/HTTPS_PROXY/NO_PROXY（EnvHttpProxyAgent）
 * - manual：使用用户手动配置的 host:port（可选用户名密码）
 *
 * 注意：setGlobalDispatcher 影响整个进程的 fetch 调用。
 */

import { Agent, EnvHttpProxyAgent, ProxyAgent, setGlobalDispatcher } from 'undici'
import { defaultProxyConfig, type ProxyConfig } from './proxy-config-store.js'

export interface ProxyApplyResult {
  mode: ProxyConfig['mode']
  /** 实际生效的代理 URL（none 模式为 null） */
  effectiveProxyUrl: string | null
  /** 是否成功应用 */
  applied: boolean
  /** 错误信息（应用失败时） */
  error?: string
}

export class ProxyManager {
  private currentConfig: ProxyConfig | null = null

  /** 当前已应用的配置 */
  getCurrentConfig(): ProxyConfig | null {
    return this.currentConfig ? { ...this.currentConfig } : null
  }

  /**
   * 应用代理配置到全局 HTTP 客户端
   * @returns 应用结果
   */
  apply(config: ProxyConfig): ProxyApplyResult {
    this.currentConfig = { ...config }

    try {
      if (config.mode === 'none') {
        // 直连：重置为默认 Agent
        setGlobalDispatcher(new Agent())
        return { mode: 'none', effectiveProxyUrl: null, applied: true }
      }

      if (config.mode === 'system') {
        // 系统代理：使用 EnvHttpProxyAgent 读取环境变量
        // EnvHttpProxyAgent 自动读取 HTTP_PROXY/HTTPS_PROXY/NO_PROXY
        const envProxy =
          process.env.HTTPS_PROXY ||
          process.env.https_proxy ||
          process.env.HTTP_PROXY ||
          process.env.http_proxy ||
          null

        setGlobalDispatcher(new EnvHttpProxyAgent())
        return {
          mode: 'system',
          effectiveProxyUrl: envProxy,
          applied: true,
        }
      }

      // manual 模式：构建代理 URL
      if (!config.host || !config.port) {
        return {
          mode: 'manual',
          effectiveProxyUrl: null,
          applied: false,
          error: '手动代理模式缺少 host 或 port',
        }
      }

      const proxyUrl = buildProxyUrl(config)
      setGlobalDispatcher(new ProxyAgent(proxyUrl))
      return {
        mode: 'manual',
        effectiveProxyUrl: proxyUrl,
        applied: true,
      }
    } catch (err) {
      return {
        mode: config.mode,
        effectiveProxyUrl: null,
        applied: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /**
   * 测试代理连通性
   * 尝试通过当前代理访问一个轻量级 URL，返回连通状态
   */
  async testConnectivity(config: ProxyConfig): Promise<{ ok: boolean; message: string }> {
    if (config.mode === 'none') {
      return { ok: true, message: '直连模式（无代理）' }
    }

    if (config.mode === 'manual' && (!config.host || !config.port)) {
      return { ok: false, message: '请填写代理主机和端口' }
    }

    // 保存当前配置，测试后恢复（避免副作用）
    const previousConfig = this.currentConfig

    // 临时应用代理配置
    const result = this.apply(config)
    if (!result.applied) {
      return { ok: false, message: result.error ?? '代理配置应用失败' }
    }

    try {
      // 使用一个轻量级的 HTTP 端点测试连通性
      // 设置 5 秒超时，避免长时间等待
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      await fetch('https://www.bing.com/robots.txt', {
        method: 'HEAD',
        signal: controller.signal,
      })
      clearTimeout(timeout)

      const proxyDesc =
        config.mode === 'system'
          ? '系统代理'
          : `代理 ${config.host}:${config.port}`

      return { ok: true, message: `${proxyDesc} 连通性正常` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, message: `代理测试失败: ${msg}` }
    } finally {
      // 恢复原配置（如果之前没有配置，恢复为直连模式）
      this.apply(previousConfig ?? { ...defaultProxyConfig, mode: 'none' })
    }
  }
}

/**
 * 构建 manual 模式的代理 URL
 * 格式：http://[user:pass@]host:port
 */
function buildProxyUrl(config: ProxyConfig): string {
  const host = config.host
  const port = config.port

  if (config.username && config.password) {
    const user = encodeURIComponent(config.username)
    const pass = encodeURIComponent(config.password)
    return `http://${user}:${pass}@${host}:${port}`
  }

  return `http://${host}:${port}`
}
