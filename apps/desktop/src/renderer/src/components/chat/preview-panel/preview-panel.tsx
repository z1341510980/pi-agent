import { useState, useCallback } from 'react'
import { PreviewTabs } from './preview-tabs'
import { MarkdownViewer } from './viewers/markdown-viewer'
import { CodeViewer } from './viewers/code-viewer'
import { ImageViewer } from './viewers/image-viewer'
import { UrlViewer } from './viewers/url-viewer'

export type PreviewContentType = 'markdown' | 'code' | 'image' | 'url'

export interface PreviewTab {
  id: string
  title: string
  contentType: PreviewContentType
  data: string
  language?: string
  closable?: boolean
}

export interface PreviewPanelProps {
  tabs: PreviewTab[]
  activeTabId?: string
  onTabClose?: (id: string) => void
  onTabActivate?: (id: string) => void
  emptyHint?: string
}

export function PreviewPanel(props: PreviewPanelProps) {
  const { tabs, activeTabId, onTabClose, onTabActivate, emptyHint = '无预览内容' } = props
  const [internalActive, setInternalActive] = useState<string | undefined>(activeTabId ?? tabs[0]?.id)

  const activeId = activeTabId ?? internalActive ?? tabs[0]?.id
  const activeTab = tabs.find(t => t.id === activeId)

  const handleActivate = useCallback((id: string) => {
    setInternalActive(id)
    onTabActivate?.(id)
  }, [onTabActivate])

  if (tabs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {emptyHint}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <PreviewTabs
        tabs={tabs}
        activeId={activeId!}
        onActivate={handleActivate}
        onClose={onTabClose}
      />
      <div className="flex-1 overflow-auto">
        {!activeTab && <div className="p-4 text-sm text-muted-foreground">{emptyHint}</div>}
        {activeTab && activeTab.contentType === 'markdown' && <MarkdownViewer content={activeTab.data} />}
        {activeTab && activeTab.contentType === 'code' && <CodeViewer code={activeTab.data} language={activeTab.language} />}
        {activeTab && activeTab.contentType === 'image' && <ImageViewer src={activeTab.data} />}
        {activeTab && activeTab.contentType === 'url' && <UrlViewer url={activeTab.data} />}
      </div>
    </div>
  )
}
