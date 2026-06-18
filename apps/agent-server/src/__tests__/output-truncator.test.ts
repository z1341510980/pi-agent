import { describe, expect, it } from 'vitest'
import {
  truncateOutput,
  shouldTruncate,
  type TruncationConfig
} from '../core/tool/output-truncator.js'

describe('shouldTruncate', () => {
  it('短输出不截断', () => {
    expect(shouldTruncate('hello world')).toBe(false)
  })

  it('超长输出需要截断', () => {
    const long = 'x'.repeat(40000)
    expect(shouldTruncate(long)).toBe(true)
  })

  it('刚好等于阈值不截断', () => {
    const exact = 'x'.repeat(32768)
    expect(shouldTruncate(exact)).toBe(false)
  })

  it('自定义配置', () => {
    expect(shouldTruncate('hello', { maxBytes: 100 })).toBe(false)
    expect(shouldTruncate('x'.repeat(200), { maxBytes: 100 })).toBe(true)
  })
})

describe('truncateOutput', () => {
  it('短输出原样返回', () => {
    const short = 'hello world'
    expect(truncateOutput(short)).toBe(short)
  })

  it('刚好等于阈值原样返回', () => {
    const exact = 'x'.repeat(32768)
    expect(truncateOutput(exact)).toBe(exact)
  })

  it('超长输出截断为 head+tail', () => {
    const long = 'A'.repeat(40000)
    const result = truncateOutput(long)

    // 应包含 head（前 16384 字节）和 tail（后 16384 字节）
    expect(result).toContain('A'.repeat(16384))
    // 总长度应小于原长度
    expect(result.length).toBeLessThan(long.length)
    // 应包含截断提示
    expect(result).toContain('输出已截断')
    expect(result).toContain('40000')
  })

  it('截断消息包含字节数', () => {
    const long = 'B'.repeat(50000)
    const result = truncateOutput(long)

    // 截断消息应包含总字节数和省略字节数
    expect(result).toContain('50000')
    // 省略 = 50000 - 16384 - 16384 = 17232
    expect(result).toContain('17232')
  })

  it('保留 head 和 tail 内容', () => {
    const head = 'HEAD'.repeat(5000) // 20000 字节
    const middle = 'MIDDLE'.repeat(5000) // 30000 字节
    const tail = 'TAIL'.repeat(5000) // 20000 字节
    const long = head + middle + tail // 70000 字节

    const result = truncateOutput(long)

    // head 部分应保留
    expect(result.startsWith('HEAD')).toBe(true)
    // tail 部分应保留
    expect(result.endsWith('TAIL')).toBe(true)
    // middle 部分应被省略
    expect(result).not.toContain('MIDDLE')
  })

  it('自定义配置生效', () => {
    const config: Partial<TruncationConfig> = {
      maxBytes: 100,
      headBytes: 20,
      tailBytes: 20,
      truncationMessage: '\n... [自定义截断 {total} {omitted}] ...\n'
    }
    const long = 'x'.repeat(200)
    const result = truncateOutput(long, config)

    expect(result).toContain('自定义截断')
    expect(result).toContain('200')
    expect(result).toContain('160') // 200 - 20 - 20 = 160
  })

  it('多字节字符处理', () => {
    // 中文字符占 3 字节（UTF-8）
    const long = '你好'.repeat(20000) // 120000 字节
    const result = truncateOutput(long)

    expect(result.length).toBeLessThan(long.length)
    expect(result).toContain('输出已截断')
    expect(result).toContain('120000')
  })
})
