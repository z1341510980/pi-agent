import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useMemo, type ReactElement } from 'react'
import type { ChatMessage, FileAttachment, ToolCallInfo } from './types'
import { readSegments } from './types'
import { ThinkingBlock } from './thinking-block'
import { ToolCallCard } from './tool-call-card'
import { ToolSummaryCard } from './tool-summary-card'
import { MessageHoverActions } from './message-hover-actions'
import { FileAttachmentList } from './file-attachment'
import { CodeBlock } from './code-block'
import { MarkdownAnchor } from './markdown-anchor'
import { prepareMarkdown } from '@/lib/markdown-preprocess'
import { useMathPlugins, type MarkdownPluginList } from '@/lib/markdown-math'
import { rehypeFileReferences } from '@/lib/rehype-file-references'
import { cn } from '@/lib/utils'
import type { FilePreviewState } from '@/stores/ui-store'

/**
 * Markdown 自定义渲染器。
 *
 * **必须是模块级常量。** 如果在组件里内联字面量，每个流式 delta 都会产生新的
 * 函数 identity，React 会把所有自定义组件卸载重挂 —— 代码块的展开状态、
 * 复制反馈、mermaid 已渲染的 SVG 全部丢失。（AionUi 在 Markdown/index.tsx 里
 * 为此专门写了注释。）
 *
 * `pre` 透传是因为 CodeBlock 自带容器：不透传会套出 `<pre><div>…</div></pre>`。
 */
const MARKDOWN_COMPONENTS: Components = {
  code: CodeBlock,
  pre: ({ children }) => <>{children}</>,
  // 既处理真链接，也处理 rehype-file-references 生成的文件引用
  a: MarkdownAnchor,
  // 宽表必须能横向滚动，否则会把整条消息的宽度撑破。样式在 main.css 的
  // .message-table-scroll 里，这里只负责套容器。
  table: ({ children }) => (
    <div className="message-table-scroll">
      <table>{children}</table>
    </div>
  ),
}

/** 插件数组同样提到模块级：每次渲染都传新数组会让 unified 重建整条处理链 */
const REMARK_PLUGINS: MarkdownPluginList = [remarkGfm]

/**
 * 数学插件（remark-math + rehype-katex + katex CSS）按内容**按需加载**，
 * 见 `lib/markdown-math.ts`。
 *
 * 一并说明：这里**不挂 rehype-raw**。助手输出属不可信内容，允许原始 HTML
 * 等于把 XSS 面暴露给模型输出。AionUi 把 `allowHtml` 做成按调用点选择的开关，
 * 聊天消息同样不开。
 */

/** prose 类名提到常量：每个文本分段都要用，且它长得离谱 */
const MARKDOWN_CLASS = `message-markdown prose prose-sm max-w-none
  prose-p:my-2 prose-p:leading-relaxed
  prose-headings:my-3 prose-headings:leading-tight
  prose-h1:text-base prose-h2:text-sm prose-h3:text-sm
  prose-ul:my-2 prose-ol:my-2
  prose-li:my-0.5
  prose-code:before:content-none prose-code:after:content-none
  prose-blockquote:my-2.5 prose-blockquote:border-l-2 prose-blockquote:border-l-primary/50 prose-blockquote:pl-3 prose-blockquote:not-italic prose-blockquote:font-normal prose-blockquote:text-muted-foreground
  prose-hr:my-4 prose-hr:border-border
  prose-a:text-primary prose-a:no-underline prose-a:decoration-primary/40 prose-a:underline-offset-2 hover:prose-a:underline
  prose-strong:text-text prose-strong:font-semibold prose-em:text-text-secondary
  prose-img:my-2 prose-img:rounded-lg`

/**
 * 渲染分组。
 *
 * 相邻的工具分段合并成一组：连续 3 个以上折叠为 ToolSummaryCard，否则逐个出卡。
 * 合并只在**相邻**范围内做 —— 中间夹了文字就该断开，那正是交错要表达的信息。
 */
type RenderGroup =
  | { kind: 'markdown'; id: string; source: string }
  | { kind: 'thinking'; id: string; content: string; isStreaming: boolean; startedAt?: number; endedAt?: number }
  | { kind: 'tools'; id: string; calls: ToolCallInfo[] }

function buildRenderGroups(message: ChatMessage): RenderGroup[] {  const isStreaming = message.status === 'streaming'
  const groups: RenderGroup[] = []

  for (const segment of readSegments(message)) {
    if (segment.kind === 'text') {
      if (!segment.text.trim()) continue
      groups.push({
        kind: 'markdown',
        id: segment.id,
        // 流式的只可能是最后一段；前面的段已经写完，不该再补围栏
        source: prepareMarkdown(segment.text, isStreaming),
      })
      continue
    }

    if (segment.kind === 'thinking') {
      if (!segment.content.trim()) continue
      groups.push({
        kind: 'thinking',
        id: segment.id,
        content: segment.content,
        isStreaming: segment.isStreaming,
        startedAt: segment.startedAt,
        endedAt: segment.endedAt,
      })
      continue
    }

    const last = groups[groups.length - 1]
    if (last?.kind === 'tools') {
      last.calls.push(segment.call)
    } else {
      groups.push({ kind: 'tools', id: segment.id, calls: [segment.call] })
    }
  }

  return groups
}

/**
 * 单个 markdown 文本分段。
 *
 * 独立成组件是为了让数学插件的按需加载有地方挂 —— hook 不能在 map 回调里调用。
 * 顺带每段自己判断要不要 math，只有真含公式的那一段会触发加载。
 */
