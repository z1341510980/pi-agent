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

/**
 * 助手消息流排版（对齐 dsh MarkdownText）：
 * 正文 16/28、块间距 16、链接业务蓝、行内代码浅灰胶囊。
 * 具体规则集中在 main.css 的 .message-markdown，这里只挂类名。
 */
const MARKDOWN_CLASS = `message-markdown`

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
 * 格式化相对时间（"刚刚"、"5分钟前"等）
 * 对标 DSH 的时间显示风格
 */
function formatRelativeTime(ts: number): string {
  const now = Date.now()
  const diff = now - ts

  if (diff < 0) return formatTimestamp(ts)

  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (seconds < 10) return '刚刚'
  if (seconds < 60) return `${seconds}秒前`
  if (minutes < 60) return `${minutes}分钟前`
  if (hours < 24) return `${hours}小时前`
  if (days < 7) return `${days}天前`
  return formatTimestamp(ts)
}

/**
 * MessageBubble：单条消息（对齐 dsh MessageItem）
 *
 * 设计要点（DeepSeek 会话流）：
 *   - 不显示头像与 Agent 名字
 *   - 用户气泡：浅蓝填充（deepseek-50）+ 22px 胶囊圆角，右对齐，525px 封顶
 *   - AI 消息：无气泡，16/28 文本流 + 思考/工具行
 *   - 复制按钮 + 时间戳：hover 显现
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
      data-time-hover-root=""
    >
      <div
        className={cn(
          'min-w-0 flex flex-col',
          isUser ? 'items-end max-w-[min(525px,82%)]' : 'items-start w-full'
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
            <div className="message-user-bubble px-4 py-2.5 text-base leading-6 text-text break-words rounded-[22px]">
              <p className="m-0 whitespace-pre-wrap text-pretty">{displayContent}</p>
            </div>
          ) : null
        ) : (
          /* AI 消息：按 segments 顺序渲染 —— 顺序即实际发生顺序 */
          <div className="min-w-0 break-words w-full">
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
                  <div key={group.id} className="w-full min-w-0 space-y-1 my-1">
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
              <div className="mt-2 flex items-start gap-2 text-[13px] leading-5">
                <span className="mt-[7px] size-2 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
                <span className="font-semibold text-destructive">出错了</span>
                <span className="min-w-0 text-text-secondary break-all">{message.error}</span>
              </div>
            )}
          </div>
        )}

        {/* ── Hover 动作栏 + 时间戳（固定高度，避免抖动） ── */}
        {hasCopyableText && (
          <div
            className={cn(
              'h-7 flex items-center mt-1 gap-1 select-none',
              isUser ? 'flex-row-reverse' : '-ml-1.5'
            )}
          >
            <MessageHoverActions message={message} onQuote={onQuote} onRegenerate={onRegenerate} />
            {message.createdAt && (
              <span
                className="pi-msg-time text-xs text-subtle transition-opacity duration-150"
                title={formatTimestamp(message.createdAt)}
              >
                {formatRelativeTime(message.createdAt)}
              </span>
            )}
          </div>
        )}
      </div>
    </article>
  )
}
