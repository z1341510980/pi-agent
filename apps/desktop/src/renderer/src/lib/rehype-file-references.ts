import { splitFileReferences } from '@/lib/file-reference'

/**
 * rehype 插件：把文本节点里的文件引用替换成带标记的 `<a>`。
 *
 * ## 为什么必须是 rehype 插件
 *
 * react-markdown 的 `components` 映射只能覆盖**元素**，覆盖不到文本节点。
 * 而文件引用（`src/a.ts:42`）在 markdown 里就是裸文本，只能在 AST 阶段替换。
 *
 * ## 跳过 code / pre / a
 *
 * - `code` / `pre`：代码块由 CodeBlock 接管，且里面的路径本来就是代码内容，
 *   插入元素会破坏它拿到的原始字符串。
 * - `a`：已经是链接了，不该在链接里再套一层链接。
 */

/** 最小化的 hast 节点形状 —— 只用到这几个字段，不值得为此引 @types/hast */
interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

/** 这些元素内部不做替换 */
const SKIP_TAGS = new Set(['code', 'pre', 'a'])

export function rehypeFileReferences() {
  return (tree: HastNode): void => {
    walk(tree)
  }
}

function walk(node: HastNode): void {
  const children = node.children
  if (!children || children.length === 0) return

  const next: HastNode[] = []
  let changed = false

  for (const child of children) {
    if (child.type === 'element' && child.tagName && SKIP_TAGS.has(child.tagName)) {
      next.push(child)
      continue
    }

    if (child.type !== 'text' || typeof child.value !== 'string') {
      walk(child)
      next.push(child)
      continue
    }

    const parts = splitFileReferences(child.value)
    if (!parts.some((part) => part.kind === 'ref')) {
      next.push(child)
      continue
    }

    changed = true
    for (const part of parts) {
      if (part.kind === 'text') {
        next.push({ type: 'text', value: part.text })
        continue
      }
      const { ref } = part
      next.push({
        type: 'element',
        tagName: 'a',
        properties: {
          // 用 data-* 传递：react-markdown 会把它们透给 components.a 的 props
          'data-file-ref': ref.path,
          'data-file-line': ref.line != null ? String(ref.line) : undefined,
          'data-file-column': ref.column != null ? String(ref.column) : undefined,
          'data-file-end-line': ref.endLine != null ? String(ref.endLine) : undefined,
        },
        children: [{ type: 'text', value: ref.raw }],
      })
    }
  }

  if (changed) node.children = next
}
