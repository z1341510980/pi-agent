import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { Gate } from '../core/tool/gate.js'

function makeTempDir(prefix = 'pi-gate-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('Gate', () => {
  it('默认 auto 模式允许 safe 工具', async () => {
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

describe('Gate 权限模式', () => {
  it('auto 模式：dangerous 工具需要确认', async () => {
    const gate = new Gate({ mode: 'auto' })
    const result = await gate.check('bash', { command: 'ls' })
    expect(result.needsConfirmation).toBe(true)
    expect(result.reason).toContain('危险操作')
  })

  it('auto 模式：moderate 工具自动执行', async () => {
    const gate = new Gate({ mode: 'auto' })
    const result = await gate.check('edit', { path: '/tmp/test.txt' })
    expect(result.allowed).toBe(true)
  })

  it('plan 模式：moderate 工具需要确认', async () => {
    const gate = new Gate({ mode: 'plan' })
    const result = await gate.check('edit', { path: '/tmp/test.txt' })
    expect(result.needsConfirmation).toBe(true)
    expect(result.reason).toContain('Plan 模式')
  })

  it('plan 模式：dangerous 工具需要确认', async () => {
    const gate = new Gate({ mode: 'plan' })
    const result = await gate.check('bash', { command: 'ls' })
    expect(result.needsConfirmation).toBe(true)
  })

  it('readonly 模式：写工具被禁止', async () => {
    const gate = new Gate({ mode: 'readonly' })
    const result = await gate.check('write', { path: '/tmp/test.txt' })
    expect(result.allowed).toBe(false)
    expect(result.needsConfirmation).toBe(false)
    expect(result.reason).toContain('read-only')
  })

  it('readonly 模式：bash 被禁止', async () => {
    const gate = new Gate({ mode: 'readonly' })
    const result = await gate.check('bash', { command: 'ls' })
    expect(result.allowed).toBe(false)
  })

  it('readonly 模式：读工具允许', async () => {
    const gate = new Gate({ mode: 'readonly' })
    const result = await gate.check('read', { path: '/tmp/test.txt' })
    expect(result.allowed).toBe(true)
  })

  it('getMode() 返回当前模式', () => {
    const gate = new Gate({ mode: 'plan' })
    expect(gate.getMode()).toBe('plan')
  })
})

describe('Gate 风险分级', () => {
  it('getRiskLevel 返回正确等级', () => {
    const gate = new Gate()
    expect(gate.getRiskLevel('read')).toBe('safe')
    expect(gate.getRiskLevel('ls')).toBe('safe')
    expect(gate.getRiskLevel('grep')).toBe('safe')
    expect(gate.getRiskLevel('write')).toBe('moderate')
    expect(gate.getRiskLevel('edit')).toBe('moderate')
    expect(gate.getRiskLevel('bash')).toBe('dangerous')
    expect(gate.getRiskLevel('web_search')).toBe('dangerous')
  })

  it('未知工具默认为 moderate', () => {
    const gate = new Gate()
    expect(gate.getRiskLevel('custom_tool')).toBe('moderate')
  })
})

describe('Gate 路径白名单', () => {
  it('工作区内路径允许读', async () => {
    const workspace = makeTempDir()
    const testFile = join(workspace, 'test.txt')
    writeFileSync(testFile, 'hello')

    const gate = new Gate({ workspace })
    const result = await gate.check('read', { path: testFile })
    expect(result.allowed).toBe(true)
  })

  it('工作区外路径被拒绝', async () => {
    const workspace = makeTempDir()
    const outside = makeTempDir('pi-gate-outside-')
    const outsideFile = join(outside, 'secret.txt')
    writeFileSync(outsideFile, 'secret')

    const gate = new Gate({ workspace })
    const result = await gate.check('read', { path: outsideFile })
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('白名单')
  })

  it('externalReadPaths 允许只读访问', async () => {
    const workspace = makeTempDir()
    const external = makeTempDir('pi-gate-external-')
    const externalFile = join(external, 'ref.txt')
    writeFileSync(externalFile, 'ref')

    const gate = new Gate({ workspace, externalReadPaths: [external] })
    const result = await gate.check('read', { path: externalFile })
    expect(result.allowed).toBe(true)
  })

  it('externalReadPaths 不允许写操作', async () => {
    const workspace = makeTempDir()
    const external = makeTempDir('pi-gate-external-')
    const externalFile = join(external, 'ref.txt')
    writeFileSync(externalFile, 'ref')

    const gate = new Gate({ workspace, externalReadPaths: [external] })
    const result = await gate.check('write', { path: externalFile })
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('只读')
  })

  it('相对路径基于 workspace 解析', async () => {
    const workspace = makeTempDir()
    const testFile = join(workspace, 'test.txt')
    writeFileSync(testFile, 'hello')

    const gate = new Gate({ workspace })
    const result = await gate.check('read', { path: 'test.txt' })
    expect(result.allowed).toBe(true)
  })

  it('未配置白名单时跳过路径检查', async () => {
    const gate = new Gate()
    const result = await gate.check('read', { path: '/anywhere/test.txt' })
    expect(result.allowed).toBe(true)
  })
})

describe('Gate 自定义检查', () => {
  it('customCheck 在默认策略后执行', async () => {
    const gate = new Gate({
      customCheck: async () => ({ allowed: false, reason: '自定义拦截' }),
    })
    const result = await gate.check('read', { path: '/tmp/test.txt' })
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('自定义拦截')
  })

  it('deniedTools 优先于 customCheck', async () => {
    const gate = new Gate({
      deniedTools: ['bash'],
      customCheck: async () => ({ allowed: true }),
    })
    const result = await gate.check('bash', { command: 'ls' })
    expect(result.allowed).toBe(false)
  })
})
