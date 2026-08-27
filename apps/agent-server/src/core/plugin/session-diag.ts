/**
 * 会话层诊断日志（临时排查用，2026-08-26 群聊 Director 空响应问题）
 *
 * 写文件而不是走 pino：pino 输出到控制台会混在大量日志里，且用户复现后
 * 需要把完整事件序列拿回来分析。独立文件 + 时间戳前缀，跑完一次复现即
 * 可整份带走。
 *
 * 打开方式：环境变量 NOVEL_SESSION_DIAG=1。排查完删除本模块与引用。
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

const logDir = resolve(homedir(), '.pi', 'diag')
// 启用方式：存在 ~/.pi/diag/ENABLED 文件，或环境变量 NOVEL_SESSION_DIAG=1。
// 文件开关优先：Electron 主进程内不便注入环境变量，落一个空文件最省事。
const enabled =
  existsSync(join(logDir, 'ENABLED')) || process.env.NOVEL_SESSION_DIAG === '1'
let dirReady = false

function write(tag: string, payload: unknown): void {
  if (!enabled) return
  try {
    if (!dirReady) {
      mkdirSync(logDir, { recursive: true })
      dirReady = true
    }
    const line = typeof payload === 'string' ? payload : JSON.stringify(payload)
    appendFileSync(
      join(logDir, 'session-diag.log'),
      `${new Date().toISOString()} [${tag}] ${line}\n`,
    )
  } catch {
    /* 诊断日志绝不能影响主流程 */
  }
}

export const sessionDiag = {
  get enabled(): boolean {
    return enabled
  },
  /** 每次 LLM 回合开始：入口参数摘要（tools/model/temperature/maxTokens 等） */
  turnStart(input: {
    threadId?: string
    hasTools: number
    toolNames: string[]
    modelId?: string
    thinkingLevel?: unknown
    temperature?: number
    responseFormat?: string
    maxTokens?: number | undefined
    userMessageChars: number
  }): void {
    write('turn-start', input)
  },
  /** onPayload 钩子真实触发（证明 provider 请求已发出 + 实际发出的参数） */
  payloadHookFired(input: { threadId?: string; payloadChars: number; keys: string[]; maxTokens?: unknown; streamOptionsPresent: boolean }): void {
    write('payload-hook', input)
  },
  /** 事件流：text_delta 累积 */
  textDelta(input: { threadId?: string; deltaChars: number; totalChars: number }): void {
    write('text-delta', input)
  },
  /** 事件流：reasoning/thinking delta 累积 */
  reasoningDelta(input: { threadId?: string; deltaChars: number; totalChars: number }): void {
    write('reasoning-delta', input)
  },
  /** message_end：终局消息完整形态（stopReason/usage/各内容块长度） */
  messageEnd(input: {
    threadId?: string
    stopReason?: unknown
    role?: unknown
    provider?: unknown
    model?: unknown
    usageRaw?: unknown
    textChars: number
    reasoningChars: number
    contentBlocks?: Array<{ type: string; chars: number }>
    assistantEventTypes: Record<string, number>
    errorMessage?: string
  }): void {
    write('message-end', input)
  },
  /** prompt() 返回前的最终判定 */
  promptResolved(input: {
    threadId?: string
    resultChars: number
    lastErrorMessage?: string
    durationMs: number
  }): void {
    write('prompt-resolved', input)
  },
}
