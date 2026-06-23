/**
 * StreamingIndicator：系统状态提示（Craft 风格）
 *
 * 流式输出时显示在消息列表底部，展示 AI 当前执行步骤与上下文摘要。
 */
export function StreamingIndicator() {
  return (
    <div className="flex justify-start max-w-[80%]">
      <div className="bg-surface-2 rounded-lg px-4 py-3.5 space-y-1">
        <div className="flex items-center gap-2 text-sm font-medium text-text">
          <span className="size-2 rounded-full bg-primary animate-pulse" aria-hidden="true" />
          <span>正在分析你的需求 · 拆解方案 · 调取设计规范</span>
        </div>
        <p className="text-xs text-subtle">
          目标人群偏右脑思维，需要清晰分层 + 可扫读的 hero。同时考虑 OAuth 流程 SSO 入口和试用 CTA。
        </p>
      </div>
    </div>
  )
}
