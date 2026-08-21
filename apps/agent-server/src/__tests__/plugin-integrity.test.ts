/**
 * 插件包完整性校验测试（研究文档 §6.3）
 *
 * 锁定格式：plugins.yml 条目上的 resolvedVersion + integrity（SRI）。
 * 加载侧必须在 import 之前校验；写错的锁不能静默降级为"未锁定"。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computePackageIntegrity,
  parseIntegritySri,
  verifyPackageIntegrity,
} from '../core/plugin/plugin-integrity.js'

let packageDir: string

beforeEach(() => {
  packageDir = mkdtempSync(join(tmpdir(), 'pi-integrity-'))
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: 'test-plugin', version: '1.2.3' }),
    'utf-8'
  )
  writeFileSync(join(packageDir, 'index.js'), 'export default { manifest: {} }\n', 'utf-8')
})

afterEach(() => {
  rmSync(packageDir, { recursive: true, force: true })
})

describe('computePackageIntegrity', () => {
  it('同一内容两次计算结果一致', () => {
    const first = computePackageIntegrity(packageDir)
    const second = computePackageIntegrity(packageDir)
    expect(first.sri).toBe(second.sri)
    expect(first.sri).toMatch(/^sha256-[A-Za-z0-9+/]+={0,2}$/)
    expect(first.fileCount).toBe(2)
  })

  it('文件内容被改动后摘要变化', () => {
    const before = computePackageIntegrity(packageDir).sri
    writeFileSync(join(packageDir, 'index.js'), 'export default { manifest: {}, tampered: 1 }\n', 'utf-8')
    expect(computePackageIntegrity(packageDir).sri).not.toBe(before)
  })

  it('新增或删除文件都会改变摘要', () => {
    const before = computePackageIntegrity(packageDir).sri
    writeFileSync(join(packageDir, 'extra.js'), '// extra\n', 'utf-8')
    const afterAdd = computePackageIntegrity(packageDir)
    expect(afterAdd.sri).not.toBe(before)
    expect(afterAdd.fileCount).toBe(3)

    rmSync(join(packageDir, 'extra.js'))
    expect(computePackageIntegrity(packageDir).sri).toBe(before)
  })

  it('子目录参与摘要，node_modules 与 .git 被跳过', () => {
    mkdirSync(join(packageDir, 'lib'), { recursive: true })
    mkdirSync(join(packageDir, 'node_modules', 'dep'), { recursive: true })
    mkdirSync(join(packageDir, '.git'), { recursive: true })
    writeFileSync(join(packageDir, 'lib', 'util.js'), '// util\n', 'utf-8')
    // 这些即使被篡改也不影响摘要：它们不是插件自身代码的一部分
    writeFileSync(join(packageDir, 'node_modules', 'dep', 'x.js'), '// dep\n', 'utf-8')
    writeFileSync(join(packageDir, '.git', 'HEAD'), 'ref: fake\n', 'utf-8')

    const withLib = computePackageIntegrity(packageDir)
    expect(withLib.fileCount).toBe(3)

    writeFileSync(join(packageDir, 'lib', 'util.js'), '// util v2\n', 'utf-8')
    expect(computePackageIntegrity(packageDir).sri).not.toBe(withLib.sri)

    // 恢复 util.js 后，篡改 node_modules 内的文件不应影响摘要
    writeFileSync(join(packageDir, 'lib', 'util.js'), '// util\n', 'utf-8')
    writeFileSync(join(packageDir, 'node_modules', 'dep', 'x.js'), '// dep v2\n', 'utf-8')
    expect(computePackageIntegrity(packageDir).sri).toBe(withLib.sri)
  })
})

describe('parseIntegritySri', () => {
  it('接受 sha256 + base64', () => {
    expect(parseIntegritySri('sha256-abc+/==')).toEqual({
      algorithm: 'sha256',
      digest: Buffer.from('abc+/==', 'base64'),
    })
  })

  it('拒绝 sha384/sha512 —— 目录摘要只用 sha256，放行它们等于埋永久失败的锁', () => {
    expect(parseIntegritySri('sha512-AAAA')).toBeNull()
    expect(parseIntegritySri('sha384-AAAA')).toBeNull()
  })

  it('拒绝非法格式 —— 写错的锁不能当作未锁定', () => {
    expect(parseIntegritySri('md5-AAAA')).toBeNull()
    expect(parseIntegritySri('sha256-not base64!')).toBeNull()
    expect(parseIntegritySri('sha256-')).toBeNull()
    expect(parseIntegritySri('')).toBeNull()
    expect(parseIntegritySri('plain-text')).toBeNull()
  })
})

describe('verifyPackageIntegrity', () => {
  it('没有锁定字段时直接通过', () => {
    expect(verifyPackageIntegrity({ packageDir })).toMatchObject({ ok: true })
  })

  it('integrity 匹配时通过，并给出实际摘要与版本', () => {
    const { sri } = computePackageIntegrity(packageDir)
    const result = verifyPackageIntegrity({ packageDir, integrity: sri })
    expect(result.ok).toBe(true)
    expect(result.computedSri).toBe(sri)
    expect(result.actualVersion).toBe('1.2.3')
  })

  it('文件被篡改时失败，并附上实际摘要供诊断', () => {
    const { sri } = computePackageIntegrity(packageDir)
    writeFileSync(join(packageDir, 'index.js'), '// backdoor\n', 'utf-8')
    const result = verifyPackageIntegrity({ packageDir, integrity: sri })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('完整性校验失败')
    expect(result.computedSri).toBeDefined()
    expect(result.computedSri).not.toBe(sri)
  })

  it('integrity 格式非法时失败而不是跳过校验', () => {
    const result = verifyPackageIntegrity({ packageDir, integrity: 'md5-bogus' })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('格式非法')
  })

  it('resolvedVersion 与 package.json 精确比对', () => {
    expect(
      verifyPackageIntegrity({ packageDir, resolvedVersion: '1.2.3' }).ok
    ).toBe(true)
    const mismatch = verifyPackageIntegrity({ packageDir, resolvedVersion: '9.9.9' })
    expect(mismatch.ok).toBe(false)
    expect(mismatch.reason).toContain('版本不匹配')
    expect(mismatch.actualVersion).toBe('1.2.3')
  })

  it('要求版本校验但 package.json 缺失时失败', () => {
    rmSync(join(packageDir, 'package.json'))
    const result = verifyPackageIntegrity({ packageDir, resolvedVersion: '1.2.3' })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('version')
  })

  it('版本与摘要同时锁定时两者都必须通过', () => {
    const { sri } = computePackageIntegrity(packageDir)
    expect(
      verifyPackageIntegrity({ packageDir, integrity: sri, resolvedVersion: '1.2.3' }).ok
    ).toBe(true)

    writeFileSync(join(packageDir, 'index.js'), '// tampered\n', 'utf-8')
    expect(
      verifyPackageIntegrity({ packageDir, integrity: sri, resolvedVersion: '1.2.3' }).ok
    ).toBe(false)
  })
})
