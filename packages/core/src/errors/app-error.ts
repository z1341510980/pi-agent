/**
 * 应用错误类
 *
 * 统一错误格式，支持错误码、HTTP 状态码和额外元数据
 */
import type { ErrorCode } from './error-code.js'

export class AppError extends Error {
  public readonly code: ErrorCode
  public readonly status: number
  public readonly metadata?: Record<string, unknown>

  constructor(
    code: ErrorCode,
    message: string,
    status: number = 500,
    metadata?: Record<string, unknown>,
  ) {
    super(message)
    this.code = code
    this.status = status
    this.metadata = metadata
    this.name = 'AppError'
    // 保持原型链正确
    Object.setPrototypeOf(this, AppError.prototype)
  }
}