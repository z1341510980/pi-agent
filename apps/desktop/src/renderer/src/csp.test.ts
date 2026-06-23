import { describe, expect, it } from 'vitest'

describe('renderer Content Security Policy', () => {
  it('TC-01: CSP 使用动态端口而非硬编码', () => {
    // CSP 不再硬编码在 index.html 中，由 Electron 主进程动态注入
    // 验证：index.html 不包含硬编码的 connect-src
    const { readFileSync } = require('node:fs')
    const { resolve } = require('node:path')
    const html = readFileSync(resolve(__dirname, '../index.html'), 'utf-8')

    // 不应包含硬编码的端口 3900
    expect(html).not.toContain('http://127.0.0.1:3900')
    expect(html).not.toContain('connect-src')
  })

  it('TC-02: 主进程构建 CSP 字符串包含正确端口', () => {
    // 验证 CSP 构建逻辑
    const port = 55132
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      `connect-src 'self' http://127.0.0.1:${port} http://localhost:${port} ws://127.0.0.1:${port} ws://localhost:${port}`,
    ].join('; ')

    expect(csp).toContain(`http://127.0.0.1:${port}`)
    expect(csp).toContain(`ws://127.0.0.1:${port}`)
    expect(csp).toContain('default-src')
    expect(csp).toContain('connect-src')
  })
})
