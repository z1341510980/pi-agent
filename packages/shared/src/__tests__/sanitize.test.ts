import { describe, expect, it } from 'vitest'
import { sanitizeErrorMessage } from '../errors/sanitize.js'

describe('sanitizeErrorMessage', () => {
  it('脱敏 OpenAI API Key', () => {
    expect(sanitizeErrorMessage('key: sk-abc123def456')).toBe('key: [REDACTED_KEY]')
  })

  it('脱敏 Anthropic API Key', () => {
    expect(sanitizeErrorMessage('key: sk-ant-api03-abc123')).toBe('key: [REDACTED_KEY]')
  })

  it('脱敏 Bearer Token', () => {
    expect(sanitizeErrorMessage('Bearer abc123token')).toBe('Bearer [REDACTED_TOKEN]')
  })

  it('脱敏文件路径', () => {
    expect(sanitizeErrorMessage('读取 /home/user/.pi/auth.json 失败')).toBe(
      '读取 [REDACTED_PATH] 失败'
    )
  })

  it('脱敏 Windows 路径', () => {
    expect(sanitizeErrorMessage('读取 C:\\Users\\test\\.pi\\auth.json')).toBe(
      '读取 [REDACTED_PATH]'
    )
  })

  it('普通文本不变', () => {
    expect(sanitizeErrorMessage('服务器内部错误')).toBe('服务器内部错误')
  })

  it('空字符串不变', () => {
    expect(sanitizeErrorMessage('')).toBe('')
  })
})
