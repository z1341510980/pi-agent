import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  BookOpen,
  Code2,
  Eye,
  FileText,
  Plus,
  Save,
  Settings2,
  Sparkles,
  Trash2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { toastError, toastSuccess } from '@/hooks/use-toast'
import {
  getWritingStyleProfile,
  listWritingStyleExperts,
  updateWritingStyleExpert,
  deleteWritingStyleExpert,
  listWritingStyleExpertVersions,
  rollbackWritingStyleExpert,
  getWritingStylePromptPreview,
  saveWritingStyleProfile,
  type NovelWritingStyleProfileInput,
  type WritingStylePromptPreview
} from '@/api/novel-client'
import { DEFAULT_NOVEL_STYLE_EXPERTS, type NovelStyleExpert } from '@repo/shared/novel'

type EditorSection = 'settings' | 'rules' | 'experts' | 'examples' | 'preview'
type MarkdownMode = 'edit' | 'preview'
type WritingStyleProfileEditorMode = 'all' | 'baseline' | 'experts'

const DEFAULT_PROFILE: NovelWritingStyleProfileInput = {
  name: '默认文风',
  preset: 'custom',
  narrativePerson: 'third',
  narrativeDistance: 'limited',
  sentenceRhythm: 'balanced',
  dialogueRatio: 45,
  emotionalTemperature: 5,
  imageryDensity: 3,
  vocabularyRegister: 'plain',
  hardRules: ['不使用长横线破折号', '不以总结或感悟收尾', '保持 POV 信息边界'],
  softRules: ['优先用动作和感官展示情绪', '场景压力越高，句子越短'],
  positiveExamples: [],
  negativeExamples: [],
  notes: '',
  styleExperts: DEFAULT_NOVEL_STYLE_EXPERTS.map((expert) => ({ ...expert }))
}

const PRESETS: Record<string, Partial<NovelWritingStyleProfileInput>> = {
  custom: {},
  restrained: {
    name: '冷峻克制',
    sentenceRhythm: 'short',
    emotionalTemperature: 3,
    imageryDensity: 2,
    vocabularyRegister: 'plain',
    dialogueRatio: 40,
    softRules: ['少解释，多用动作和物件承载情绪', '重要情绪留白，不直接命名']
  },
  serial: {
    name: '强节奏连载',
    sentenceRhythm: 'short',
    emotionalTemperature: 7,
    imageryDensity: 2,
    vocabularyRegister: 'colloquial',
    dialogueRatio: 55,
    softRules: ['段落短，信息增量明确', '冲突场景优先动作和对话', '章尾停在行动或新信息上']
  },
  warm: {
    name: '温暖细腻',
    sentenceRhythm: 'balanced',
    emotionalTemperature: 7,
    imageryDensity: 5,
    vocabularyRegister: 'literary',
    dialogueRatio: 45,
    softRules: ['通过日常细节表现关系变化', '比喻贴近人物生活经验']
  }
}

const PERSON_LABEL: Record<NovelWritingStyleProfileInput['narrativePerson'], string> = {
  first: '第一人称',
  third: '第三人称',
  mixed: '混合人称'
}

const DISTANCE_LABEL: Record<NovelWritingStyleProfileInput['narrativeDistance'], string> = {
  intimate: '贴身视角',
  limited: '限制视角',
  omniscient: '全知视角'
}

const RHYTHM_LABEL: Record<NovelWritingStyleProfileInput['sentenceRhythm'], string> = {
  short: '短句为主',
  balanced: '长短句交替',
  long: '中长句为主'
}

function cloneProfile(profile: NovelWritingStyleProfileInput): NovelWritingStyleProfileInput {
  return {
    ...profile,
    hardRules: [...profile.hardRules],
    softRules: [...profile.softRules],
    positiveExamples: [...profile.positiveExamples],
    negativeExamples: [...(profile.negativeExamples ?? [])],
    styleExperts: (profile.styleExperts ?? DEFAULT_NOVEL_STYLE_EXPERTS).map((expert) => ({ ...expert }))
  }
}

export function rulesToMarkdown(rules: string[]): string {
  return rules.map((rule) => `- ${rule}`).join('\n')
}

export function markdownToRules(markdown: string): string[] {
  return markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('```'))
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, '')
        .replace(/^[-*+]\s+\[[ xX]\]\s+/, '')
        .replace(/^[-*+]\s+/, '')
        .replace(/^\d+[.)]\s+/, '')
        .trim()
    )
    .filter(Boolean)
}

