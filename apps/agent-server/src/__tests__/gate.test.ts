import { describe, expect, it } from 'vitest'
import { Gate } from '../core/tool/gate.js'

describe('Gate', () => {
  it('默认允许所有工具', async () => {
    const gate = new Gate()
    const result = await gate.check('read', { path: '/tmp/test.txt' })
    expect(result.allowed).toBe(true)
  })

  it('禁止列表中的工具被拒绝', async () => {
    const gate = new Gate({ deniedTools: ['rm', 'format'] })
    const result = await gate.check('rm', { path: '/tmp/test.txt' })
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('rm')
  })

  it('不在禁止列表中的工具被允许', async () => {
    const gate = new Gate({ deniedTools: ['rm'] })
    const result = await gate.check('read', { path: '/tmp/test.txt' })
    expect(result.allowed).toBe(true)
  })
})
