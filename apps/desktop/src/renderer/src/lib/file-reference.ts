/**
 * 助手输出里的文件引用解析。
 *
 * ## 为什么需要
 *
 * Agent 回答里到处是 `src/foo.ts:42`、`apps/desktop/src/index.tsx#L10-L20` 这样的
 * 引用。原来它们只是纯文本 —— 用户看到一个位置，还得自己去侧栏/编辑器里找。
 * 解析出来做成可点击链接，点一下就能在内置预览里打开对应文件（并定位到行）。
 *
 * ## 为什么不用 markdown 的链接语法解决
 *
 * 模型很少把文件引用写成 `[foo.ts](...)`，绝大多数是裸文本。所以只能在渲染阶段
 * 扫文本节点，自己认这些形态。
 */

/** 解析出的文件引用 */
export interface FileReference {
  /** 原始匹配文本，用于替换 */
  raw: string
  /** 文件路径（已剥掉行号 / 锚点） */
  path: string
  /** 起始行号 */
  line?: number
  /** 列号（`path:12:5` 形式） */
  column?: number
  /** 结束行号（`#L10-L20` 形式） */
  endLine?: number
}

/**
 * 看起来像代码文件的扩展名。
 *
 * 用白名单而不是「任何带点的 token」：后者会把 `1.5`、`e.g.`、域名、版本号
 * 全认成文件，链接满天飞反而更难读。宁可漏掉冷门扩展名。
 */
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
  'json', 'jsonc', 'json5',
  'css', 'scss', 'sass', 'less',
  'html', 'htm', 'vue', 'svelte', 'astro',
  'md', 'mdx', 'txt', 'rst',
  'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs',
  'php', 'lua', 'pl', 'r', 'jl', 'dart', 'ex', 'exs', 'scala', 'clj',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'sql', 'graphql', 'gql', 'proto',
  'gd', 'tres', 'tscn',
  'lock', 'gitignore', 'dockerfile', 'makefile',
])

/**
 * 文件引用的整体形状。
 *
 * 分三段：
 * 1. 路径主体 —— 允许 `/`、`\`、`.`、`-`、`_`、`@`、字母数字；至少含一个 `.` 或 `/`
 * 2. 可选的 `#L10` / `#L10-L20` 锚点（GitHub 风格）
 * 3. 可选的 `:12` / `:12:5` 行列号
 *
 * 前置断言排除掉 URL：`http://a/b.ts` 里的 `a/b.ts` 不该单独成链接。
 */
const FILE_REF_RE =
  /(?<![\w:/\\@.-])((?:[A-Za-z]:[\\/])?[\w.@-]+(?:[\\/][\w.@-]+)*)(?:#L(\d+)(?:-L(\d+))?|:(\d+)(?::(\d+))?)?(?![\w/\\.-])/g

/** URL 片段：命中时整段跳过，避免把 host/path 认成文件 */
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi

/** 路径主体是否像文件（有已知扩展名，或是明确的多级相对路径） */
function looksLikeFilePath(path: string): boolean {
  // 排除纯数字、纯版本号
  if (/^[\d.]+$/.test(path)) return false

  const segments = path.split(/[\\/]/)
  const last = segments[segments.length - 1]
  if (!last) return false

  const dotIndex = last.lastIndexOf('.')
  if (dotIndex > 0) {
    const ext = last.slice(dotIndex + 1).toLowerCase()
    if (CODE_EXTENSIONS.has(ext)) return true
  }
  // 无扩展名但整体是已知的裸文件名（Makefile / Dockerfile 等）
  if (CODE_EXTENSIONS.has(last.toLowerCase())) return true

  return false
}

/** 记录 URL 覆盖的区间，用于跳过 */
function urlRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const re = new RegExp(URL_RE.source, URL_RE.flags)
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    ranges.push([match.index, match.index + match[0].length])
  }
  return ranges
}

function inRanges(index: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => index >= start && index < end)
}

/** 把一段纯文本切成「普通文本」与「文件引用」交替的片段 */
export type TextPart = { kind: 'text'; text: string } | { kind: 'ref'; ref: FileReference }

export function splitFileReferences(text: string): TextPart[] {
  if (!text) return []

  const skip = urlRanges(text)
  const parts: TextPart[] = []
  let lastIndex = 0

  const re = new RegExp(FILE_REF_RE.source, FILE_REF_RE.flags)
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const [raw, path, anchorStart, anchorEnd, lineStr, columnStr] = match
    if (inRanges(match.index, skip)) continue
    if (!looksLikeFilePath(path)) continue

    if (match.index > lastIndex) {
      parts.push({ kind: 'text', text: text.slice(lastIndex, match.index) })
    }

    const line = anchorStart ?? lineStr
    parts.push({
      kind: 'ref',
      ref: {
        raw,
        path,
        line: line != null ? Number(line) : undefined,
        column: columnStr != null ? Number(columnStr) : undefined,
        endLine: anchorEnd != null ? Number(anchorEnd) : undefined,
      },
    })
    lastIndex = match.index + raw.length
  }

  if (lastIndex < text.length) {
    parts.push({ kind: 'text', text: text.slice(lastIndex) })
  }

  // 全是普通文本时返回单段，让调用方能走快路径
  return parts
}

/** 是否含至少一个文件引用（快速判断，避免无谓地切分） */
export function hasFileReference(text: string): boolean {
  return splitFileReferences(text).some((part) => part.kind === 'ref')
}
