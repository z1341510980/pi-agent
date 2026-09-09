/**
 * 系统代理接入：让服务端出站 fetch 与浏览器同路。
 *
 * 背景：用户环境普遍开着系统代理（v2rayN/Clash 等），浏览器、Electron
 * 渲染层都走代理所以很快；Node 的 fetch 不读 Windows 系统代理，直连
 * 部分境外 CDN 只有几 KB/s。启动时读一次注册表，把系统代理接到 undici
 * 全局 dispatcher 上。
 *
 * 关闭方式：环境变量 PI_DISABLE_SYSTEM_PROXY=1。
 * 安全边界：NO_PROXY 永远放行本机回环，本机服务调用不受影响。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface RegProxy {
  enabled: boolean
  server: string
}

/** 解析 `reg query ...\Internet Settings` 的输出；未启用或字段缺失返回 null。 */
export function parseRegQuery(output: string): RegProxy | null {
  const enabledMatch = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(output)
  const serverMatch = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(output)
  if (!enabledMatch || !serverMatch) return null
  if (enabledMatch[1] === '0') return null
  return { enabled: true, server: serverMatch[1] }
}

/**
 * 把 WinINET 的 ProxyServer 值转成 http/https 代理 URL。
 * 简单形式 `host:port` 通用于全部协议；分号形式逐协议解析；
 * 纯 socks 配置无法作为 HTTP 代理使用，返回 null。
 */
export function proxyUrlsFromServer(
  server: string
): { http: string; https: string } | null {
  const value = server.trim()
  if (!value) return null
  if (!value.includes('=')) {
    return { http: `http://${value}`, https: `http://${value}` }
  }
  const entries = new Map<string, string>()
  for (const part of value.split(';')) {
    const [key, host] = part.split('=', 2)
    if (!key || !host) continue
    entries.set(key.trim().toLowerCase(), host.trim())
  }
  const http = entries.get('http')
  const https = entries.get('https')
  if (!http && !https) return null
  return {
    http: http ? `http://${http}` : `http://${https}`,
    https: https ? `http://${https}` : `http://${http}`
  }
}

const REG_PATH =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/** 读注册表并接入系统代理。成功返回代理地址，未启用/不支持时返回 null。 */
export async function setupSystemProxy(): Promise<{ https: string } | null> {
  if (process.platform !== 'win32') return null
  if (process.env.PI_DISABLE_SYSTEM_PROXY === '1') return null
  // 已有显式代理配置时尊重用户设置（EnvHttpProxyAgent 会读它们）
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) return null
  try {
    const { stdout } = await execFileAsync('reg', ['query', REG_PATH])
    const proxy = parseRegQuery(stdout)
    if (!proxy?.enabled) return null
    const urls = proxyUrlsFromServer(proxy.server)
    if (!urls) return null

    const { setGlobalDispatcher, EnvHttpProxyAgent } = await import('undici')
    const noProxy = ['localhost', '127.0.0.1', '::1']
    const existingNoProxy = process.env.NO_PROXY ?? process.env.no_proxy
    process.env.HTTP_PROXY = process.env.HTTP_PROXY ?? urls.http
    process.env.HTTPS_PROXY = process.env.HTTPS_PROXY ?? urls.https
    process.env.NO_PROXY = existingNoProxy
      ? `${existingNoProxy},${noProxy.join(',')}`
      : noProxy.join(',')
    setGlobalDispatcher(new EnvHttpProxyAgent())
    return { https: urls.https }
  } catch {
    // 代理探测失败绝不能阻塞启动
    return null
  }
}
