import type { Theme } from '@/types/theme'
import { getSystemPrefersDark } from './system-appearance'
import { processCustomCss } from './custom-css-processor'

/**
 * 把 token 对象转 CSS 字符串
 * 与 AionUi tokensToCss 一致
 */
function tokensToCss(tokens?: Record<string, string>): string | null {
  if (!tokens || Object.keys(tokens).length === 0) return null
  const body = Object.entries(tokens)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n')
  return `:root {\n${body}\n}`
}

function upsertStyle(root: Document, id: string, content: string | null): void {
  if (typeof document === 'undefined') return
  let el = root.getElementById(id) as HTMLStyleElement | null
  if (!content) {
    if (el) el.remove()
    return
  }
  if (!el) {
    el = root.createElement('style')
    el.id = id
    root.head.appendChild(el)
  }
  el.textContent = content
}

/**
 * 应用主题
 * 1. 设置 html data-theme 属性
 * 2. 设置 body class（.dark / .light）— 与现有 main.css @custom-variant dark 兼容
 * 3. 写入 <style id="theme-tokens">（结构化 token）
 * 4. 写入 <style id="theme-decoration">（自定义 CSS）
 */
export function applyTheme(theme: Theme, root: Document = document): void {
  const appearance = theme.appearance === 'system'
    ? (getSystemPrefersDark() ? 'dark' : 'light')
    : theme.appearance

  root.documentElement.setAttribute('data-theme', appearance)
  root.documentElement.classList.toggle('dark', appearance === 'dark')

  upsertStyle(root, 'theme-tokens', tokensToCss(theme.tokens))
  upsertStyle(root, 'theme-decoration', theme.css ? processCustomCss(theme.css) : null)
}
