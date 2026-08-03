import { createContext, useContext, type ReactNode, type ReactElement } from 'react'
import type { FileReference } from '@/lib/file-reference'

/**
 * 文件引用的打开入口。
 *
 * ## 为什么用 context
 *
 * 链接组件被 react-markdown 渲染在很深的位置（消息 → 分段 → markdown AST），
 * 一路透传 props 要穿过 rehype 插件边界，做不到。而这里需要的东西（工作区根路径、
 * 打开预览的动作）都在 chat-workspace 手上。
 *
 * ## 没有 Provider 时降级为纯文本
 *
 * 引用链接是增强而非必需。Provider 缺失（例如在测试或别处复用消息气泡）时
 * 渲染成 `<code>`，内容照常可读，不报错也不留空。
 */

export interface FileReferenceContextValue {
  /** 打开引用指向的文件（由 chat-workspace 实现：解析相对路径 + 读文件 + 开预览） */
  openFile: (ref: FileReference) => void
}

const FileReferenceContext = createContext<FileReferenceContextValue | null>(null)

export function FileReferenceProvider({
  value,
  children,
}: {
  value: FileReferenceContextValue
  children: ReactNode
}): ReactElement {
  return <FileReferenceContext value={value}>{children}</FileReferenceContext>
}

export function useFileReference(): FileReferenceContextValue | null {
  return useContext(FileReferenceContext)
}
