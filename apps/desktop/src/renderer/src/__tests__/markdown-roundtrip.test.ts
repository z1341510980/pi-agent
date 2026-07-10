import { describe, it, expect } from 'vitest'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from 'tiptap-markdown'

/**
 * 辅助：Markdown 字符串 → Tiptap 解析 → 重新序列化为 Markdown
 */
function roundtrip(md: string): string {
  const editor = new Editor({
    extensions: [StarterKit, Markdown],
    content: md,
  })
  const output = (editor.storage as { markdown?: { getMarkdown(): string } }).markdown?.getMarkdown() ?? ''
  editor.destroy()
  return output
}

describe('Markdown 往返转换', () => {
  it('标题保留', () => {
    const input = '# 一级标题\n\n## 二级标题\n\n### 三级标题'
    const output = roundtrip(input)
    expect(output).toContain('# 一级标题')
    expect(output).toContain('## 二级标题')
    expect(output).toContain('### 三级标题')
  })

  it('段落与粗斜体保留', () => {
    const input = '这是**粗体**和*斜体*的混合'
    const output = roundtrip(input)
    expect(output).toContain('**粗体**')
    expect(output).toContain('*斜体*')
  })

  it('引用保留', () => {
    const input = '正文\n\n> 引用内容\n\n正文'
    const output = roundtrip(input)
    expect(output).toContain('> 引用内容')
  })

  it('有序列表保留', () => {
    const input = '1. 第一项\n2. 第二项\n3. 第三项'
    const output = roundtrip(input)
    expect(output).toMatch(/1\.\s*第一项/)
    expect(output).toMatch(/2\.\s*第二项/)
    expect(output).toMatch(/3\.\s*第三项/)
  })

  it('无序列表保留（标记可统一化）', () => {
    const input = '- 第一项\n- 第二项\n- 第三项'
    const output = roundtrip(input)
    expect(output).toContain('第一项')
    expect(output).toContain('第二项')
    expect(output).toContain('第三项')
  })

  it('分割线保留', () => {
    const input = '上文\n\n---\n\n下文'
    const output = roundtrip(input)
    expect(output).toMatch(/^---$/m)
  })

  it('中文长文本不丢失字符', () => {
    const input = '这是一段较长的中文正文，用于验证字符不丢失。包含逗号、句号、问号？感叹号！顿号、书名号《书》。'
    const output = roundtrip(input)
    const normalize = (s: string) => s.replace(/\s+/g, '')
    expect(normalize(output)).toContain(normalize(input))
  })
})
