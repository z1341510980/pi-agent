import type { Tour } from '../types'

function setView(view: 'home' | 'chat' | 'novel' | 'settings'): void {
  const w = window as unknown as { __onboardingSetView?: (v: string) => void }
  w.__onboardingSetView?.(view)
}

/**
 * 设置页引导：5 步
 *
 * 1. 设置导航概览（10 个项，重点看 4 个）
 * 2. 模型与 Provider → 配置 LLM 服务商
 * 3. 模型管理 → 查看 Provider 可用模型
 * 4. Agent 管理 → Agent 人格 + 系统提示词 + 温度
 * 5. 权限与安全 → 全局权限模式 + 工作目录白名单 → 切回 home 启动 shortcuts-tour
 *
 * 最后一步 onNext：setView('home') + startTour('shortcuts-tour')
 */
export const settingsTour: Tour = {
  id: 'settings-tour',
  steps: [
    {
      element: '[aria-label="设置导航"]',
      title: '设置导航',
      description: '共 10 项：助手、技能、模型与 Provider、模型管理、插件、Agent 管理、权限与安全、定时任务等。新手重点看 Provider / 模型 / Agent / 权限 4 个。',
      side: 'right',
      view: 'settings',
    },
    {
      element: '[data-tour="nav-providers"]',
      title: '模型与 Provider',
      description: '配置 LLM 服务商（OpenAI / Anthropic / 自建 OpenAI 兼容端点等），支持设置 BaseURL 与 API Key。',
      side: 'right',
      view: 'settings',
    },
    {
      element: '[data-tour="nav-models"]',
      title: '模型管理',
      description: '查看每个 Provider 的可用模型，包括上下文窗口与最大输出。',
      side: 'right',
      view: 'settings',
    },
    {
      element: '[data-tour="nav-agents"]',
      title: 'Agent 管理',
      description: '配置 Agent 人格：系统提示词、温度、工具权限等。',
      side: 'right',
      view: 'settings',
    },
    {
      element: '[data-tour="nav-security"]',
      title: '权限与安全',
      description: '全局权限模式 + 工作目录白名单。新手建议先选 Plan 模式 →',
      side: 'right',
      view: 'settings',
      onNext: () => {
        setView('home')
        setTimeout(() => {
          // 延迟启动 shortcuts-tour，等 home 视图渲染
          import('../onboarding-store').then(({ useOnboardingStore }) => {
            useOnboardingStore.getState().startTour('shortcuts-tour')
          })
        }, 500)
      },
    },
  ],
}
