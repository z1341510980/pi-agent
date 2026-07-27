interface ToolCallFieldProps {
  label: 'Input' | 'Output'
  value: unknown
  /** 超过此长度截断并附加 "... (截断)"，避免长 JSON 撑爆卡片 */
  maxLength?: number
  /** 内容区最大高度（px），超出滚动 */
  maxHeight?: number
}

/**
 * ToolCallField：工具调用参数/结果的结构化字段渲染（Stage 2 Task 2.3）
 *
 * 参考 AionUi `MessageToolCall`：用 label + `<pre><code>` 替代裸 `<pre>`，
 * 让字段边界更清晰。视觉走 Stage 1 引入的语义 token。
 */
export function ToolCallField({
  label,
  value,
  maxLength = 500,
  maxHeight = 160
}: ToolCallFieldProps) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  const displayText = raw.length > maxLength ? raw.slice(0, maxLength) + '\n... (截断)' : raw

  return (
    <div className="mt-1.5">
      <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--t-tertiary)]">
        {label}
      </div>
      <pre
        className="overflow-auto rounded bg-[var(--bg-2)] p-2 text-[11px] leading-relaxed text-[var(--t-secondary)]"
        style={{ maxHeight }}
      >
        <code>{displayText}</code>
      </pre>
    </div>
  )
}
