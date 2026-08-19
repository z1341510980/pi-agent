/** 需要脱敏的 API Key 前缀模式 */
const API_KEY_PATTERNS = [
  /sk-ant-api[a-zA-Z0-9-]+/g, // Anthropic
  /sk-[a-zA-Z0-9]{8,}/g, // OpenAI
  /AIza[a-zA-Z0-9_-]{35}/g // Google
]

/** Bearer Token 模式 */
const BEARER_TOKEN_PATTERN = /Bearer\s+\S+/gi

/** 文件路径模式（Unix + Windows） */
const FILE_PATH_PATTERNS = [
  // Unix 绝对路径（包含 .pi 或 .config 等敏感目录）
  /\/(?:home|Users|root|etc|var|tmp)\/[^\s'"]+/g,
  // Windows 绝对路径
  /[A-Za-z]:\\[^\s'"]+/g,
  // 以 .pi/ 开头的相对路径
  /\.pi\/[^\s'"]+/g
]

/**
 * 脱敏错误消息中的敏感信息
 * - API Key → [REDACTED_KEY]
 * - Bearer Token → [REDACTED_TOKEN]
 * - 文件路径 → [REDACTED_PATH]
 */
export function sanitizeErrorMessage(message: string): string {
  let result = message

  for (const pattern of API_KEY_PATTERNS) {
    result = result.replace(pattern, '[REDACTED_KEY]')
  }

  result = result.replace(BEARER_TOKEN_PATTERN, 'Bearer [REDACTED_TOKEN]')

  for (const pattern of FILE_PATH_PATTERNS) {
    result = result.replace(pattern, '[REDACTED_PATH]')
  }

  return result
}