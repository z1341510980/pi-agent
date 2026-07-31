import type { ReactElement } from 'react'
import { PlugIcon } from 'lucide-react'
import { ProviderManager } from './provider-manager'
import { SettingsPageHeader } from './setting-primitives'

/**
 * ProviderSettings —— AionUi 风格的 Provider/Model 配置入口
 *
 * 作为现有 ProviderManager 的薄包装层，在其上方添加统一的页面头部
 * （eyebrow + 标题 + 描述）。ProviderManager 本身负责：
 *   - 列表展示 Provider（名称、API Key 脱敏、Base URL、模型列表）
 *   - 新增/编辑/删除 Provider
 *   - API Key 输入框（password + 显示/隐藏）
 *   - 通过后端 API 持久化（POST/PUT/DELETE /api/providers）
 *
 * 任务约束：localStorage('pi-agent.providers-config') 作为离线缓存层，
 * 由 ProviderManager 内部在加载/保存时维护；本组件仅负责布局与文案。
 */
export function ProviderSettings(): ReactElement {
  return (
    <section className="grid gap-5 p-6" aria-label="模型与 Provider">
      <SettingsPageHeader
        eyebrow="Providers"
        title="模型与 Provider"
        description="管理 LLM Provider 与模型清单。支持 OpenAI、Anthropic 及任意 OpenAI 兼容服务。API Key 经加密后存于后端，前端仅做脱敏展示。"
      />

      {/* 顶部图标条：与 AionUi 设置页一致的"分组前导图标"风格 */}
      <div className="flex items-center gap-2 text-muted-foreground">
        <PlugIcon className="size-4" />
        <span className="text-xs font-medium">已配置的 Provider 列表</span>
      </div>

      <ProviderManager />
    </section>
  )
}
