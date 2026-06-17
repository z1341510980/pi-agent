type MessageKey =
  | 'error.internal'
  | 'error.unauthorized'
  | 'error.forbidden'
  | 'error.not_found'
  | 'error.validation'
  | 'error.agent_run_failed'
  | 'error.tool_execution_failed'
  | 'error.config'
  | 'success.ok'
  | 'success.created'
  | 'success.accepted'

const zhCN: Record<MessageKey, string> = {
  'error.internal': '服务器内部错误',
  'error.unauthorized': '认证失败',
  'error.forbidden': '权限不足',
  'error.not_found': '资源不存在',
  'error.validation': '请求参数校验失败',
  'error.agent_run_failed': 'Agent 运行失败',
  'error.tool_execution_failed': '工具执行失败',
  'error.config': '配置错误',
  'success.ok': '操作成功',
  'success.created': '创建成功',
  'success.accepted': '已接受'
}

const enUS: Record<MessageKey, string> = {
  'error.internal': 'Internal server error',
  'error.unauthorized': 'Unauthorized',
  'error.forbidden': 'Forbidden',
  'error.not_found': 'Not found',
  'error.validation': 'Validation failed',
  'error.agent_run_failed': 'Agent run failed',
  'error.tool_execution_failed': 'Tool execution failed',
  'error.config': 'Configuration error',
  'success.ok': 'OK',
  'success.created': 'Created',
  'success.accepted': 'Accepted'
}

type Locale = 'zh-CN' | 'en-US'

const messages: Record<Locale, Record<MessageKey, string>> = {
  'zh-CN': zhCN,
  'en-US': enUS
}

let currentLocale: Locale = 'zh-CN'

/** 设置当前语言 */
export function setLocale(locale: Locale): void {
  currentLocale = locale
}

/** 获取当前语言 */
export function getLocale(): Locale {
  return currentLocale
}

/** 获取国际化消息 */
export function t(key: MessageKey, locale?: Locale): string {
  return (messages[locale ?? currentLocale] ?? zhCN)[key] ?? key
}
