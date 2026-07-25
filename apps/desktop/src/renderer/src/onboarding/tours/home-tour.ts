import type { Tour } from '../types'

function setView(view: 'home' | 'chat' | 'novel' | 'settings'): void {
  const w = window as unknown as { __onboardingSetView?: (v: string) => void }
  w.__onboardingSetView?.(view)
}

/**
 * 首页引导：5 步
 *
 * 1. 欢迎卡片（居中，无 element）
 * 2. 三大入口概览
 * 3. 对话工作台入口
 * 4. 小说创作入口
 * 5. 设置入口 → 最后一步 onNext：setView('novel') + startTour('novel-tour')
 */
export const homeTour: Tour = {
  id: 'home-tour',
  steps: [
    {
      // 居中 popover：不绑定 DOM
      title: '欢迎使用 PI Agent',
      description:
        '5 分钟带你熟悉四大模块：对话、小说创作、设置与快捷键。准备好就点「下一步」。',
      side: 'over',
      view: 'home',
    },
    {
      element: '[data-tour="home-entries"]',
      title: '三大入口',
      description: '从这里开始：对话工作台 / 小说创作 / 设置。',
      side: 'bottom',
      view: 'home',
    },
    {
      element: '[data-tour="entry-chat"]',
      title: '对话工作台',
      description: '与 Agent 进行多轮对话，处理编码、分析、写作等任务。',
      side: 'bottom',
      view: 'home',
    },
    {
      element: '[data-tour="entry-novel"]',
      title: '小说创作',
      description: '多 Agent 协作的长篇小说创作工作台：画布 / 矩阵 / 章节编辑器三视图联动。',
      side: 'bottom',
      view: 'home',
    },
    {
      element: '[data-tour="entry-settings"]',
      title: '设置',
      description: '配置模型供应商、Agent 人格、权限与安全。即将进入小说工作台 →',
      side: 'bottom',
      view: 'home',
      onNext: () => {
        setView('novel')
        setTimeout(() => {
          // 延迟启动 novel-tour，等 novel 视图渲染完成
          import('../onboarding-store').then(({ useOnboardingStore }) => {
            useOnboardingStore.getState().startTour('novel-tour')
          })
        }, 500)
      },
    },
  ],
}
