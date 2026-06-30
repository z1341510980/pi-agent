/**
 * 计算中文字数（按字符计）
 * 去除空白与 Markdown 标记后按字符计数。
 * 与后端 novel-routes.ts PATCH /chapters/:id 的 wordCount 重算逻辑保持一致。
 */
export function countWords(text: string): number {
  if (!text) return 0
  const cleaned = text.replace(/[#*`>\-\[\]()!]/g, '').replace(/\s+/g, '')
  return cleaned.length
}
