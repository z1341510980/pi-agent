import { describe, expect, it } from 'vitest'
import { AppError } from '../errors/app-error.js'
import { ErrorCode } from '../errors/error-code.js'

describe('AppError', () => {
  it('携带错误码和用户消息', () => {
    const error = new AppError(ErrorCode.UNAUTHORIZED, '认证失败', 401)
    expect(error.code).toBe(ErrorCode.UNAUTHORIZED)
    expect(error.userMessage).toBe('认证失败')
    expect(error.statusCode).toBe(401)
    expect(error).toBeInstanceOf(Error)
  })

  it('默认 statusCode 为 500', () => {
    const error = new AppError(ErrorCode.INTERNAL_SERVER_ERROR, '内部错误')
    expect(error.statusCode).toBe(500)
  })

  it('自动脱敏 userMessage 中的 API Key', () => {
    const error = new AppError(ErrorCode.CONFIG_ERROR, 'API Key sk-abc123xyz 无效')
    expect(error.userMessage).toBe('API Key [REDACTED_KEY] 无效')
  })

  it('自动脱敏 userMessage 中的文件路径', () => {
    const error = new AppError(ErrorCode.CONFIG_ERROR, '无法读取 /home/user/.pi/auth.json')
    expect(error.userMessage).toBe('无法读取 [REDACTED_PATH]')
  })

  it('保留原始 internalMessage 不脱敏', () => {
    const error = new AppError(
      ErrorCode.CONFIG_ERROR,
      '配置错误',
      500,
      '无法读取 /home/user/.pi/auth.json: sk-abc123xyz'
    )
    expect(error.userMessage).toBe('配置错误')
    expect(error.internalMessage).toBe('无法读取 /home/user/.pi/auth.json: sk-abc123xyz')
  })

  it('toJSON 输出脱敏后的信息', () => {
    const error = new AppError(
      ErrorCode.CONFIG_ERROR,
      'Key sk-deadbeef 失效',
      500,
      'sk-deadbeef 详细信息'
    )
    const json = error.toJSON()
    expect(json.code).toBe(ErrorCode.CONFIG_ERROR)
    expect(json.message).toBe('Key [REDACTED_KEY] 失效')
    expect(json).not.toHaveProperty('internalMessage')
  })
})
