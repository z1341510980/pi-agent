/**
 * 输入框命令解析器（纯函数）
 *
 * 空闲态对话面板的输入框支持斜杠命令直达 flow：
 * - `/写 N` / `/write N` → 启动第 N 章创作工作流
 * - `/继续` / `/resume` → 恢复中断/暂停的 flow
 * - `/重写 N` / `/rewrite N` → 重写第 N 章
 * - `/群聊 N` / `/discuss N` → 第 N 章群聊
 *
 * 解析规则：
 * - 命令匹配大小写不敏感；中英文命令与数字间允许零或多处空白
 *   （中文输入法下切英文命令常忘空格，统一 `\s*` 容错，`/write12` 亦按第 12 章解析）
 * - 章节号有效范围 1-9999，越界（如 /写 0、/写 10000）→ invalid-chapter
 *   （动词匹配但参数无效，与 unknown/chat 区分，由调用方 toast 提示），raw 携带原文
 * - 以 `/` 开头但未匹配任何命令 → unknown（由调用方 toast 提示），raw 携带原文
 */

export type ParsedCommand =
  | { kind: 'write'; chapterNumber: number }
  | { kind: 'resume' }
  | { kind: 'rewrite'; chapterNumber: number }
  | { kind: 'discuss'; chapterNumber: number }
  | { kind: 'chat' }
  | { kind: 'unknown'; raw: string }
  | { kind: 'invalid-chapter'; raw: string }

const MAX_CHAPTER_NUMBER = 9999

/** 匹配带章节号参数的命令；返回 null 表示整体不匹配，undefined 表示匹配但章节号越界 */
function matchChapterCommand(text: string, verbs: string): number | null | undefined {
  const match = text.match(new RegExp(`^/(?:${verbs})\\s*(\\d+)$`, 'i'))
  if (!match) return null
  const chapterNumber = Number.parseInt(match[1]!, 10)
  return chapterNumber >= 1 && chapterNumber <= MAX_CHAPTER_NUMBER ? chapterNumber : undefined
}

export function parseCommand(input: string): ParsedCommand | null {
  const text = input.trim()
  if (!text) return null

  const write = matchChapterCommand(text, 'write|写')
  if (write != null) return { kind: 'write', chapterNumber: write }

  if (/^\/(?:resume|继续)$/i.test(text)) return { kind: 'resume' }

  const rewrite = matchChapterCommand(text, 'rewrite|重写')
  if (rewrite != null) return { kind: 'rewrite', chapterNumber: rewrite }

  const discuss = matchChapterCommand(text, 'discuss|群聊')
  if (discuss != null) return { kind: 'discuss', chapterNumber: discuss }

  // 参数越界的命令（如 /写 0）：动词匹配但章节号无效，单独成类
  // （区别于 unknown 的"未匹配动词"与 chat 的"非命令"），由调用方 toast 提示
  if (write === undefined || rewrite === undefined || discuss === undefined) {
    return { kind: 'invalid-chapter', raw: text }
  }

  if (text.startsWith('/')) return { kind: 'unknown', raw: text }
  return { kind: 'chat' }
}
