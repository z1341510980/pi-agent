import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('renderer Content Security Policy', () => {
  it('TC-01: allows local API and WebSocket connections', () => {
    const html = readFileSync(resolve(__dirname, '../index.html'), 'utf-8')

    expect(html).toContain("connect-src 'self'")
    expect(html).toContain('http://127.0.0.1:3900')
    expect(html).toContain('http://localhost:3900')
    expect(html).toContain('ws://127.0.0.1:3900')
    expect(html).toContain('ws://localhost:3900')
  })
})
