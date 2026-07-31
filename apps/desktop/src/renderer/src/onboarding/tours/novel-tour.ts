import type { Tour } from '../types'

function setView(view: 'home' | 'chat' | 'novel' | 'settings'): void {
  const w = window as unknown as { __onboardingSetView?: (v: string) => void }
  w.__onboardingSetView?.(view)
}

export const novelTour: Tour = {
  id: 'novel-tour',
  steps: [
    {
      element: '[data-tour="project-list"]',
      title: '项目树',
      description: '在这里创建、切换、删除小说项目。点击项目卡片即可打开。',
      side: 'right',
      view: 'novel',
    },
    {
      // 原先这里是两步（工作区模式 + 视图切换）。两个控件已合并为单一布局切换器，
      // 引导也随之收成一步。
      element: '[data-tour="layout-mode-switcher"]',
      title: '主工作区布局',
      description: '四个互斥选项：正文、正文+时间线、时间线（章节 × 实体矩阵）、关系图。也可用 Ctrl+1~4 切换。',
      side: 'bottom',
      view: 'novel',
    },
    {
      element: '[data-tour="canvas"]',
      title: '画布',
      description: '节点 = 实体（角色/冲突/伏笔等），连线 = 关系。拖拽布局，缩放查看。',
      side: 'left',
      view: 'novel',
    },
    {
      element: '[data-tour="canvas-toolbar"]',
      title: '画布工具栏',
      description: '切换布局模式、过滤关系类型、查找路径、缩放。',
      side: 'bottom',
      view: 'novel',
    },
    {
      element: '[data-tour="matrix-view"]',
      title: '矩阵视图',
      description: '实体行 × 章节列，追踪角色出场、伏笔铺设、冲突演化。',
      side: 'top',
      view: 'novel',
    },
    {
      element: '[data-tour="editor"]',
      title: '章节编辑器',
      description: 'Tiptap 富文本，上一章/下一章快速跳转。',
      side: 'right',
      view: 'novel',
    },
    {
      element: '[data-tour="reverse-arrange"]',
      title: '反推实体',
      description: '从正文自动提取角色/冲突/伏笔到矩阵，自动维护关系图。',
      side: 'top',
      view: 'novel',
    },
    {
      element: '[data-tour="right-tab-conversation"]',
      title: '右侧面板',
      description: '对话：与多 Agent 讨论剧情；详情：修改实体属性；审计：检查一致性。即将进入对话工作台 →',
      side: 'left',
      view: 'novel',
      onNext: () => {
        setView('chat')
        setTimeout(() => {
          // 延迟启动 chat-tour，等 chat 视图渲染
          // chat-tour 当前还是占位（steps: []），启动后会立即被 onboarding-provider 跳过
          import('../onboarding-store').then(({ useOnboardingStore }) => {
            useOnboardingStore.getState().startTour('chat-tour')
          })
        }, 500)
      },
    },
  ],
  onStart: () => {
    // 专注模式保护：强制退出专注模式，避免浮层遮挡
    try {
      // 动态 import 避免循环依赖
      return import('@/stores/novel-workspace-layout-store').then(({ useNovelWorkspaceLayoutStore }) => {
        if (useNovelWorkspaceLayoutStore.getState().focusMode) {
          useNovelWorkspaceLayoutStore.getState().setFocusMode(false)
        }
      })
    } catch {
      // store 未加载时忽略
      return Promise.resolve()
    }
  },
}
