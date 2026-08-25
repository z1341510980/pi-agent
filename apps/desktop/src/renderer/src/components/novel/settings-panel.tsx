import { useMemo, type ReactElement } from 'react'
import { useNovelDataStore } from '@/stores/novel-data-store'
import { ConversationEmptyState } from '@/components/shared/conversation'
import { ProjectForm } from './detail-forms/project-form'
import { PanelShell } from './panel-shell'

export function SettingsPanel(): ReactElement {
  const currentProjectId = useNovelDataStore((s) => s.currentProjectId)
  const projects = useNovelDataStore((s) => s.projects)

  const project = useMemo(
    () => (currentProjectId ? projects.find((p) => p.id === currentProjectId) : undefined),
    [projects, currentProjectId],
  )

  if (!project) {
    return (
      <ConversationEmptyState
        variant="chat"
        title="项目设置"
        hint="请先创建或选择一个项目"
      />
    )
  }

  return (
    <PanelShell bodyClassName="px-3 py-2 overflow-y-auto">
      <ProjectForm entity={project} />
    </PanelShell>
  )
}
