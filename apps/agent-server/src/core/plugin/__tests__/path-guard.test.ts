/**
 * path-guard 纯函数测试。
 *
 * 关键价值：用两种平台的字面量路径断言，不依赖运行测试的操作系统。
 * 原先 npm 插件的包含性判定把分隔符硬编码为 '\\'，在 Windows 上测试全绿、
 * 在 posix 上却拒绝所有合法插件；这类缺陷只有平台无关的断言能挡住。
 */
import { describe, expect, it } from 'vitest'
import { sep } from 'node:path'
import { isInsideDir, resolveWithin } from '../path-guard.js'

/** 用当前平台分隔符拼路径，让断言在 win32 与 posix 上表达同一语义 */
const p = (...parts: string[]): string =>
  (sep === '\\' ? 'C:\\' : '/') + parts.join(sep)

describe('isInsideDir', () => {
  it('直接子目录与深层子目录都算内部', () => {
    expect(isInsideDir(p('app', 'node_modules'), p('app', 'node_modules', 'pkg'))).toBe(true)
    expect(
      isInsideDir(p('app', 'node_modules'), p('app', 'node_modules', '@scope', 'pkg', 'index.js'))
    ).toBe(true)
  })

  it('父目录自身不算内部（严格包含）', () => {
    expect(isInsideDir(p('app', 'node_modules'), p('app', 'node_modules'))).toBe(false)
  })

  it('同级与上级目录被拒绝', () => {
    expect(isInsideDir(p('app', 'node_modules'), p('app', 'other'))).toBe(false)
    expect(isInsideDir(p('app', 'node_modules'), p('app'))).toBe(false)
  })

  it('前缀相同但不是子目录的兄弟目录被拒绝', () => {
    // 字符串前缀比较会把 node_modules_evil 误判为内部
    expect(isInsideDir(p('app', 'node_modules'), p('app', 'node_modules_evil', 'pkg'))).toBe(false)
  })

  it('穿越回上层再进入的路径被拒绝', () => {
    expect(isInsideDir(p('app', 'node_modules'), p('app', 'node_modules', '..', 'outside'))).toBe(
      false
    )
  })
})

describe('resolveWithin', () => {
  const base = p('data', 'plugins', 'demo')
  const describeError = (attempted: string): string => `越界: ${attempted}`

  it('相对片段解析到 base 内部', () => {
    expect(resolveWithin(base, ['cache', 'a.json'], describeError)).toBe(
      `${base}${sep}cache${sep}a.json`
    )
  })

  it('空片段返回 base 自身（用于取根目录）', () => {
    expect(resolveWithin(base, [], describeError)).toBe(base)
  })

  it('.. 逃逸抛错，错误信息带上尝试的路径', () => {
    expect(() => resolveWithin(base, ['..', '..', 'etc', 'passwd'], describeError)).toThrow(
      '越界: ../../etc/passwd'
    )
  })

  it('绝对路径片段抛错', () => {
    expect(() => resolveWithin(base, [p('etc', 'passwd')], describeError)).toThrow('越界')
  })
})
