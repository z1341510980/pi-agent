import type { ReactNode } from 'react'

export interface CanvasExtensionDefinition {
  type: string
  title: string
  icon: ReactNode
  description: string
  defaultSize: { width: number; height: number }
  defaultMetadata: Record<string, unknown>
  minimapColor: string
  transparentBackground?: boolean
  hidePanel?: boolean
  hasSourceHandle?: boolean
}

/**
 * 参考项目随仓库提供的几个 canvas plugin 节点。
 * 它们在桌面端作为受信任内置扩展注册，不执行远程源码。
 */
export const CANVAS_EXTENSION_DEFINITIONS: CanvasExtensionDefinition[] = [
  {
    type: 'sticky-note:note',
    title: '便利贴',
    icon: '📌',
    description: '彩色便利贴，双击编辑',
    defaultSize: { width: 240, height: 200 },
    defaultMetadata: { content: '', pluginColor: '#fde68a' },
    minimapColor: '#f59e0b',
    hidePanel: true
  },
  {
    type: 'markdown:doc',
    title: 'Markdown',
    icon: '📝',
    description: '编辑与渲染 Markdown',
    defaultSize: { width: 360, height: 300 },
    defaultMetadata: { content: '', editing: false },
    minimapColor: '#6366f1',
    hidePanel: true
  },
  {
    type: 'svg:vector',
    title: 'SVG',
    icon: '🔷',
    description: '编辑与预览 SVG 矢量图',
    defaultSize: { width: 320, height: 320 },
    defaultMetadata: { content: '', editing: false },
    minimapColor: '#14b8a6',
    transparentBackground: true,
    hidePanel: true
  },
  {
    type: 'html:render',
    title: 'HTML',
    icon: '🌐',
    description: '沙箱预览 HTML，支持 {{input}}',
    defaultSize: { width: 420, height: 320 },
    defaultMetadata: { content: '', editing: false },
    minimapColor: '#ec4899',
    hidePanel: true
  },
  {
    type: 'panorama:viewer',
    title: '全景图',
    icon: '🌐',
    description: '沉浸式横向全景图预览',
    defaultSize: { width: 480, height: 300 },
    defaultMetadata: { content: '', panoramaOffset: 50 },
    minimapColor: '#0ea5e9',
    transparentBackground: true,
    hidePanel: true
  }
]

const definitionsByType = new Map(
  CANVAS_EXTENSION_DEFINITIONS.map((definition) => [definition.type, definition])
)

export function getCanvasExtensionDefinition(type: string): CanvasExtensionDefinition | undefined {
  return definitionsByType.get(type)
}

export function listCanvasExtensionDefinitions(): CanvasExtensionDefinition[] {
  return [...CANVAS_EXTENSION_DEFINITIONS]
}

export function isCanvasExtensionType(type: string): boolean {
  return definitionsByType.has(type)
}

export function getCanvasNodeMinimapColor(type: string, fallback: string): string {
  return definitionsByType.get(type)?.minimapColor ?? fallback
}
