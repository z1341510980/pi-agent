/**
 * Markdown 流式渲染的预处理。
 *
 * 这些函数处理的都是「模型输出还没写完」或「模型写的不是标准 markdown」的情况。
 * 全部是纯字符串变换，便于单测。
 */

/** 代码块（围栏）与行内代码的匹配。先切出来，后面的替换要跳过这些区域。 */
const CODE_SEGMENT_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g

/**
 * 把 LaTeX 的 `\[…\]` / `\(…\)` 定界符转换为 remark-math 认识的 `$$…$$` / `$…$`。
 *
 * 很多模型（尤其被 prompt 要求"用 LaTeX"时）输出的是反斜杠定界符，而
 * remark-math 只认 `$`。不转换的话公式会原样显示成 `\[ x^2 \]`。
 *
 * **必须跳过代码块和行内代码**：代码里出现 `\[` 是正常的（正则、转义序列），
 * 无脑替换会把代码改坏。所以先按代码片段切分，只在非代码片段上替换。
 */
export function convertLatexDelimiters(input: string): string {
  if (!input.includes('\\[') && !input.includes('\\(')) return input

  return splitByCode(input)
    .map((segment) =>
      segment.isCode
        ? segment.text
        : segment.text
            // 块级：\[ … \] → $$ … $$
            .replace(/\\\[([\s\S]*?)\\\]/g, (_m, body: string) => `$$${body}$$`)
            // 行内：\( … \) → $ … $
            .replace(/\\\(([\s\S]*?)\\\)/g, (_m, body: string) => `$${body}$`),
    )
    .join('')
}

/**
 * 流式期间补齐未闭合的代码围栏。
 *
 * 模型吐出 ```` ```ts ```` 之后、还没吐出结尾围栏的这段时间里，react-markdown 会把
 * **剩余全部内容**当作代码块的一部分。表现是：正文突然整段变成等宽灰块，写完
 * 结尾围栏后又跳回正常排版 —— 每次输出代码都要闪一下。
 *
 * 补一个虚拟的结尾围栏就能让它稳定地按代码块渲染。只在流式期间调用；
 * 消息完成后应该用原文（若真的缺围栏，那是模型的问题，不该由渲染层掩盖）。
 */
export function closeUnterminatedFence(input: string): string {
  const lines = input.split('\n')
  let fence: string | null = null

  for (const line of lines) {
    const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (!match) continue
    const marker = match[1]
    if (fence === null) {
      fence = marker[0].repeat(marker.length)
    } else if (marker[0] === fence[0] && marker.length >= fence.length) {
      // 结尾围栏不能带语言标注，否则算新的开始
      if (line.slice(match.index + marker.length).trim() === '') fence = null
    }
  }

  if (fence === null) return input
  const needsNewline = input.endsWith('\n') ? '' : '\n'
  return `${input}${needsNewline}${fence}`
}

/**
 * 去掉 `<think>` / `<thinking>` 标签。
 *
 * 部分模型（MiniMax 等）会把推理内容包在这类标签里混在正文流中，甚至只吐一个
 * 孤立的 `</think>` 闭合标签。思考内容在 pi-agent 里走独立的 thinking 通道，
 * 正文里出现这些标签纯属噪声。
 */
export function stripThinkTags(input: string): string {
  if (!input.includes('<think')) {
    // 孤立闭合标签也要处理
    return input.includes('</think') ? input.replace(/<\/think(?:ing)?>/gi, '') : input
  }
  return input
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<\/?think(?:ing)?>/gi, '')
}

/**
 * 渲染前的完整预处理。
 *
 * @param isStreaming 流式期间才补围栏 —— 完成后的内容应保持原样
 */
export function prepareMarkdown(input: string, isStreaming: boolean): string {
  let text = stripThinkTags(input)
  text = convertLatexDelimiters(text)
  if (isStreaming) text = closeUnterminatedFence(text)
  return text
}

// ── 内部工具 ──

interface Segment {
  text: string
  isCode: boolean
}

/** 按代码片段切分字符串，保留原文顺序 */
function splitByCode(input: string): Segment[] {
  const segments: Segment[] = []
  let lastIndex = 0

  // 每次调用都新建正则，避免共享 lastIndex 造成的状态污染
  const re = new RegExp(CODE_SEGMENT_RE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(input)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: input.slice(lastIndex, match.index), isCode: false })
    }
    segments.push({ text: match[0], isCode: true })
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < input.length) {
    segments.push({ text: input.slice(lastIndex), isCode: false })
  }
  return segments
}
