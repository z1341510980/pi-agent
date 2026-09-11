import type { Tour } from '../types'

/** 等待画布工作区挂载出第一个锚点（项目异步加载，rail 入口切视图后立即启动）。 */
async function waitForCanvasAnchors(): Promise<void> {
  const selector = '[data-tour="canvas-tool-select"]'
  for (let waited = 0; waited < 5000; waited += 150) {
    if (document.querySelector(selector)) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

/**
 * 无限画布引导：8 步
 *
 * 1. 画布概览（居中） → 双击创建 / 框选 / 缩放
 * 2. 工具切换 → 选择 / 平移 / 空格临时反转
 * 3. 创建节点 → 文本 / 图片 / 视频 / 音频 / 配置 / 分组 / 扩展节点
 * 4. 设计画板（居中） → 尺寸预设 + 全屏编辑器 + 导出回画布
 * 5. 导入媒体 → 本地图片 / 视频 / 音频
 * 6. 媒体生成配置 → 设置 → 插件设置 → 媒体生成
 * 7. 批量下载（居中） → 多选后功能栏打包 ZIP
 * 8. 视图控制 → 小地图 / 适配 / 缩放
 */
export const canvasTour: Tour = {
  id: 'canvas-tour',
  async onStart() {
    await waitForCanvasAnchors()
  },
  steps: [
    {
      title: '无限画布',
      description:
        '在这里组织提示词、图片素材与生成结果。双击空白创建节点，拖拽空白框选，Ctrl+滚轮缩放画布。',
    },
    {
      element: '[data-tour="canvas-tool-select"]',
      title: '工具切换',
      description:
        '选择工具用于点选 / 框选 / 移动节点，平移工具拖动整张画布；按住空格或 Ctrl 可临时反转当前工具。',
      side: 'top',
    },
    {
      element: '[data-tour="canvas-node-text"]',
      title: '创建节点',
      description:
        '文本、图片、视频、音频、生成配置与分组从这里创建；「扩展节点」里还有便利贴、Markdown、SVG 等。双击空白也能快速创建。',
      side: 'top',
    },
    {
      title: '设计画板',
      description:
        '在节点创建菜单选「设计画板」→ 挑一个尺寸预设（小红书 / 抖音 / 海报等）进入全屏设计编辑器：图层管理、形状 / 文本 / 图片、吸附对齐；导出 PNG/JPG 会自动生成图片节点接回工作流。',
    },
    {
      element: '[data-tour="canvas-upload"]',
      title: '导入媒体',
      description: '把本地图片 / 视频 / 音频导入画布，作为生成参考图或素材。',
      side: 'top',
    },
    {
      element: '[data-tour="canvas-media-settings"]',
      title: '媒体生成配置',
      description:
        '图片 / 音频 / 视频生成的 API Provider 统一在 设置 → 插件设置 → 媒体生成 中管理，点这里直达。',
      side: 'top',
    },
    {
      title: '批量下载',
      description:
        '框选多个节点后，底部功能栏会出现「批量下载选中」：图片、视频、文本、配置一键打包成 ZIP，单个失败不阻断其余文件。',
    },
    {
      element: '[data-tour="canvas-zoom"]',
      title: '视图控制',
      description: '左下角小地图、重置视图与缩放滑杆；Ctrl+滚轮随时缩放。引导完成，开始创作吧！',
      side: 'top',
    },
  ],
}
