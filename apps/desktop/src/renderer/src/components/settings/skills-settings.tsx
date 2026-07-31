import { useEffect, useMemo, useState, type ReactElement } from 'react'
import {
  FileTextIcon,
  TerminalIcon,
  SearchIcon,
  GlobeIcon,
  DatabaseIcon,
  CodeIcon,
  MailIcon,
  CalendarIcon,
  SparklesIcon,
  type LucideIcon,
} from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { SettingsPageHeader, SettingsCard } from './setting-primitives'

// ── 类型定义 ──

interface SkillDef {
  /** 技能唯一 id（对应后端 tool name） */
  id: string
  /** 显示名 */
  name: string
  /** 描述 */
  description: string
  /** 类别 id */
  category: SkillCategoryId
}

interface SkillCategory {
  id: SkillCategoryId
  label: string
  description?: string
  icon: LucideIcon
}

type SkillCategoryId =
  | 'file'
  | 'shell'
  | 'search'
  | 'web'
  | 'memory'
  | 'code'
  | 'communication'
  | 'schedule'
  | 'misc'

// ── 常量 ──

const STORAGE_KEY = 'pi-agent.skills-config'

const CATEGORIES: SkillCategory[] = [
  { id: 'file', label: '文件读写', description: '读写本地文件、目录管理与检索', icon: FileTextIcon },
  { id: 'shell', label: 'Bash 执行', description: '在沙箱中执行 shell 命令', icon: TerminalIcon },
  { id: 'search', label: '搜索', description: '本地与远端检索能力', icon: SearchIcon },
  { id: 'web', label: '网络访问', description: '抓取网页、调用 HTTP 接口', icon: GlobeIcon },
  { id: 'memory', label: '记忆存储', description: '长期记忆与上下文持久化', icon: DatabaseIcon },
  { id: 'code', label: '代码执行', description: '沙箱内运行代码片段', icon: CodeIcon },
  { id: 'communication', label: '通信', description: '邮件、消息、IM 通知', icon: MailIcon },
  { id: 'schedule', label: '调度', description: '定时任务与日程', icon: CalendarIcon },
  { id: 'misc', label: '其他', description: '尚未分类的辅助能力', icon: SparklesIcon },
]

/** 前端硬编码的默认技能列表 */
const DEFAULT_SKILLS: SkillDef[] = [
  { id: 'read_file', name: '读取文件', description: '读取本地文件内容（支持文本、图片、PDF）', category: 'file' },
  { id: 'write_file', name: '写入文件', description: '将内容写入本地文件，自动创建父目录', category: 'file' },
  { id: 'edit_file', name: '编辑文件', description: '对现有文件做局部替换或追加', category: 'file' },
  { id: 'list_directory', name: '列目录', description: '列出指定路径下的文件与子目录', category: 'file' },
  { id: 'bash', name: 'Bash 执行', description: '在沙箱中执行 shell 命令，受白名单与超时约束', category: 'shell' },
  { id: 'python', name: 'Python 执行', description: '在隔离环境中运行 Python 脚本', category: 'code' },
  { id: 'node', name: 'Node 执行', description: '在隔离环境中运行 Node.js 脚本', category: 'code' },
  { id: 'grep', name: 'Grep 检索', description: '在文件系统中按正则检索内容', category: 'search' },
  { id: 'glob', name: 'Glob 匹配', description: '按 glob 模式查找文件路径', category: 'search' },
  { id: 'web_search', name: '网络搜索', description: '调用搜索引擎获取实时信息', category: 'web' },
  { id: 'web_fetch', name: '网页抓取', description: '抓取并解析远程网页内容', category: 'web' },
  { id: 'http_request', name: 'HTTP 请求', description: '发起自定义 HTTP/HTTPS 请求', category: 'web' },
  { id: 'memory_save', name: '记忆保存', description: '将关键信息存入长期记忆', category: 'memory' },
  { id: 'memory_recall', name: '记忆检索', description: '从长期记忆中召回相关条目', category: 'memory' },
  { id: 'send_email', name: '发送邮件', description: '通过配置的 SMTP 发送邮件', category: 'communication' },
  { id: 'send_message', name: '发送消息', description: '向 IM/通知渠道发送消息', category: 'communication' },
  { id: 'schedule_cron', name: '定时任务', description: '注册或取消 cron 调度', category: 'schedule' },
  { id: 'todo_write', name: '待办管理', description: '维护任务列表与进度', category: 'misc' },
]

