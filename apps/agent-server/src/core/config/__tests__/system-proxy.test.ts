import { describe, expect, it } from 'vitest'
import { parseRegQuery, proxyUrlsFromServer } from '../system-proxy.js'

describe('parseRegQuery', () => {
  it('parses enabled proxy with simple host:port', () => {
    const output = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '    ProxyEnable    REG_DWORD    0x1',
      '    ProxyServer    REG_SZ    127.0.0.1:10808',
      ''
    ].join('\r\n')

    expect(parseRegQuery(output)).toEqual({ enabled: true, server: '127.0.0.1:10808' })
  })

  it('returns null when the proxy is disabled or absent', () => {
    const disabled = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '    ProxyEnable    REG_DWORD    0x0',
      '    ProxyServer    REG_SZ    127.0.0.1:10808',
      ''
    ].join('\r\n')
    expect(parseRegQuery(disabled)).toBeNull()
    expect(parseRegQuery('')).toBeNull()
  })
})

describe('proxyUrlsFromServer', () => {
  it('treats a plain host:port as the proxy for all protocols', () => {
    expect(proxyUrlsFromServer('127.0.0.1:10808')).toEqual({
      http: 'http://127.0.0.1:10808',
      https: 'http://127.0.0.1:10808'
    })
  })

  it('reads per-protocol entries when present', () => {
    expect(proxyUrlsFromServer('http=1.2.3.4:8080;https=5.6.7.8:8443;<local>')).toEqual({
      http: 'http://1.2.3.4:8080',
      https: 'http://5.6.7.8:8443'
    })
  })

  it('ignores socks-only configurations that undici cannot speak', () => {
    expect(proxyUrlsFromServer('socks=127.0.0.1:1080')).toBeNull()
  })

  it('returns null for empty values', () => {
    expect(proxyUrlsFromServer('')).toBeNull()
  })
})
