import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { atomicWriteSync } from '../utils/safe-fs.js'

const testDir = join(tmpdir(), 'wenlang-agent-test-safe-fs')

describe('atomicWriteSync', () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('原子写入文件', () => {
    const filePath = join(testDir, 'test.txt')
    atomicWriteSync(filePath, 'hello world')
    expect(readFileSync(filePath, 'utf-8')).toBe('hello world')
  })

  it('覆盖已存在的文件', () => {
    const filePath = join(testDir, 'test.txt')
    atomicWriteSync(filePath, 'first')
    atomicWriteSync(filePath, 'second')
    expect(readFileSync(filePath, 'utf-8')).toBe('second')
  })

  it('自动创建不存在的父目录', () => {
    const filePath = join(testDir, 'sub', 'dir', 'test.txt')
    atomicWriteSync(filePath, 'nested')
    expect(readFileSync(filePath, 'utf-8')).toBe('nested')
  })
})
