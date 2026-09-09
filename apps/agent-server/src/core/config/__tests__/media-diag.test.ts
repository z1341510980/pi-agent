import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mediaDiag, trimForTest } from '../media-diag.js'

const dir = join(tmpdir(), `media-diag-test-${process.pid}`)
const file = join(dir, 'media.log')

describe('media diag log', () => {
  beforeEach(() => {
    rmSync(dir, { recursive: true, force: true })
    process.env.PI_DIAG_DIR = dir
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.PI_DIAG_DIR
  })

  it('appends one JSON line per event with a timestamp and tag', () => {
    mediaDiag.event('edit-submit', { endpoint: '/images/edits', referenceCount: 2, referenceBytes: 123 })
    mediaDiag.event('edit-error', { error: 'boom' })

    expect(existsSync(file)).toBe(true)
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>
      expect(typeof parsed.t).toBe('string')
      expect(Number.isNaN(Date.parse(parsed.t as string))).toBe(false)
    }
    expect(JSON.parse(lines[0])).toMatchObject({
      event: 'edit-submit',
      endpoint: '/images/edits',
      referenceCount: 2,
      referenceBytes: 123
    })
    expect(JSON.parse(lines[1])).toMatchObject({ event: 'edit-error', error: 'boom' })
  })

  it('keeps the file bounded by rewriting instead of growing forever', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, 'x'.repeat(900), 'utf8')
    // 测试里用小文件直接触发同一套截断逻辑：超过 900 字节就应重写
    const original = statSync(file).size
    expect(original).toBe(900)
    trimForTest(file, 512)

    const kept = readFileSync(file, 'utf8')
    expect(statSync(file).size).toBeLessThanOrEqual(900)
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(900)
  })

  it('never throws when the payload cannot be serialized', () => {
    expect(() =>
      mediaDiag.event('broken', {
        cyclic: (() => {
          const value: Record<string, unknown> = {}
          value.self = value
          return value
        })()
      })
    ).not.toThrow()
  })
})
