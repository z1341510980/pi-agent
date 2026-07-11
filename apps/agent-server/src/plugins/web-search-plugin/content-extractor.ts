import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'
import TurndownService from 'turndown'
import type { ExtractionResult } from './types.js'

// Turndown 单例（避免重复创建）
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
})

// 移除脚本和样式（readability 不总是清理这些）
turndown.remove(['script', 'style', 'nav', 'footer', 'aside'])

/**
 * 从 HTML 提取正文并转 Markdown
 *
 * 使用 @mozilla/readability（Firefox Reader View 同款算法）提取正文，
 * 再用 turndown 转为 Markdown。
 *
 * @param html 原始 HTML
 * @param url 页面 URL（用于解析相对链接）
 */
export async function extractContent(
  html: string,
  url: string,
): Promise<ExtractionResult> {
  if (!html || html.trim().length === 0) {
    return { ok: false, error: 'HTML 内容为空' }
  }

  try {
    const dom = new JSDOM(html, { url })
    const reader = new Readability(dom.window.document)
    const article = reader.parse()

    if (!article || !article.content) {
      return { ok: false, error: '无法提取正文（可能是 JS 渲染页或无内容）' }
    }

    const markdown = turndown.turndown(article.content)

    if (!markdown || markdown.trim().length === 0) {
      return { ok: false, error: '提取到的正文为空' }
    }

    return {
      ok: true,
      title: article.title ?? undefined,
      content: markdown,
    }
  } catch (err) {
    return {
      ok: false,
      error: `正文提取失败: ${(err as Error).message}`,
    }
  }
}
