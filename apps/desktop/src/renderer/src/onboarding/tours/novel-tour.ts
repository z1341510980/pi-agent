import type { Tour } from '../types'

function setView(view: 'home' | 'chat' | 'novel' | 'settings'): void {
  const w = window as unknown as { __onboardingSetView?: (v: string) => void }
  w.__onboardingSetView?.(view)
}

/**
 * 小说创作引导：8 步
 *
 * 1. 项目列表 → 新建/切换/删除项目、回收站
 * 2. 主工作区布局切换器 → 正文 / 正文+时间线 / 时间线 / 关系图（Ctrl+1~4）
 * 3. 关系图画布
 * 4. 画布工具栏
 * 5. 时间线矩阵
 * 6. 章节编辑器
 * 7. 反推实体
 * 8. 右侧面板（会话/详情/设置/审校/审计五个 Tab）→ 最后一步 onNext：setView('chat') + startTour('chat-tour')
 */
export const novelTour: Tour = {
  id: 'novel-tour',
  steps: [
    {
      element: '[data-tour="project-list"]',
      title: '项目列表',
      description: '在这里创建、切换、删除小说项目，点击项目即可进入。下方项目树支持章节管理，侧栏底部回收站可找回删除内容。',
      side: 'right',
      view: 'novel',
    },
    {
      // 原先这里是两步（工作区模式 + 视图切换）。两个控件已合并为单一布局切换器，
      // 引导也随之收成一步。
      element: '[data-tour="layout-mode-switcher"]',
      title: '主工作区布局',
      description: '四个互斥选项：正文、正文+时间线、时间线（章节 × 实体矩阵）、关系图。也可用 Ctrl+1~4 切换。顶栏还能选择创作模型，所有 AI 调用统一遵守。',
      side: 'bottom',
      view: 'novel',
    },
    {
      element: '[data-tour="canvas"]',
      title: '关系图画布',
      description: '节点 = 实体（角色/冲突/伏笔等），连线 = 关系。拖拽布局，双击或右键连线可删除。',
      side: 'left',
      view: 'novel',
    },
    {
      element: '[data-tour="canvas-toolbar"]',
      title: '画布工具栏',
      description: '分区 / 力导向自动布局、选择手动连线的关系类型、查找最短关系路径、高亮邻居节点。缩放按钮在画布左下角。',
      side: 'bottom',
      view: 'novel',
    },
    {
      element: '[data-tour="matrix-view"]',
      title: '时间线矩阵',
      description: '实体行 × 章节列，追踪角色出场、伏笔铺设、冲突演化。支持从侧栏拖拽实体到章节列标记出场。',
      side: 'top',
      view: 'novel',
    },
    {
      element: '[data-tour="editor"]',
      title: '章节编辑器',
      description: '富文本正文编辑，顶部章节导航可快速跳转上一章 / 下一章。',
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
      description: '五个 Tab：会话（聊天/工作流/群聊/编排统一入口）、详情（编辑实体）、设置（项目级配置）、审校（待审实体与事件）、审计（一致性诊断）。输入框 /写 N、/群聊 N 可直接启动创作。即将进入对话工作台 →',
      side: 'left',
      view: 'novel',
      onNext: () => {
        setView('chat')
        setTimeout(() => {
          // 延迟启动 chat-tour，等 chat 视图渲染
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
