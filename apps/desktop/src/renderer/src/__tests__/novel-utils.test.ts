import { describe, it, expect } from 'vitest'
import { countWords } from '@/lib/novel-utils'

describe('countWords', () => {
  it('空字符串返回 0', () => {
    expect(countWords('')).toBe(0)
  })
  it('纯中文按字符计数', () => {
    expect(countWords('这是十个字的测试正文')).toBe(10)
  })
  it('去除 Markdown 标记后计数', () => {
    // # 与 * 被剥离，空白被剥离：标题粗体内容 = 6 字
    expect(countWords('# 标题\n**粗体**内容')).toBe(6)
  })
  it('去除空白后计数', () => {
    // 第一段 + 第二段 = 6 字
    expect(countWords('第一段\n\n第二段')).toBe(6)
  })
})
