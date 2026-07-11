import { describe, it, expect } from 'vitest'
import { extractContent } from '../content-extractor.js'

const SAMPLE_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>宋代茶文化 - 维基百科</title>
  <meta charset="utf-8">
</head>
<body>
  <nav><a href="/">首页</a> | <a href="/about">关于</a></nav>
  <header><h1>网站标题</h1></header>
  <main>
    <article>
      <h1>宋代茶文化</h1>
      <p>宋代是中国茶文化发展的鼎盛时期。点茶法在此时盛行，影响深远。</p>
      <p>宋徽宗赵佶著有《大观茶论》，详细记载了点茶技艺。</p>
      <p>斗茶是宋代流行的茶艺竞技活动，通过比拼茶汤色泽和咬盏情况评判优劣。</p>
    </article>
  </main>
  <footer>版权所有 © 2026</footer>
  <script>console.log('tracking')</script>
</body>
</html>
`

describe('extractContent', () => {
  it('从 HTML 提取正文并转 Markdown', async () => {
    const result = await extractContent(SAMPLE_HTML, 'https://example.com/tea')

    expect(result.ok).toBe(true)
    expect(result.title).toContain('宋代茶文化')
    expect(result.content).toContain('点茶法')
    expect(result.content).toContain('大观茶论')
    expect(result.content).toContain('斗茶')
    expect(result.content).not.toContain('首页')
    expect(result.content).not.toContain('版权所有')
    expect(result.content).not.toContain('tracking')
  })

  it('正文应为 Markdown 格式（包含标题或段落）', async () => {
    const result = await extractContent(SAMPLE_HTML, 'https://example.com/tea')
    expect(result.ok).toBe(true)
    expect(result.content).toMatch(/^(#|宋)/m)
  })

  it('空 HTML 返回 ok:false', async () => {
    const result = await extractContent('', 'https://example.com')
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('无正文的页面返回 ok:false', async () => {
    const html = '<html><head><title>x</title></head><body></body></html>'
    const result = await extractContent(html, 'https://example.com')
    expect(result.ok).toBe(false)
  })
})
