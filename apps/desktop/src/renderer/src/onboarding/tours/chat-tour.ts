import type { Tour } from '../types'

function setView(view: 'home' | 'chat' | 'novel' | 'settings'): void {
  const w = window as unknown as { __onboardingSetView?: (v: string) => void }
  w.__onboardingSetView?.(view)
}

/**
 * 对话工作台引导：7 步
 *
 * 1. 会话列表 → 新建/切换/删除对话
 * 2. 消息流 → 工具调用折叠成卡片
 * 3. 输入卡片 → Enter 发送 / Shift+Enter 换行 / @ 引用 / / 斜杠指令
 * 4. 模型选择器 → 选择当前会话使用的 LLM
 * 5. 权限模式 → Auto/Plan/Read-only/Full 四种
 * 6. 右侧上下文面板 → token / 文件 / 记忆 / 日志
 * 7. 状态栏 → 在线/延迟/模型/权限 → 切到设置页
 *
 * 最后一步 onNext：setView('settings') + startTour('settings-tour')
 */
export const chatTour: Tour = {
  id: 'chat-tour',
  steps: [
    {
      element: '[data-tour="session-list"]',
      title: '会话列表',
      description: '新建、切换、删除对话会话。右上角可重命名 / 删除。',
      side: 'right',
      view: 'chat',
    },
    {
      element: '[aria-label="消息流"]',
      title: '消息流',
      description: '对话流，工具调用会折叠成卡片，点击展开查看详情。',
      side: 'right',
      view: 'chat',
    },
    {
      element: '[data-tour="input-card"]',
      title: '输入区',
      description: 'Enter 发送，Shift+Enter 换行。@ 引用会话，/ 触发斜杠指令，可拖拽 / 粘贴图片。',
      side: 'top',
      view: 'chat',
    },
    {
      element: '[data-tour="model-selector"]',
      title: '模型选择器',
      description: '选择当前会话使用的 LLM 模型，按 Provider 分组。',
      side: 'top',
      view: 'chat',
    },
    {
      element: '[data-tour="permission-switch"]',
      title: '权限模式',
      description: 'Auto / Plan / Read-only / Full 四种权限模式，控制 Agent 的写操作与 shell 执行。',
      side: 'top',
      view: 'chat',
    },
    {
      element: '[aria-label="上下文状态"]',
      title: '右侧上下文面板',
      description: '展示 token 占用、关联文件、记忆摘要与活动日志。',
      side: 'left',
      view: 'chat',
    },
    {
      element: '[data-tour="status-bar"]',
      title: '状态栏',
      description: '在线状态、延迟、当前模型与权限模式。即将进入设置页 →',
      side: 'top',
      view: 'chat',
      onNext: () => {
        setView('settings')
        setTimeout(() => {
          // 延迟启动 settings-tour，等 settings 视图渲染
          // settings-tour 当前还是占位（steps: []），启动后会立即被 onboarding-provider 跳过
          import('../onboarding-store').then(({ useOnboardingStore }) => {
            useOnboardingStore.getState().startTour('settings-tour')
          })
        }, 500)
      },
    },
  ],
}
