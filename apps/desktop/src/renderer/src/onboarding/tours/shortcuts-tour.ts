import type { Tour } from '../types'

/**
 * 快捷键教学引导：8 步
 *
 * 设计决策：全部使用居中 popover（element 留空），不绑定具体 DOM 元素。
 * 快捷键是全局概念，无需依赖特定 view 渲染。无论从哪个 view 启动都能正常工作。
 *
 * 每步通过 shortcut 字段注入 <kbd> 元素展示快捷键。
 *
 * 数据来源：use-shortcut.ts（全局 12 个）+ use-novel-workspace-shortcuts.ts（小说专属 7 个）。
 *
 * 最后一步 onNext：completeTour 写入 completedVersion，回到 home view（若不在）。
 */
export const shortcutsTour: Tour = {
  id: 'shortcuts-tour',
  steps: [
    {
      title: '命令面板',
      description: '打开命令面板，快速跳转任何功能、查找会话、执行指令。',
      shortcut: 'Ctrl+K',
      side: 'over',
    },
    {
      title: '新建会话',
      description: '在对话工作台新建一个空白会话。',
      shortcut: 'Ctrl+N',
      side: 'over',
    },
    {
      title: '打开设置',
      description: '一键跳转到设置页（Provider / 模型 / Agent / 权限）。',
      shortcut: 'Ctrl+,',
      side: 'over',
    },
    {
      title: '切换 DevLog',
      description: '切换底部开发日志面板，查看 Agent 工具调用与事件流。',
      shortcut: 'Ctrl+D',
      side: 'over',
    },
    {
      title: '对话栏切换',
      description: '切换左侧会话列表 / 右侧上下文面板。',
      shortcut: 'Ctrl+\\ / Ctrl+Shift+\\',
      side: 'over',
    },
    {
      title: '会话跳转',
      description: '在最近会话间快速切换（上一会话 / 下一会话）。',
      shortcut: 'Ctrl+[ / Ctrl+]',
      side: 'over',
    },
    {
      title: '小说工作区模式',
      description: '切换小说工作区的写作 / 矩阵 / 分屏三种模式，以及专注模式。',
      shortcut: 'Ctrl+1/2/3 / Ctrl+Shift+F',
      side: 'over',
    },
    {
      title: '小说侧栏切换',
      description: '切换小说工作区的左栏（项目树）/ 右栏（对话/详情/审计）。完成全部引导 ✓',
      shortcut: 'Ctrl+B / Ctrl+J',
      side: 'over',
      onNext: () => {
        // 完成全部引导：写入 completedVersion
        import('../onboarding-store').then(({ useOnboardingStore }) => {
          useOnboardingStore.getState().completeTour()
          // 若当前不在 home，回到 home view 作为收尾
          const w = window as unknown as { __onboardingSetView?: (v: string) => void }
          w.__onboardingSetView?.('home')
        })
      },
    },
  ],
}