function MarkdownSegment({ source }: { source: string }): ReactElement {
  const { remark, rehype } = useMathPlugins(REMARK_PLUGINS, source)
  // 文件引用插件必须排在最后：katex 生成的节点里不该再被扫一遍
  const rehypeWithRefs = useMemo(
    () => [...rehype, rehypeFileReferences] as typeof rehype,
    [rehype],
  )
  return (
    <div className={MARKDOWN_CLASS}>
      <ReactMarkdown
        remarkPlugins={remark}
        rehypePlugins={rehypeWithRefs}
        components={MARKDOWN_COMPONENTS}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
}
export interface MessageBubbleProps {  message: ChatMessage
  onFilePreview?: (file: FilePreviewState) => void
  /** 引用消息到输入框 */
  onQuote?: (text: string) => void
  /** 重新生成（仅 assistant 完成消息） */
  onRegenerate?: (message: ChatMessage) => void
}

/** 格式化时间戳为 HH:mm */
function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * MessageBubble：单条消息气泡（AionUi 风格对齐）
 *
 * 设计要点（借鉴 AionUi MessageText）：
 *   - 不显示头像与 Agent 名字（保持极简，对齐 AionUi）
 *   - 用户气泡：淡灰背景 (bg-surface-3) + 不对称圆角 (8px 0 8px 8px)，左上角无圆角
 *   - AI 消息：无背景色，仅 Markdown 文本与子组件（思考/工具调用）
 *   - 复制按钮 + 时间戳：默认 opacity-0，group-hover 时显现，固定行高避免抖动
 */
export function MessageBubble({
  message,
  onFilePreview,
  onQuote,
  onRegenerate
}: MessageBubbleProps): ReactElement {
  const isUser = message.role === 'user'

  // content 是文本分段的拼接，作为复制/引用/用户气泡的显示文本
  const displayContent = message.content

  /**
   * 按分段构建渲染分组。
   *
   * 用 useMemo：markdown 预处理不便宜，而流式期间只有最后一段在变 ——
   * 不缓存的话每个 delta 都会把前面所有段重新预处理一遍。
   */
  const renderGroups = useMemo(() => buildRenderGroups(message), [message])

  // 是否有可复制的文本内容（用于决定是否显示 hover 行）
  const hasCopyableText = Boolean(displayContent && displayContent.trim().length > 0)

  return (
    <article
      className={cn('group flex min-w-0', isUser ? 'justify-end' : 'justify-start')}
      data-message-role={message.role}
    >
      <div
        className={cn(
          'min-w-0 flex flex-col',
          isUser ? 'items-end max-w-[76%]' : 'items-start max-w-[88%]'
        )}
      >
        {/* ── 文件附件 ── */}
        {message.attachments && message.attachments.length > 0 && (
          <div className="mb-2 min-w-0 max-w-full">
            <FileAttachmentList
              attachments={message.attachments}
              onPreview={
                onFilePreview
                  ? (att: FileAttachment) =>
                      onFilePreview({
                        name: att.name,
                        content: att.content,
                        encoding: att.encoding,
                        mimeType: att.mimeType,
                        thumbnail: att.thumbnail,
                        size: att.size,
                        type: att.type
                      })
                  : undefined
              }
            />
          </div>
        )}

        {/* ── 文本气泡 ── */}
        {isUser ? (
          displayContent ? (
            <div className="message-user-bubble px-3.5 py-2.5 text-text text-sm leading-relaxed break-words [border-radius:14px_4px_14px_14px]">
              <p className="m-0 whitespace-pre-wrap text-pretty">{displayContent}</p>
            </div>
          ) : null
        ) : (
          /* AI 消息：按 segments 顺序渲染 —— 顺序即实际发生顺序 */
          <div className="text-sm text-text-secondary leading-relaxed min-w-0 break-words w-full">
            {renderGroups.map((group) => {
              if (group.kind === 'thinking') {
                return (
                  <ThinkingBlock
                    key={group.id}
                    content={group.content}
                    isStreaming={group.isStreaming}
                    startedAt={group.startedAt}
                    endedAt={group.endedAt}
                  />
                )
              }

              if (group.kind === 'tools') {
                return (
                  <div key={group.id} className="w-full min-w-0 space-y-1.5 my-2">
                    {group.calls.length >= 3 ? (
                      <ToolSummaryCard toolCalls={group.calls} />
                    ) : (
                      group.calls.map((call) => (
                        <ToolCallCard key={call.toolCallId} toolCall={call} />
                      ))
                    )}
                  </div>
                )
              }

              return <MarkdownSegment key={group.id} source={group.source} />
            })}
            {/* 错误标记 */}
            {message.status === 'error' && message.error && (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
                {message.error}
              </div>
            )}
          </div>
        )}

        {/* ── Hover 动作栏 + 时间戳（固定高度，避免抖动） ── */}
        {hasCopyableText && (
          <div
            className={cn(
              'h-6 flex items-center mt-1 gap-1.5 select-none',
              isUser && 'flex-row-reverse'
            )}
          >
            <MessageHoverActions message={message} onQuote={onQuote} onRegenerate={onRegenerate} />
            {message.createdAt && (
              <span className="text-[11px] text-hint opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                {formatTimestamp(message.createdAt)}
              </span>
            )}
          </div>
        )}
      </div>
    </article>
  )
}
