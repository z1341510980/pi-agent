/**
 * 取消流程调试日志（临时）
 *
 * 写入到固定文件，不依赖 Fastify logger 配置。
 * 调试用，问题定位后可删除。
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const LOG_PATH = process.env.PI_CANCEL_DEBUG_LOG
  ?? join(homedir(), '.pi', 'cancel-debug.log')

export function cancelDebug(tag: string, payload: unknown): void {
  const ts = new Date().toISOString()
  const line = `[${ts}] [${tag}] ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n`
  try {
    appendFileSync(LOG_PATH, line, { encoding: 'utf8' })
  } catch {
    // 忽略写入失败
  }
}
