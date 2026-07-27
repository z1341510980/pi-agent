/**
 * 用户自定义 CSS 处理器
 * 1. addImportantToAll：给每个声明加 !important（已含则跳过）
 * 2. wrapCustomCss：加注释头
 * 3. processCustomCss = wrapCustomCss(addImportantToAll(css))
 * 4. validateCss：仅大括号配对 + 冒号存在检查（非真实 CSS 解析）
 *
 * 已知限制（escape hatch，用户自负其责）：
 * - 不支持含 `:` 的复杂选择器（如 `a::after`、`tr:nth-child(2n)`）
 * - 不解析 `url(...)` / 字符串字面量，含 `;` 的值（如 data URL）会被切断
 * - 仅适用于简单的 `selector { property: value; }` 块
 * 如需复杂 CSS，建议直接修改 main.css 而非用自定义 CSS 注入
 */

export function addImportantToAll(css: string): string {
  return css.replace(/([\w-]+)\s*:\s*([^;!}]+);/g, (match, prop, value) => {
    if (value.trim().endsWith('!important')) return match
    return `${prop}: ${value} !important;`
  })
}

export function wrapCustomCss(css: string): string {
  return `/* 用户自定义样式 - 由 pi-agent 注入 */\n${css}`
}

export function processCustomCss(css: string): string {
  return wrapCustomCss(addImportantToAll(css))
}

export function validateCss(css: string): { valid: boolean; error?: string } {
  if (!css.trim()) return { valid: true }
  const opens = (css.match(/{/g) || []).length
  const closes = (css.match(/}/g) || []).length
  if (opens !== closes) return { valid: false, error: `大括号不配对：${opens} 个 { vs ${closes} 个 }` }
  if (!/:\s*[^{}]+;?/g.test(css)) return { valid: false, error: '未检测到 CSS 声明（需要 property: value; 形式）' }
  return { valid: true }
}
