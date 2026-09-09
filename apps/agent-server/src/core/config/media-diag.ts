/**
 * 媒体生成诊断日志（落盘版，常开）。
 *
 * 背景：媒体链路的关键日志走 pino 只进启动终端，桌面用户无处可看，
 * 排查"参考图有没有真的发出去""上游到底回了什么"只能靠猜。这里沿用
 * session-diag 的落盘模式，但媒体请求量极小（一次生成就几行），因此
 * 默认开启；vitest 环境自动关闭，绝不污染测试。
 *
 * 位置：~/.pi/diag/media.log（可用 PI_DIAG_DIR 覆盖目录）。
 * 隐私：只记录字节数/数量等元信息，不落提示词原文与图片内容。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

const MB = 1024 * 1024
const MAX_LOG_BYTES = 2 * MB
const TRIM_KEEP_BYTES = 512 * 1024

function logFile(): string {
  const dir = process.env.PI_DIAG_DIR || resolve(homedir(), '.pi', 'diag')
  return join(dir, 'media.log')
}

function dirOf(file: string): string {
  return resolve(file, '..')
}

let dirReady = false

/** 超过上限时保留末尾 TRIM_KEEP_BYTES，避免文件无限增长。 */
export function trimLogFile(file: string, maxBytes = MAX_LOG_BYTES, keepBytes = TRIM_KEEP_BYTES): void {
  const size = statSync(file).size
  if (size <= maxBytes) return
  const content = readFileSync(file, 'utf8')
  // 按行边界裁剪，避免截出半行 JSON
  const tail = content.slice(Math.max(0, content.length - keepBytes))
  const firstNewline = tail.indexOf('\n')
  writeFileSync(file, firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail, 'utf8')
}

/** 供测试直接驱动截断逻辑。 */
export function trimForTest(file: string, maxBytes: number): void {
  trimLogFile(file, maxBytes, Math.floor(maxBytes / 2))
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '{}'
  } catch {
    return '{"event":"unserializable"}'
  }
}

export const mediaDiag = {
  /** 单条结构化事件：{t, event, ...payload}。任何失败都静默吞掉。 */
  event(event: string, payload: Record<string, unknown> = {}): void {
    // vitest 环境跳过：单测里跑真实生成逻辑时不应写用户的诊断目录；
    // 但测试显式设置 PI_DIAG_DIR 时视为明确要求写盘。
    if (process.env.VITEST && !process.env.PI_DIAG_DIR) return
    try {
      const file = logFile()
      if (!dirReady) {
        if (!existsSync(dirOf(file))) mkdirSync(dirOf(file), { recursive: true })
        dirReady = true
      }
      appendFileSync(file, `${safeJson({ t: new Date().toISOString(), event, ...payload })}\n`)
      trimLogFile(file)
    } catch {
      /* 诊断日志绝不能影响主流程 */
    }
  }
}