export function withoutStyleExperts(
  profile: NovelWritingStyleProfileInput,
): NovelWritingStyleProfileInput {
  const { styleExperts: _styleExperts, ...baseline } = profile
  return baseline
}

function RangeField({
  label,
  value,
  min,
  max,
  suffix,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  suffix?: string
  onChange: (value: number) => void
}): ReactElement {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label className="text-xs text-muted-foreground">{label}</Label>
        <span className="min-w-12 text-right text-xs tabular-nums text-text">
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-6 w-full cursor-pointer accent-primary"
      />
    </div>
  )
}

function MarkdownPreview({
  value,
  emptyText = '暂无内容'
}: {
  value: string
  emptyText?: string
}): ReactElement {
  return (
    <div className="h-full min-h-[180px] overflow-auto rounded-md bg-surface-2 px-4 py-3 text-sm leading-7 text-text shadow-[inset_0_0_0_1px_var(--color-border)] [&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h1]:mb-3 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:mb-2 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_strong]:font-semibold">
      {value.trim() ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
      ) : (
        <p className="text-muted-foreground">{emptyText}</p>
      )}
    </div>
  )
}

function MarkdownField({
  label,
  value,
  onChange,
  minHeight = 220,
  placeholder
}: {
  label: string
  value: string
  onChange: (value: string) => void
  minHeight?: number
  placeholder?: string
}): ReactElement {
  const [mode, setMode] = useState<MarkdownMode>('edit')

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex min-h-9 items-center justify-between gap-3">
        <Label className="text-sm font-medium text-text">{label}</Label>
        <div
          className="inline-flex rounded-md bg-muted p-0.5"
          role="group"
          aria-label={`${label}显示模式`}
        >
          <button
            type="button"
            className={cn(
              'inline-flex h-8 items-center gap-1 rounded px-2 text-xs transition-[color,background-color,box-shadow,transform] active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
              mode === 'edit'
                ? 'bg-background text-text shadow-sm'
                : 'text-muted-foreground hover:text-text'
            )}
            onClick={() => setMode('edit')}
            aria-pressed={mode === 'edit'}
          >
            <Code2 className="size-3.5" />
            编辑
          </button>
          <button
            type="button"
            className={cn(
              'inline-flex h-8 items-center gap-1 rounded px-2 text-xs transition-[color,background-color,box-shadow,transform] active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
              mode === 'preview'
                ? 'bg-background text-text shadow-sm'
                : 'text-muted-foreground hover:text-text'
            )}
            onClick={() => setMode('preview')}
            aria-pressed={mode === 'preview'}
          >
            <Eye className="size-3.5" />
            预览
          </button>
        </div>
      </div>
      {mode === 'edit' ? (
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          aria-label={`${label} Markdown 编辑器`}
          spellCheck={false}
          className="w-full resize-y rounded-md bg-background px-3 py-3 font-mono text-[13px] leading-6 text-text shadow-[inset_0_0_0_1px_var(--color-input)] outline-none transition-[box-shadow,background-color] focus-visible:shadow-[inset_0_0_0_1px_var(--color-ring),0_0_0_3px_color-mix(in_srgb,var(--color-ring)_20%,transparent)]"
          style={{ minHeight }}
        />
      ) : (
        <div style={{ minHeight }}>
          <MarkdownPreview value={value} />
        </div>
      )}
    </div>
  )
}

