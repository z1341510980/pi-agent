import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ReactMarkdown from 'react-markdown'
import { MarkdownAnchor } from '../markdown-anchor'
import { FileReferenceProvider } from '../file-reference-context'
import { rehypeFileReferences } from '@/lib/rehype-file-references'

/**
 * 端到端串一遍：markdown 文本 → rehype 插件替换 → MarkdownAnchor 渲染 → 点击回调。
 * 单独测插件或单独测组件都测不出"接线对不对"。
 */

afterEach(cleanup)

function renderMarkdown(source: string, openFile?: (ref: unknown) => void): ReturnType<typeof render> {
  const tree = (
    <ReactMarkdown rehypePlugins={[rehypeFileReferences]} components={{ a: MarkdownAnchor }}>
      {source}
    </ReactMarkdown>
  )
  return render(
    openFile ? (
      <FileReferenceProvider value={{ openFile: openFile as never }}>{tree}</FileReferenceProvider>
    ) : (
      tree
    ),
  )
}

describe('文件引用链接', () => {
  it('把 path:line 渲染成可点击按钮', () => {
    renderMarkdown('详见 src/foo.ts:42 的实现', vi.fn())

    const button = screen.getByRole('button')
    expect(button.textContent).toContain('src/foo.ts:42')
    expect(button.getAttribute('title')).toBe('打开 src/foo.ts（第 42 行）')
  })

  it('点击回传解析后的路径与行号', () => {
    const openFile = vi.fn()
    renderMarkdown('详见 src/foo.ts:42:7', openFile)

    fireEvent.click(screen.getByRole('button'))
    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'src/foo.ts', line: 42, column: 7 }),
    )
  })

  it('#L 区间带上结束行', () => {
    const openFile = vi.fn()
    renderMarkdown('见 a/b.ts#L10-L20', openFile)

    fireEvent.click(screen.getByRole('button'))
    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'a/b.ts', line: 10, endLine: 20 }),
    )
  })

  it('没有 Provider 时降级为纯文本 code，不报错', () => {
    renderMarkdown('见 src/foo.ts:42')

    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('src/foo.ts:42').tagName).toBe('CODE')
  })

  it('代码块里的路径不变成链接', () => {
    renderMarkdown('```\nsrc/foo.ts:42\n```', vi.fn())

    expect(screen.queryByRole('button')).toBeNull()
  })

  it('行内代码里的路径不变成链接', () => {
    renderMarkdown('运行 `src/foo.ts:42`', vi.fn())

    expect(screen.queryByRole('button')).toBeNull()
  })

  it('真链接照常渲染为 a，不被当作文件引用', () => {
    renderMarkdown('[文档](https://example.com/guide.md)', vi.fn())

    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe('https://example.com/guide.md')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('一段话里的多个引用各自成链接', () => {
    renderMarkdown('从 a/b.ts:1 移到 c/d.ts:2', vi.fn())

    expect(screen.getAllByRole('button')).toHaveLength(2)
  })

  it('普通文本不产生任何链接', () => {
    renderMarkdown('这段话里没有文件引用，只有 3.14 和 example.com', vi.fn())

    expect(screen.queryByRole('button')).toBeNull()
  })
})
