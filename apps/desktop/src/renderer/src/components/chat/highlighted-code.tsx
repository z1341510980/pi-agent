import { Light as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vs, vs2015 } from 'react-syntax-highlighter/dist/esm/styles/hljs'
import bash from 'react-syntax-highlighter/dist/esm/languages/hljs/bash'
import c from 'react-syntax-highlighter/dist/esm/languages/hljs/c'
import cpp from 'react-syntax-highlighter/dist/esm/languages/hljs/cpp'
import csharp from 'react-syntax-highlighter/dist/esm/languages/hljs/csharp'
import css from 'react-syntax-highlighter/dist/esm/languages/hljs/css'
import diff from 'react-syntax-highlighter/dist/esm/languages/hljs/diff'
import dockerfile from 'react-syntax-highlighter/dist/esm/languages/hljs/dockerfile'
import go from 'react-syntax-highlighter/dist/esm/languages/hljs/go'
import ini from 'react-syntax-highlighter/dist/esm/languages/hljs/ini'
import java from 'react-syntax-highlighter/dist/esm/languages/hljs/java'
import javascript from 'react-syntax-highlighter/dist/esm/languages/hljs/javascript'
import json from 'react-syntax-highlighter/dist/esm/languages/hljs/json'
import kotlin from 'react-syntax-highlighter/dist/esm/languages/hljs/kotlin'
import lua from 'react-syntax-highlighter/dist/esm/languages/hljs/lua'
import markdown from 'react-syntax-highlighter/dist/esm/languages/hljs/markdown'
import php from 'react-syntax-highlighter/dist/esm/languages/hljs/php'
import plaintext from 'react-syntax-highlighter/dist/esm/languages/hljs/plaintext'
import powershell from 'react-syntax-highlighter/dist/esm/languages/hljs/powershell'
import python from 'react-syntax-highlighter/dist/esm/languages/hljs/python'
import ruby from 'react-syntax-highlighter/dist/esm/languages/hljs/ruby'
import rust from 'react-syntax-highlighter/dist/esm/languages/hljs/rust'
import scss from 'react-syntax-highlighter/dist/esm/languages/hljs/scss'
import shell from 'react-syntax-highlighter/dist/esm/languages/hljs/shell'
import sql from 'react-syntax-highlighter/dist/esm/languages/hljs/sql'
import swift from 'react-syntax-highlighter/dist/esm/languages/hljs/swift'
import typescript from 'react-syntax-highlighter/dist/esm/languages/hljs/typescript'
import xml from 'react-syntax-highlighter/dist/esm/languages/hljs/xml'
import yaml from 'react-syntax-highlighter/dist/esm/languages/hljs/yaml'
import type { ReactElement } from 'react'

/**
 * 语法高亮的实际实现，**独立模块以便按需加载**。
 *
 * hljs 核心加 28 个语言定义有几百 KB。绝大多数会话根本不含代码块，把它压进主包
 * 只是让每次冷启动都多读一遍。CodeBlock 用 `lazy()` 引这个模块，未加载完成前
 * 显示无高亮的纯文本 —— 内容立刻可读，颜色随后补上。
 *
 * 语言用 Light 构建显式注册而不是用全量 `Prism`：注册表决定了这个 chunk 的大小，
 * 按需列举比图省事重要。
 */

const LANGUAGES: Record<string, unknown> = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lua,
  markdown,
  php,
  plaintext,
  powershell,
  python,
  ruby,
  rust,
  scss,
  shell,
  sql,
  swift,
  typescript,
  xml,
  yaml,
}

for (const [name, definition] of Object.entries(LANGUAGES)) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  SyntaxHighlighter.registerLanguage(name, definition as any)
}

/** 常见别名 → 已注册的 hljs 语言名 */
const LANGUAGE_ALIASES: Record<string, string> = {
  cs: 'csharp',
  'c++': 'cpp',
  cxx: 'cpp',
  docker: 'dockerfile',
  h: 'c',
  hpp: 'cpp',
  htm: 'xml',
  html: 'xml',
  js: 'javascript',
  jsx: 'javascript',
  kt: 'kotlin',
  md: 'markdown',
  mjs: 'javascript',
  patch: 'diff',
  ps1: 'powershell',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  svg: 'xml',
  text: 'plaintext',
  toml: 'ini',
  ts: 'typescript',
  tsx: 'typescript',
  txt: 'plaintext',
  vue: 'xml',
  yml: 'yaml',
  zsh: 'bash',
}

/** 解析为已注册的 hljs 语言名；未知语言回落 plaintext */
export function resolveHljsLanguage(raw: string | null): string {
  if (!raw) return 'plaintext'
  const mapped = LANGUAGE_ALIASES[raw] ?? raw
  return mapped in LANGUAGES ? mapped : 'plaintext'
}

export interface HighlightedCodeProps {
  code: string
  /** 原始语言标记（未归一化） */
  language: string | null
  isDark: boolean
}

export default function HighlightedCode({
  code,
  language,
  isDark,
}: HighlightedCodeProps): ReactElement {
  return (
    <SyntaxHighlighter
      language={resolveHljsLanguage(language)}
      style={isDark ? vs2015 : vs}
      // 背景交给外层容器，否则主题色和语义 token 打架
      customStyle={{
        margin: 0,
        padding: '12px 14px',
        background: 'transparent',
        fontSize: '12.5px',
        lineHeight: '1.6',
      }}
      codeTagProps={{ style: { fontFamily: 'var(--font-mono, ui-monospace, monospace)' } }}
    >
      {code}
    </SyntaxHighlighter>
  )
}
