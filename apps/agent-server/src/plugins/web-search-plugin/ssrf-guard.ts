import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** 检查 IP 是否为私有/内网地址 */
function isPrivateIP(ip: string): boolean {
  // IPv4
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 10) return true                        // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
    if (a === 192 && b === 168) return true          // 192.168.0.0/16
    if (a === 127) return true                       // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true          // 169.254.0.0/16 link-local
    if (a === 0) return true                         // 0.0.0.0/8
    return false
  }
  // IPv6
  const lower = ip.toLowerCase()
  if (lower === '::1' || lower === '::') return true
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // fc00::/7 unique local
  if (lower.startsWith('fe80')) return true                          // link-local
  return false
}

/**
 * 校验 URL 是否安全可访问：
 * - 只允许 http/https 协议
 * - 拒绝 localhost / .local
 * - DNS 解析后拒绝私有 IP
 * @throws Error 如果 URL 不安全
 */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  const u = new URL(rawUrl)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`不支持的协议: ${u.protocol}`)
  }
  if (u.hostname === 'localhost' || u.hostname.endsWith('.local')) {
    throw new Error(`拒绝访问内网地址: ${u.hostname}`)
  }
  // 如果 hostname 已经是 IP，直接检查
  if (isIP(u.hostname)) {
    if (isPrivateIP(u.hostname)) {
      throw new Error(`拒绝访问内网 IP: ${u.hostname}`)
    }
    return u
  }
  // DNS 解析后检查
  try {
    const { address } = await lookup(u.hostname)
    if (isPrivateIP(address)) {
      throw new Error(`拒绝访问内网 IP: ${address} (hostname: ${u.hostname})`)
    }
  } catch (err) {
    // lookup 失败时重新抛出（可能是上面的 throw）
    throw err instanceof Error && err.message.startsWith('拒绝访问')
      ? err
      : new Error(`DNS 解析失败: ${u.hostname}`)
  }
  return u
}
