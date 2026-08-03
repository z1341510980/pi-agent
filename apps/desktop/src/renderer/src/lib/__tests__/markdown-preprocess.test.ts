import { describe, expect, it } from 'vitest'
import {
  closeUnterminatedFence,
  convertLatexDelimiters,
  prepareMarkdown,
  stripThinkTags,
} from '../markdown-preprocess'

describe('convertLatexDelimiters', () => {
  it('把块级 \\[ … \\] 转成 $$ … $$', () => {
    expect(convertLatexDelimiters('前 \\[x^2 + y^2\\] 后')).toBe('前 $$x^2 + y^2$$ 后')
  })

  it('把行内 \\( … \\) 转成 $ … $', () => {
    expect(convertLatexDelimiters('质量 \\(E = mc^2\\) 能量')).toBe('质量 $E = mc^2$ 能量')
  })

  it('不动代码围栏里的反斜杠定界符', () => {
    const input = '```js\nconst re = /\\[abc\\]/\n```'
    expect(convertLatexDelimiters(input)).toBe(input)
  })

  it('不动行内代码里的反斜杠定界符', () => {
    const input = '正则写作 `\\(group\\)` 这样'
    expect(convertLatexDelimiters(input)).toBe(input)
  })

  it('代码块之外的公式照常转换', () => {
    const input = '```js\nvar a = "\\[x\\]"\n```\n然后 \\(y\\) 是变量'
    expect(convertLatexDelimiters(input)).toBe('```js\nvar a = "\\[x\\]"\n```\n然后 $y$ 是变量')
  })

  it('没有定界符时原样返回（快路径）', () => {
    const input = '普通文本 $a$ 已经是 dollar 形式'
    expect(convertLatexDelimiters(input)).toBe(input)
  })

  it('支持跨行的块级公式', () => {
    expect(convertLatexDelimiters('\\[\na + b\n\\]')).toBe('$$\na + b\n$$')
  })
})

describe('closeUnterminatedFence', () => {
  it('补齐未闭合的 ``` 围栏', () => {
    expect(closeUnterminatedFence('说明\n```ts\nconst a = 1')).toBe('说明\n```ts\nconst a = 1\n```')
  })

  it('已闭合时不动', () => {
    const input = '```ts\nconst a = 1\n```'
    expect(closeUnterminatedFence(input)).toBe(input)
  })

  it('没有围栏时不动', () => {
    expect(closeUnterminatedFence('纯文本')).toBe('纯文本')
  })

  it('支持 ~~~ 围栏', () => {
    expect(closeUnterminatedFence('~~~py\nx = 1')).toBe('~~~py\nx = 1\n~~~')
  })

  it('结尾已有换行时不重复加换行', () => {
    expect(closeUnterminatedFence('```\ncode\n')).toBe('```\ncode\n```')
  })

  it('带语言标注的行不当作结尾围栏', () => {
    // 第二个 ```json 是新块的开始，不是前一块的结束 → 整体仍未闭合
    expect(closeUnterminatedFence('```ts\na\n```json\nb')).toBe('```ts\na\n```json\nb\n```')
  })

  it('多个成对围栏后再开一个未闭合的，只补一个', () => {
    const input = '```a\n1\n```\n中间\n```b\n2'
    expect(closeUnterminatedFence(input)).toBe(`${input}\n\`\`\``)
  })

  it('更长的结尾围栏也算闭合', () => {
    const input = '```\ncode\n````'
    expect(closeUnterminatedFence(input)).toBe(input)
  })
})

describe('stripThinkTags', () => {
  it('去掉成对的 <think> 块', () => {
    expect(stripThinkTags('<think>内部推理</think>正文')).toBe('正文')
  })

  it('去掉 <thinking> 变体', () => {
    expect(stripThinkTags('<thinking>x</thinking>y')).toBe('y')
  })

  it('去掉孤立的闭合标签（MiniMax 等会只吐这个）', () => {
    expect(stripThinkTags('推理残留</think>正文')).toBe('推理残留正文')
  })

  it('没有标签时原样返回', () => {
    expect(stripThinkTags('普通正文')).toBe('普通正文')
  })
})

describe('prepareMarkdown', () => {
  it('流式时补围栏', () => {
    expect(prepareMarkdown('```ts\na', true)).toBe('```ts\na\n```')
  })

  it('完成后不补围栏（缺围栏是模型的问题，渲染层不掩盖）', () => {
    expect(prepareMarkdown('```ts\na', false)).toBe('```ts\na')
  })

  it('先剥 think 标签再转定界符', () => {
    expect(prepareMarkdown('<think>忽略 \\(a\\)</think>结果 \\(b\\)', false)).toBe('结果 $b$')
  })
})
