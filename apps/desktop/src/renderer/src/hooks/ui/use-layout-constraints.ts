import { useEffect, useState } from 'react'

export const MIN_CHAT_PANEL_PX = 320
export const MIN_PREVIEW_PANEL_PX = 200
export const MIN_WORKSPACE_PANEL_PX = 240
export const MAX_WORKSPACE_PANEL_PX = 720

interface UseLayoutConstraintsOptions {
  containerRef: React.RefObject<HTMLElement>
  workspaceWidth: number
  onWorkspaceOverflow: () => void
  chatSplitRatio: number
  onChatSplitClamp: (ratio: number) => void
}

export function useLayoutConstraints(options: UseLayoutConstraintsOptions) {
  const { containerRef, workspaceWidth, onWorkspaceOverflow, chatSplitRatio, onChatSplitClamp } = options
  const [containerWidth, setContainerWidth] = useState(0)

  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width)
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [containerRef])

  useEffect(() => {
    if (containerWidth === 0) return
    const maxAllowedWorkspace = containerWidth - MIN_CHAT_PANEL_PX - MIN_PREVIEW_PANEL_PX
    if (workspaceWidth > maxAllowedWorkspace) {
      onWorkspaceOverflow()
    }
    if (containerWidth < MIN_CHAT_PANEL_PX + MIN_PREVIEW_PANEL_PX + MIN_WORKSPACE_PANEL_PX) {
      onWorkspaceOverflow()
    }
    const minRatio = (MIN_CHAT_PANEL_PX / containerWidth) * 100
    const maxRatio = 100 - (MIN_PREVIEW_PANEL_PX / containerWidth) * 100
    if (chatSplitRatio < minRatio) onChatSplitClamp(minRatio)
    else if (chatSplitRatio > maxRatio) onChatSplitClamp(maxRatio)
  }, [containerWidth, workspaceWidth, chatSplitRatio, onWorkspaceOverflow, onChatSplitClamp])

  return { containerWidth }
}
