/**
 * SettingsPanel：项目级配置视图（从 NovelDetailPanel 拆出）
 *
 * 职责单一：仅承载项目级配置（标题/大纲/创作主模型/节奏模型/目标平台）。
 * 实体详情（角色/冲突/伏笔/线索等）走 DetailPanel；Provider/Key 等全局设置
 * 仍在 settings/provider-manager 页面，不重复在右栏。
 */
import { useMemo, useState, type ReactElement } from 'react'
import { useNovelDataStore } from '@/stores/novel-data-store'
import { ConversationEmptyState } from '@/components/shared/conversation'
import { ProjectForm } from './detail-forms/project-form'
import { PromptTemplatesPanel } from './prompt-templates-panel'
import { PanelShell } from './panel-shell'
import { cn } from '@/lib/utils'

type SettingsTab = 'project' | 'prompts'

export function SettingsPanel(): ReactElement {
  const currentProjectId = useNovelDataStore((s) => s.currentProjectId)
  const projects = useNovelDataStore((s) => s.projects)
  const [tab, setTab] = useState<SettingsTab>('project')

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
    <PanelShell bodyClassName="px-3 py-2 flex flex-col min-h-0">
      <div className="flex items-center gap-1 pb-2 border-b border-border/60 mb-1">
        {(
          [
            ['project', '项目设置'],
            ['prompts', '提示词模板'],
          ] as Array<[SettingsTab, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={cn(
              'px-2 py-1 rounded-md text-xs transition-colors',
              tab === value ? 'bg-primary/[0.08] text-primary font-medium' : 'text-muted-foreground hover:bg-muted hover:text-text',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'project' ? (
        <div className="overflow-y-auto">
          <ProjectForm entity={project} />
        </div>
      ) : (
        <PromptTemplatesPanel />
      )}
    </PanelShell>
  )
}