export function WritingStyleProfileEditor({
  projectId,
  mode = 'all'
}: {
  projectId: string
  mode?: WritingStyleProfileEditorMode
}): ReactElement {
  const [form, setForm] = useState<NovelWritingStyleProfileInput>(() =>
    cloneProfile(DEFAULT_PROFILE)
  )
  const [savedForm, setSavedForm] = useState<NovelWritingStyleProfileInput>(() =>
    cloneProfile(DEFAULT_PROFILE)
  )
  const [hardRulesDraft, setHardRulesDraft] = useState(() =>
    rulesToMarkdown(DEFAULT_PROFILE.hardRules)
  )
  const [softRulesDraft, setSoftRulesDraft] = useState(() =>
    rulesToMarkdown(DEFAULT_PROFILE.softRules)
  )
  const [version, setVersion] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [activeSection, setActiveSection] = useState<EditorSection>(() =>
    mode === 'experts' ? 'experts' : 'settings'
  )
  const [previewTarget, setPreviewTarget] = useState<'writer' | 'reviser' | 'reviewer'>('writer')
  const [preview, setPreview] = useState<WritingStylePromptPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [experts, setExperts] = useState<NovelStyleExpert[]>([])
  const [expertDraft, setExpertDraft] = useState<NovelStyleExpert | null>(null)
  const [expertSaving, setExpertSaving] = useState(false)
  const [expertVersions, setExpertVersions] = useState<any[]>([])

  const loadExpertList = useCallback(async (): Promise<NovelStyleExpert[]> => {
    const items = await listWritingStyleExperts(projectId)
    return items.map((item) => ({ ...item, distilledPrompt: item.distilledPrompt })) as NovelStyleExpert[]
  }, [projectId])

  useEffect(() => {
    setActiveSection(mode === 'experts' ? 'experts' : 'settings')
  }, [mode])

  useEffect(() => {
    let cancelled = false
    const initial = cloneProfile(DEFAULT_PROFILE)
    setLoading(true)
    setForm(initial)
    setSavedForm(cloneProfile(initial))
    setHardRulesDraft(rulesToMarkdown(initial.hardRules))
    setSoftRulesDraft(rulesToMarkdown(initial.softRules))
    setVersion(null)
    setPreview(null)
    getWritingStyleProfile(projectId)
      .then((profile) => {
        if (cancelled || !profile) return
        const {
          id: _id,
          projectId: _projectId,
          version: profileVersion,
          createdAt: _createdAt,
          updatedAt: _updatedAt,
          ...input
        } = profile
        const loaded = cloneProfile(input)
        setForm(loaded)
        setSavedForm(cloneProfile(loaded))
        setHardRulesDraft(rulesToMarkdown(loaded.hardRules))
        setSoftRulesDraft(rulesToMarkdown(loaded.softRules))
        setVersion(profileVersion)
      })
    void loadExpertList().then((items) => {
      if (!cancelled) setExperts(items)
    }).catch(() => {
      if (!cancelled) setExperts([])
    })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [loadExpertList, projectId])

  const isDirty = useMemo(
    () =>
      JSON.stringify(form) !== JSON.stringify(savedForm) ||
      hardRulesDraft !== rulesToMarkdown(savedForm.hardRules) ||
      softRulesDraft !== rulesToMarkdown(savedForm.softRules),
    [form, hardRulesDraft, savedForm, softRulesDraft]
  )

  const restoreSavedForm = useCallback(() => {
    const restored = cloneProfile(savedForm)
    setForm(restored)
    setHardRulesDraft(rulesToMarkdown(restored.hardRules))
    setSoftRulesDraft(rulesToMarkdown(restored.softRules))
  }, [savedForm])

  const handleEditorOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !saving) restoreSavedForm()
      setEditorOpen(open)
    },
    [restoreSavedForm, saving]
  )

  const applyPreset = useCallback(
    (preset: string) => {
      const next = {
        ...form,
        ...PRESETS[preset],
        preset,
        hardRules: markdownToRules(hardRulesDraft)
      }
      setForm(next)
      setSoftRulesDraft(rulesToMarkdown(next.softRules))
    },
    [form, hardRulesDraft]
  )

  const loadPreview = useCallback(
    async (target: 'writer' | 'reviser' | 'reviewer') => {
      setPreviewTarget(target)
      setPreviewLoading(true)
      try {
        const result = await getWritingStylePromptPreview(projectId, target)
        setPreview(result)
      } catch (error) {
        toastError('预览失败', error instanceof Error ? error.message : '未知错误')
      } finally {
        setPreviewLoading(false)
      }
    },
    [projectId]
  )

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      // 统计被静默过滤的短样本（< 20 字符），保存后提示用户
      const droppedPositive = form.positiveExamples.filter(
        (e) => e.trim().length > 0 && e.trim().length < 20,
      ).length
      const droppedNegative = form.negativeExamples.filter(
        (e) => e.trim().length > 0 && e.trim().length < 20,
      ).length
      // 专家由独立 CRUD/version API 管理。基线表单持有的专家副本可能已过期，
      // 保存基线时不能把它同步回专家表并覆盖刚完成的独立编辑。
      const baselineForm = withoutStyleExperts(form)
      const input: NovelWritingStyleProfileInput = {
        ...baselineForm,
        hardRules: markdownToRules(hardRulesDraft),
        softRules: markdownToRules(softRulesDraft),
        positiveExamples: form.positiveExamples
          .map((example) => example.trim())
          .filter((example) => example.length >= 20),
        negativeExamples: form.negativeExamples
          .map((example) => example.trim())
          .filter((example) => example.length >= 20)
      }
      const saved = await saveWritingStyleProfile(projectId, input)
      const normalized = cloneProfile({ ...input, styleExperts: form.styleExperts })
      setForm(normalized)
      setSavedForm(cloneProfile(normalized))
      setHardRulesDraft(rulesToMarkdown(normalized.hardRules))
      setSoftRulesDraft(rulesToMarkdown(normalized.softRules))
      setVersion(saved.version)
      toastSuccess('文风档案已保存', `当前版本 v${saved.version}`)
      const droppedTotal = droppedPositive + droppedNegative
      if (droppedTotal > 0) {
        toastError(
          `${droppedTotal} 条样本被过滤`,
          `正反样本少于 20 字符会被丢弃（正向 ${droppedPositive} 条，反向 ${droppedNegative} 条），请补充更长的高质量样本以让 LLM 学到文风`,
        )
      }
      if (activeSection === 'preview') void loadPreview(previewTarget)
    } catch (error) {
      toastError('保存失败', error instanceof Error ? error.message : '未知错误')
    } finally {
      setSaving(false)
    }
  }, [activeSection, form, hardRulesDraft, loadPreview, previewTarget, projectId, softRulesDraft])

  const saveExpert = useCallback(async () => {
    if (!expertDraft) return
    setExpertSaving(true)
    try {
      const saved = await updateWritingStyleExpert(projectId, expertDraft.id, {
        name: expertDraft.name,
        sourceTitle: expertDraft.sourceTitle,
        sourceAuthor: expertDraft.sourceAuthor,
        description: expertDraft.description,
        customPrompt: expertDraft.customPrompt,
        enabled: expertDraft.enabled,
        sortOrder: expertDraft.sortOrder,
      })
      setExperts((current) => current.map((expert) => expert.id === saved.id ? saved as NovelStyleExpert : expert))
      setExpertDraft(null)
      toastSuccess('文风专家已保存', `当前版本 v${saved.version}`)
    } catch (error) {
      toastError('文风专家保存失败', error instanceof Error ? error.message : '未知错误')
    } finally {
      setExpertSaving(false)
    }
  }, [expertDraft, projectId])

  const loadExpertVersions = useCallback(async (expert: NovelStyleExpert) => {
    setExpertDraft({ ...expert })
    setExpertVersions(await listWritingStyleExpertVersions(projectId, expert.id))
  }, [projectId])

  const rollbackExpert = useCallback(async (version: number) => {
    if (!expertDraft) return
    try {
      const restored = await rollbackWritingStyleExpert(projectId, expertDraft.id, version)
      setExperts((current) => current.map((expert) => expert.id === restored.id ? restored as NovelStyleExpert : expert))
      setExpertDraft(restored as NovelStyleExpert)
      setExpertVersions(await listWritingStyleExpertVersions(projectId, restored.id))
      toastSuccess('文风专家已回滚', `已从 v${version} 创建新版本 v${restored.version}`)
    } catch (error) {
      toastError('文风专家回滚失败', error instanceof Error ? error.message : '未知错误')
    }
  }, [expertDraft, projectId])

  const removeExpert = useCallback(async (expert: NovelStyleExpert) => {
    try {
      await deleteWritingStyleExpert(projectId, expert.id)
      setExperts((current) => current.filter((item) => item.id !== expert.id))
      setExpertDraft(null)
    } catch (error) {
      toastError('文风专家删除失败', error instanceof Error ? error.message : '未知错误')
    }
  }, [projectId])

  const expertPanel = (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-text">独立文风专家库</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            专家来自不同小说或样本的文风蒸馏，不是岗位角色。输入框只负责本轮召集。
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => {
            setExpertDraft(null)
            void loadExpertList()
              .then(setExperts)
              .catch((error) => toastError('文风专家刷新失败', error instanceof Error ? error.message : '未知错误'))
          }}
        >
          刷新列表
        </Button>
      </div>
      <div className="space-y-2">
        {experts.map((expert) => (
          <div key={expert.id} className="flex items-start gap-3 rounded-lg border border-border p-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm text-primary">
              {expert.name.slice(0, 1)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-text">{expert.name}</span>
                <span className="text-[10px] text-muted-foreground">v{expert.version}</span>
                <span className={cn('text-[10px]', expert.enabled ? 'text-emerald-600' : 'text-muted-foreground')}>
                  {expert.enabled ? '可召集' : '已停用'}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">来源：{expert.sourceTitle}</p>
              <p className="mt-1 text-xs text-text/80">{expert.description}</p>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button type="button" size="sm" variant="outline" onClick={() => void loadExpertVersions(expert)}>
                编辑
              </Button>
              <Button type="button" size="icon-sm" variant="ghost" onClick={() => void removeExpert(expert)} title="删除专家">
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>
        ))}
        {experts.length === 0 && (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
            当前项目还没有独立文风专家。
          </p>
        )}
      </div>
      {expertDraft && (
        <section className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium text-text">编辑专家</h4>
            <span className="text-xs text-muted-foreground">蒸馏提示词不可覆盖，修改保存到 customPrompt</span>
          </div>
          <Input value={expertDraft.name} onChange={(event) => setExpertDraft({ ...expertDraft, name: event.target.value })} placeholder="专家名称" />
          <Input value={expertDraft.sourceTitle} onChange={(event) => setExpertDraft({ ...expertDraft, sourceTitle: event.target.value })} placeholder="来源小说/样本组" />
          <textarea value={expertDraft.description} onChange={(event) => setExpertDraft({ ...expertDraft, description: event.target.value })} className="min-h-16 w-full rounded-md border border-border bg-input-bg p-2 text-xs text-text" placeholder="文风能力摘要" />
          <textarea value={expertDraft.customPrompt ?? expertDraft.distilledPrompt} onChange={(event) => setExpertDraft({ ...expertDraft, customPrompt: event.target.value })} className="min-h-32 w-full rounded-md border border-border bg-input-bg p-2 text-xs text-text" placeholder="当前生效提示词" />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setExpertDraft(null)}>取消</Button>
            <Button type="button" onClick={() => void saveExpert()} disabled={expertSaving}>
              {expertSaving ? '保存中...' : '保存专家'}
            </Button>
          </div>
          {expertVersions.length > 0 && (
            <div className="border-t border-border pt-3">
              <div className="mb-2 text-xs font-medium text-text">版本历史</div>
              <div className="space-y-1">
                {expertVersions.map((item) => (
                  <div key={item.id} className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>v{item.version} · {new Date(item.createdAt).toLocaleString()}</span>
                    <span className="flex items-center gap-2">
                      {item.customPrompt ? '已自定义' : '蒸馏版本'}
                      {item.version !== expertDraft.version && (
                        <Button type="button" size="sm" variant="ghost" onClick={() => void rollbackExpert(item.version)}>
                          回滚
                        </Button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  )


  const handleSectionChange = useCallback(
    (value: string) => {
      const section = value as EditorSection
      setActiveSection(section)
      if (section === 'preview' && version && !preview && !previewLoading) {
        void loadPreview(previewTarget)
      }
    },
    [loadPreview, preview, previewLoading, previewTarget, version]
  )

  if (loading) {
    return <p className="py-3 text-xs text-muted-foreground">正在加载文风档案...</p>
  }

  const expertOnly = mode === 'experts'

  if (expertOnly) {
    return <div className="space-y-3">{expertPanel}</div>
  }

  const styleBaselineReady = Boolean(
    version && form.positiveExamples.length > 0 && form.negativeExamples.length > 0
  )

  return (
    <>
      <div className="space-y-3 border-y border-border/70 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <BookOpen className="size-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-text">
                  {expertOnly ? '独立文风专家库' : form.name}
                </span>
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-nano tabular-nums text-muted-foreground">
                  {version ? `v${version}` : '未保存'}
                </span>
                {expertOnly ? (
                  <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-nano text-primary">
                    {experts.length} 个专家
                  </span>
                ) : (
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 text-nano',
                      styleBaselineReady
                        ? 'bg-emerald-500/10 text-emerald-600'
                        : 'bg-amber-500/10 text-amber-600'
                    )}
                  >
                    {styleBaselineReady ? '质量基线已就绪' : '缺少正反样本'}
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {expertOnly
                  ? '来源小说蒸馏的可召集写作能力，独立于项目文风基线。'
                  : `${PERSON_LABEL[form.narrativePerson]} · ${DISTANCE_LABEL[form.narrativeDistance]} · ${RHYTHM_LABEL[form.sentenceRhythm]}`}
              </p>
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setActiveSection(expertOnly ? 'experts' : 'settings')
              setEditorOpen(true)
            }}
          >
            <Settings2 className="size-3.5" />
            {expertOnly ? '管理专家' : '详细编辑'}
          </Button>
        </div>

        <div className="grid grid-cols-4 divide-x divide-border/70 text-center">
          <div>
            <div className="text-xs font-medium tabular-nums text-text">{form.dialogueRatio}%</div>
            <div className="mt-0.5 text-nano text-muted-foreground">对话占比</div>
          </div>
          <div>
            <div className="text-xs font-medium tabular-nums text-text">
              {expertOnly ? experts.filter((expert) => expert.enabled).length : form.hardRules.length + form.softRules.length}
            </div>
            <div className="mt-0.5 text-nano text-muted-foreground">{expertOnly ? '可召集专家' : '文风规则'}</div>
          </div>
          <div>
            <div className="text-xs font-medium tabular-nums text-text">
              {form.positiveExamples.length}
            </div>
            <div className="mt-0.5 text-nano text-muted-foreground">正向样本</div>
          </div>
          <div>
            <div className="text-xs font-medium tabular-nums text-text">
              {form.negativeExamples.length}
            </div>
            <div className="mt-0.5 text-nano text-muted-foreground">反向样本</div>
          </div>
        </div>
      </div>

      <Dialog open={editorOpen} onOpenChange={handleEditorOpenChange}>
        <DialogContent
          showCloseButton={false}
          className="h-[min(88vh,860px)] w-[calc(100vw-2rem)] max-w-[1120px] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-[1120px]"
        >
          <DialogHeader className="border-b border-border px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Sparkles className="size-5" />
              </div>
              <div className="min-w-0">
                <DialogTitle>文风档案</DialogTitle>
                <DialogDescription className="mt-1">
                  {form.name} · {version ? `当前版本 v${version}` : '尚未保存'}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <Tabs
            value={activeSection}
            onValueChange={handleSectionChange}
            className="h-full min-h-0 flex-col gap-0 overflow-hidden"
          >
            <div className="border-b border-border px-5 py-2">
                 <TabsList className="grid h-10 w-full max-w-2xl grid-cols-5">
                <TabsTrigger value="settings">
                  <Settings2 />
                  基础设定
                </TabsTrigger>
                <TabsTrigger value="rules">
                  <FileText />
                  规则与说明
                </TabsTrigger>
                  <TabsTrigger value="examples">
                  <BookOpen />
                  文风样本
                  </TabsTrigger>
                  <TabsTrigger value="experts">
                    <Sparkles />
                    专家库
                  </TabsTrigger>
                <TabsTrigger value="preview">
                  <Eye />
                  提示词预览
                </TabsTrigger>
              </TabsList>
            </div>

             <TabsContent value="settings" className="min-h-0 overflow-y-auto px-5 py-5">
              <div className="mx-auto max-w-4xl space-y-6">
                <section className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>档案名称</Label>
                    <Input
                      value={form.name}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, name: event.target.value }))
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>风格预设</Label>
                    <Select value={form.preset} onValueChange={applyPreset}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="custom">自定义</SelectItem>
                        <SelectItem value="restrained">冷峻克制</SelectItem>
                        <SelectItem value="serial">强节奏连载</SelectItem>
                        <SelectItem value="warm">温暖细腻</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </section>

                <section className="grid gap-4 border-t border-border pt-5 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>叙事人称</Label>
                    <Select
                      value={form.narrativePerson}
                      onValueChange={(value) =>
                        setForm((current) => ({
                          ...current,
                          narrativePerson: value as NovelWritingStyleProfileInput['narrativePerson']
                        }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="first">第一人称</SelectItem>
                        <SelectItem value="third">第三人称</SelectItem>
                        <SelectItem value="mixed">混合人称</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>叙事距离</Label>
                    <Select
                      value={form.narrativeDistance}
                      onValueChange={(value) =>
                        setForm((current) => ({
                          ...current,
                          narrativeDistance:
                            value as NovelWritingStyleProfileInput['narrativeDistance']
                        }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="intimate">贴身视角</SelectItem>
                        <SelectItem value="limited">限制视角</SelectItem>
                        <SelectItem value="omniscient">全知视角</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>句式节奏</Label>
                    <Select
                      value={form.sentenceRhythm}
                      onValueChange={(value) =>
                        setForm((current) => ({
                          ...current,
                          sentenceRhythm: value as NovelWritingStyleProfileInput['sentenceRhythm']
                        }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="short">短句为主</SelectItem>
                        <SelectItem value="balanced">长短句交替</SelectItem>
                        <SelectItem value="long">中长句为主</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>语言语域</Label>
                    <Select
                      value={form.vocabularyRegister}
                      onValueChange={(value) =>
                        setForm((current) => ({
                          ...current,
                          vocabularyRegister:
                            value as NovelWritingStyleProfileInput['vocabularyRegister']
                        }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="colloquial">自然口语</SelectItem>
                        <SelectItem value="plain">平实准确</SelectItem>
                        <SelectItem value="literary">文学质感</SelectItem>
                        <SelectItem value="classical">适度古雅</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </section>

                <section className="grid gap-5 border-t border-border pt-5 md:grid-cols-3">
                  <RangeField
                    label="对话占比"
                    value={form.dialogueRatio}
                    min={10}
                    max={90}
                    suffix="%"
                    onChange={(value) =>
                      setForm((current) => ({ ...current, dialogueRatio: value }))
                    }
                  />
                  <RangeField
                    label="情感温度"
                    value={form.emotionalTemperature}
                    min={0}
                    max={10}
                    onChange={(value) =>
                      setForm((current) => ({ ...current, emotionalTemperature: value }))
                    }
                  />
                  <RangeField
                    label="意象密度"
                    value={form.imageryDensity}
                    min={0}
                    max={10}
                    onChange={(value) =>
                      setForm((current) => ({ ...current, imageryDensity: value }))
                    }
                  />
                </section>
              </div>
            </TabsContent>

            <TabsContent value="rules" className="min-h-0 overflow-y-auto px-5 py-5">
              <div className="grid gap-5 xl:grid-cols-2">
                <MarkdownField
                  label="硬约束"
                  value={hardRulesDraft}
                  onChange={setHardRulesDraft}
                  placeholder="- 不使用长横线破折号"
                />
                <MarkdownField
                  label="软偏好"
                  value={softRulesDraft}
                  onChange={setSoftRulesDraft}
                  placeholder="- 优先用动作和感官展示情绪"
                />
                <div className="xl:col-span-2">
                  <MarkdownField
                    label="补充说明"
                    value={form.notes}
                    onChange={(notes) => setForm((current) => ({ ...current, notes }))}
                    minHeight={180}
                    placeholder="## 补充说明"
                  />
                </div>
              </div>
             </TabsContent>

              <TabsContent value="experts" className="min-h-0 overflow-y-auto px-5 py-5">
                {expertPanel}
              </TabsContent>

             <TabsContent value="examples" className="min-h-0 overflow-y-auto px-5 py-5">
              <div className="mx-auto max-w-4xl space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-medium text-text">正向文风样本</h3>
                    <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                      {form.positiveExamples.length} / 5
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={form.positiveExamples.length >= 5}
                    onClick={() =>
                      setForm((current) => ({
                        ...current,
                        positiveExamples: [...current.positiveExamples, '## 文风样本\n\n']
                      }))
                    }
                  >
                    <Plus className="size-4" />
                    添加样本
                  </Button>
                </div>

                {form.positiveExamples.length === 0 ? (
                  <div className="flex min-h-48 flex-col items-center justify-center rounded-md bg-surface-2 text-center shadow-[inset_0_0_0_1px_var(--color-border)]">
                    <BookOpen className="size-7 text-muted-foreground/60" />
                    <p className="mt-3 text-sm text-muted-foreground">暂无文风样本</p>
                  </div>
                ) : (
                  form.positiveExamples.map((example, index) => (
                    <section
                      key={index}
                      className="border-t border-border pt-4 first:border-t-0 first:pt-0"
                    >
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <span className="font-mono text-xs tabular-nums text-muted-foreground">
                          样本 {index + 1}
                        </span>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          title={`删除样本 ${index + 1}`}
                          aria-label={`删除样本 ${index + 1}`}
                          onClick={() =>
                            setForm((current) => ({
                              ...current,
                              positiveExamples: current.positiveExamples.filter(
                                (_, itemIndex) => itemIndex !== index
                              )
                            }))
                          }
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                      <MarkdownField
                        label={`样本 ${index + 1} 内容`}
                        value={example}
                        onChange={(value) =>
                          setForm((current) => ({
                            ...current,
                            positiveExamples: current.positiveExamples.map((item, itemIndex) =>
                              itemIndex === index ? value : item
                            )
                          }))
                        }
                        minHeight={260}
                      />
                    </section>
                  ))
                )}

                <div className="mt-8 flex items-center justify-between gap-3 border-t border-border pt-5">
                  <div>
                    <h3 className="text-sm font-medium text-text">反向文风样本</h3>
                    <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                      用于标记不希望模型模仿的句式和段落节奏，{form.negativeExamples.length} / 5
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={form.negativeExamples.length >= 5}
                    onClick={() =>
                      setForm((current) => ({
                        ...current,
                        negativeExamples: [...current.negativeExamples, '## 不希望出现的写法\n\n']
                      }))
                    }
                  >
                    <Plus className="size-4" />
                    添加反例
                  </Button>
                </div>

                {form.negativeExamples.map((example, index) => (
                  <section key={`negative-${index}`} className="border-t border-border pt-4">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <span className="font-mono text-xs tabular-nums text-muted-foreground">
                        反例 {index + 1}
                      </span>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        title={`删除反例 ${index + 1}`}
                        aria-label={`删除反例 ${index + 1}`}
                        onClick={() =>
                          setForm((current) => ({
                            ...current,
                            negativeExamples: current.negativeExamples.filter(
                              (_, itemIndex) => itemIndex !== index
                            )
                          }))
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                    <MarkdownField
                      label={`反例 ${index + 1} 内容`}
                      value={example}
                      onChange={(value) =>
                        setForm((current) => ({
                          ...current,
                          negativeExamples: current.negativeExamples.map((item, itemIndex) =>
                            itemIndex === index ? value : item
                          )
                        }))
                      }
                      minHeight={220}
                    />
                  </section>
                ))}
              </div>
            </TabsContent>

             <TabsContent value="preview" className="min-h-0 overflow-y-auto px-5 py-5">
              <div className="mx-auto max-w-4xl space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div
                    className="inline-flex rounded-md bg-muted p-0.5"
                    role="group"
                    aria-label="提示词目标 Agent"
                  >
                    {(['writer', 'reviser', 'reviewer'] as const).map((target) => (
                      <button
                        key={target}
                        type="button"
                        className={cn(
                          'h-9 rounded px-3 text-xs transition-[color,background-color,box-shadow,transform] active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                          previewTarget === target
                            ? 'bg-background text-text shadow-sm'
                            : 'text-muted-foreground hover:text-text'
                        )}
                        onClick={() => void loadPreview(target)}
                        aria-pressed={previewTarget === target}
                        disabled={!version || previewLoading}
                      >
                        {target === 'writer'
                          ? 'Writer'
                          : target === 'reviser'
                            ? 'Reviser'
                            : 'Reviewer'}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    {isDirty && <span className="text-xs text-amber-500">当前有未保存修改</span>}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void loadPreview(previewTarget)}
                      disabled={!version || previewLoading}
                    >
                      <Eye className="size-3.5" />
                      {previewLoading ? '编译中...' : '刷新预览'}
                    </Button>
                  </div>
                </div>
                <MarkdownPreview
                  value={previewLoading ? '' : (preview?.content ?? '')}
                  emptyText={
                    previewLoading
                      ? '正在编译提示词...'
                      : version
                        ? '暂无预览内容'
                        : '保存文风档案后可查看提示词'
                  }
                />
              </div>
             </TabsContent>
           </Tabs>

           <DialogFooter className="mx-0 mb-0 items-center rounded-none px-5 py-3 sm:justify-between">
            <span className={cn('text-xs', isDirty ? 'text-amber-500' : 'text-muted-foreground')}>
              {isDirty ? '有未保存修改' : version ? `已保存 v${version}` : '尚未保存'}
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => handleEditorOpenChange(false)}
                disabled={saving}
              >
                取消
              </Button>
              <Button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving || !form.name.trim() || (!isDirty && version !== null)}
              >
                <Save className="size-4" />
                {saving ? '保存中...' : '保存更改'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
