import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodeBlock } from '../code-block'

// mermaid 真身有 ~2.5MB 且依赖大量浏览器 API，测试里替换成可控假实现。
const mermaidRender = vi.fn()
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: (...args: unknown[]) => mermaidRender(...args),
  },
}))

/**
 * CodeBlock 的两处判断值得钉住：
 *
 * 1. **行内 vs 块级**。react-markdown v9 移除了 `inline` prop，只能靠"有没有换行 /
 *    有没有 language- 标记"自己判。判错的后果是流式时半个 ``` 围栏先闪一个空代码块。
 * 2. **折叠阈值**。工具输出动辄几百行，不折叠会把整屏挤满。
 */

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** 生成 n 行代码 */
function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i}`).join('\n')
}

describe('CodeBlock', () => {
  it('无换行且无语言标记时渲染为行内代码（不出现复制按钮）', () => {
    render(<CodeBlock>npm install</CodeBlock>)

    expect(screen.queryByRole('button', { name: '复制代码' })).toBeNull()
    expect(screen.getByText('npm install').tagName).toBe('CODE')
  })

  it('带 language- 标记时即使单行也渲染为块级', () => {
    render(<CodeBlock className="language-ts">const a = 1</CodeBlock>)

    expect(screen.getByRole('button', { name: '复制代码' })).not.toBeNull()
    expect(screen.getByText('ts')).not.toBeNull()
  })

  it('多行内容即使没有语言标记也渲染为块级，语言标签回落 text', () => {
    render(<CodeBlock>{'foo\nbar'}</CodeBlock>)

    expect(screen.getByRole('button', { name: '复制代码' })).not.toBeNull()
    expect(screen.getByText('text')).not.toBeNull()
  })

  it('未知语言不报错，标签仍显示原始语言名', () => {
    render(<CodeBlock className="language-brainfuck">{'+++\n---'}</CodeBlock>)

    expect(screen.getByText('brainfuck')).not.toBeNull()
  })

  it('短代码不出现折叠按钮', () => {
    render(<CodeBlock className="language-ts">{lines(10)}</CodeBlock>)

    expect(screen.queryByText(/展开剩余/)).toBeNull()
  })

  it('超过阈值的长代码出现折叠按钮，且提示剩余行数', () => {
    render(<CodeBlock className="language-ts">{lines(40)}</CodeBlock>)

    // 折叠态显示前 16 行，剩余 24 行
    expect(screen.getByText('展开剩余 24 行')).not.toBeNull()
  })

  it('markdown 解析产生的尾随换行不算作一行', () => {
    // 24 行 + 尾随 \n；阈值是 > 24，所以不该折叠
    render(<CodeBlock className="language-ts">{`${lines(24)}\n`}</CodeBlock>)

    expect(screen.queryByText(/展开剩余/)).toBeNull()
  })
})

describe('CodeBlock 的 mermaid 分支', () => {
  it('language-mermaid 走图表组件，初始停在源码视图', () => {
    // 渲染永不完成 → 保持源码视图（模拟流式中途的半成品语法）
    mermaidRender.mockReturnValue(new Promise(() => {}))

    render(<CodeBlock className="language-mermaid">{'graph TD\nA-->B'}</CodeBlock>)

    expect(screen.getByText('mermaid')).not.toBeNull()
    // 源码 tab 选中，图表 tab 因为还没渲染成功而禁用
    expect(screen.getByRole('tab', { name: /源码/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: /图表/ })).toHaveProperty('disabled', true)
  })

  it('语法不完整时给出解释而不是报错', () => {
    mermaidRender.mockRejectedValue(new Error('Parse error'))

    render(<CodeBlock className="language-mermaid">{'graph T'}</CodeBlock>)

    expect(screen.getByText(/图表语法尚不完整或有误/)).not.toBeNull()
  })

  it('渲染成功后自动切到图表视图', async () => {
    mermaidRender.mockResolvedValue({ svg: '<svg data-testid="diagram"></svg>' })

    render(<CodeBlock className="language-mermaid">{'graph TD\nA-->B'}</CodeBlock>)

    await waitFor(
      () => {
        expect(screen.getByRole('tab', { name: /图表/ }).getAttribute('aria-selected')).toBe('true')
      },
      { timeout: 2000 },
    )
  })
})