// ── 主组件 ──

export function SkillsSettings(): ReactElement {
  const [enabledMap, setEnabledMap] = useState<Record<string, boolean>>(() => loadEnabledMap())

  // 持久化启用状态
  useEffect(() => {
    saveEnabledMap(enabledMap)
  }, [enabledMap])

  // 按类别分组
  const grouped = useMemo(() => {
    const map = new Map<SkillCategoryId, SkillDef[]>()
    for (const skill of DEFAULT_SKILLS) {
      const list = map.get(skill.category) ?? []
      list.push(skill)
      map.set(skill.category, list)
    }
    return CATEGORIES.map((cat) => ({
      category: cat,
      skills: map.get(cat.id) ?? [],
    })).filter((g) => g.skills.length > 0)
  }, [])

  function handleToggle(id: string, enabled: boolean): void {
    setEnabledMap((prev) => ({ ...prev, [id]: enabled }))
  }

  function handleEnableAll(): void {
    const next: Record<string, boolean> = {}
    for (const skill of DEFAULT_SKILLS) next[skill.id] = true
    setEnabledMap(next)
  }

  function handleDisableAll(): void {
    setEnabledMap({})
  }

  const enabledCount = useMemo(() => {
    return DEFAULT_SKILLS.filter((s) => enabledMap[s.id] !== false).length
  }, [enabledMap])

  return (
    <section className="grid gap-5 p-6" aria-label="技能设置">
      <SettingsPageHeader
        eyebrow="Skills"
        title="技能"
        description={`管理 Agent 可调用的工具与技能。共 ${DEFAULT_SKILLS.length} 项，当前启用 ${enabledCount} 项。关闭后 Agent 将无法调用对应工具。`}
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleEnableAll}
              className="rounded-md px-2 py-1 text-xs text-primary transition-colors hover:bg-primary/10"
            >
              全部启用
            </button>
            <button
              type="button"
              onClick={handleDisableAll}
              className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
            >
              全部禁用
            </button>
          </div>
        }
      />

      {grouped.map(({ category, skills }) => {
        const CatIcon = category.icon
        return (
          <SettingsCard key={category.id} className="p-0">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <div className="grid size-7 place-items-center rounded-md bg-surface-3 text-muted-foreground">
                <CatIcon className="size-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="m-0 text-sm font-[760] text-text">{category.label}</h3>
                {category.description && (
                  <p className="m-0 mt-0.5 text-xs text-hint">{category.description}</p>
                )}
              </div>
              <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                {skills.filter((s) => enabledMap[s.id] !== false).length}/{skills.length}
              </Badge>
            </div>
            <ul className="divide-y divide-border" role="list">
              {skills.map((skill) => {
                const enabled = enabledMap[skill.id] !== false
                return (
                  <li
                    key={skill.id}
                    className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-surface-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-text">{skill.name}</span>
                        <code className="text-[10px] font-mono text-hint">{skill.id}</code>
                      </div>
                      <p className="m-0 mt-0.5 truncate text-xs text-hint">{skill.description}</p>
                    </div>
                    <Switch
                      checked={enabled}
                      onCheckedChange={(checked) => handleToggle(skill.id, checked)}
                      aria-label={`${enabled ? '禁用' : '启用'} ${skill.name}`}
                    />
                  </li>
                )
              })}
            </ul>
          </SettingsCard>
        )
      })}
    </section>
  )
}

// ── 工具函数 ──

function loadEnabledMap(): Record<string, boolean> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const data = JSON.parse(raw)
    if (data && typeof data === 'object') return data as Record<string, boolean>
    return {}
  } catch {
    return {}
  }
}

function saveEnabledMap(map: Record<string, boolean>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // 忽略存储失败
  }
}
