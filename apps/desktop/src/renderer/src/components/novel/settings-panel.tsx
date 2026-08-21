/**
 * SettingsPanel：项目级配置视图（从 NovelDetailPanel 拆出）
 *
 * 职责单一：仅承载项目级配置（标题/大纲/创作主模型/节奏模型/目标平台）。
 * 实体详情（角色/冲突/伏笔/线索等）走 DetailPanel；Provider/Key 等全局设置
 * 仍在 settings/provider-manager 页面，不重复在右栏。
 */
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
        title="项目级配置"
        hint="请先在左侧选择一个项目"
      />
    )
  }

  return (
    <PanelShell bodyClassName="px-3 py-2">
      <ProjectForm entity={project} />
    </PanelShell>
  )
}
