import { ErrorCode } from './error-code.js'
import { sanitizeErrorMessage } from './sanitize.js'

/**
 * 应用层统一错误类
 * - userMessage：脱敏后的用户可见消息
 * - internalMessage：原始未脱敏消息（仅日志）
 */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly userMessage: string
  readonly statusCode: number
  readonly internalMessage: string

  constructor(code: ErrorCode, userMessage: string, statusCode = 500, internalMessage?: string) {
    // 脱敏 userMessage
    const sanitizedUserMessage = sanitizeErrorMessage(userMessage)
    super(sanitizedUserMessage)
    this.name = 'AppError'
    this.code = code
    this.userMessage = sanitizedUserMessage
    this.statusCode = statusCode
    this.internalMessage = internalMessage ?? userMessage
  }

  /** 序列化为 JSON（仅包含脱敏信息，不含 internalMessage） */
  toJSON(): { code: ErrorCode; message: string; statusCode: number } {
    return {
      code: this.code,
      message: this.userMessage,
      statusCode: this.statusCode
    }
  }
}
