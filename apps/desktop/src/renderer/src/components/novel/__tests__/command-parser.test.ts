import { describe, expect, it } from 'vitest'
import { parseCommand } from '../command-parser'

describe('parseCommand /写（write）', () => {
  it('中文命令带空格', () => {
    expect(parseCommand('/写 11')).toEqual({ kind: 'write', chapterNumber: 11 })
  })

  it('中文命令无空格', () => {
    expect(parseCommand('/写12')).toEqual({ kind: 'write', chapterNumber: 12 })
  })

  it('英文命令带空格，大小写不敏感', () => {
    expect(parseCommand('/write 11')).toEqual({ kind: 'write', chapterNumber: 11 })
    expect(parseCommand('/WRITE 11')).toEqual({ kind: 'write', chapterNumber: 11 })
    expect(parseCommand('/Write 3')).toEqual({ kind: 'write', chapterNumber: 3 })
  })

  it('英文命令允许零或多处空白分隔', () => {
    expect(parseCommand('/write12')).toEqual({ kind: 'write', chapterNumber: 12 })
    expect(parseCommand('/write   7')).toEqual({ kind: 'write', chapterNumber: 7 })
  })

  it('前后空白容错', () => {
    expect(parseCommand('  /写 11  ')).toEqual({ kind: 'write', chapterNumber: 11 })
  })

  it('章节号边界：1 与 9999 有效，0 与 10000 返回 invalid-chapter', () => {
    expect(parseCommand('/写 1')).toEqual({ kind: 'write', chapterNumber: 1 })
    expect(parseCommand('/写 9999')).toEqual({ kind: 'write', chapterNumber: 9999 })
    expect(parseCommand('/写 0')).toEqual({ kind: 'invalid-chapter', raw: '/写 0' })
    expect(parseCommand('/写 10000')).toEqual({ kind: 'invalid-chapter', raw: '/写 10000' })
  })
})

describe('parseCommand /继续（resume）', () => {
  it('中英文变体，大小写不敏感', () => {
    expect(parseCommand('/继续')).toEqual({ kind: 'resume' })
    expect(parseCommand('/resume')).toEqual({ kind: 'resume' })
    expect(parseCommand('/RESUME')).toEqual({ kind: 'resume' })
  })

  it('resume 不接受数字参数（带数字视为未知命令）', () => {
    expect(parseCommand('/继续 3').kind).toBe('unknown')
  })
})

describe('parseCommand /重写（rewrite）', () => {
  it('中英文变体，中文无空格也可', () => {
    expect(parseCommand('/重写 3')).toEqual({ kind: 'rewrite', chapterNumber: 3 })
    expect(parseCommand('/rewrite 3')).toEqual({ kind: 'rewrite', chapterNumber: 3 })
    expect(parseCommand('/REWRITE 8')).toEqual({ kind: 'rewrite', chapterNumber: 8 })
    expect(parseCommand('/重写8')).toEqual({ kind: 'rewrite', chapterNumber: 8 })
  })

  it('章节号越界返回 invalid-chapter 并携带原文', () => {
    expect(parseCommand('/重写 0')).toEqual({ kind: 'invalid-chapter', raw: '/重写 0' })
    expect(parseCommand('/rewrite 10000')).toEqual({ kind: 'invalid-chapter', raw: '/rewrite 10000' })
  })
})

describe('parseCommand /群聊（discuss）', () => {
  it('中英文变体，中文无空格也可', () => {
    expect(parseCommand('/群聊 5')).toEqual({ kind: 'discuss', chapterNumber: 5 })
    expect(parseCommand('/discuss 5')).toEqual({ kind: 'discuss', chapterNumber: 5 })
    expect(parseCommand('/Discuss 15')).toEqual({ kind: 'discuss', chapterNumber: 15 })
    expect(parseCommand('/群聊15')).toEqual({ kind: 'discuss', chapterNumber: 15 })
  })

  it('章节号越界返回 invalid-chapter', () => {
    expect(parseCommand('/群聊 0')).toEqual({ kind: 'invalid-chapter', raw: '/群聊 0' })
  })
})

describe('parseCommand 非命令输入', () => {
  it('空串与纯空白返回 null', () => {
    expect(parseCommand('')).toBeNull()
    expect(parseCommand('   ')).toBeNull()
  })

  it('普通文本返回 chat', () => {
    expect(parseCommand('帮我写一段打斗戏')).toEqual({ kind: 'chat' })
    expect(parseCommand('写 11')).toEqual({ kind: 'chat' })
    expect(parseCommand('写11')).toEqual({ kind: 'chat' })
  })

  it('未知命令返回 unknown 并携带原文', () => {
    expect(parseCommand('/foo')).toEqual({ kind: 'unknown', raw: '/foo' })
    expect(parseCommand('/写')).toEqual({ kind: 'unknown', raw: '/写' })
    expect(parseCommand('/write abc')).toEqual({ kind: 'unknown', raw: '/write abc' })
  })
})
