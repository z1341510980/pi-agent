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

  it('确认列表中的工具需要用户确认', async () => {
    const gate = new Gate({ confirmationTools: ['bash'] })
    const result = await gate.check('bash', { command: 'rm -rf dist' })
    expect(result.allowed).toBe(false)
    expect(result.needsConfirmation).toBe(true)
    expect(result.reason).toContain('bash')
  })

  it('禁止列表优先于确认列表', async () => {
    const gate = new Gate({
      deniedTools: ['bash'],
      confirmationTools: ['bash'],
    })
    const result = await gate.check('bash', { command: 'rm -rf dist' })
    expect(result.allowed).toBe(false)
    expect(result.needsConfirmation).toBe(false)
  })
})
