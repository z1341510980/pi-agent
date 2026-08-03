import { useCallback, useMemo, useState, type ReactElement } from 'react'
import { Flame, GitBranch, Info, Target, Users } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useNovelDataStore } from '@/stores/novel-data-store'
import {
  updateConflict,
  type ClimaxType,
  type ConflictPlotFunction,
  type ConflictProgressionMode,
  type ConflictStage,
  type ConflictTier,
  type ConflictType,
  type NovelConflict,
} from '@/api/novel-client'
import {
  CLIMAX_TYPE_OPTIONS,
  CONFLICT_PLOT_FUNCTION_OPTIONS,
  CONFLICT_PROGRESSION_MODE_OPTIONS,
  CONFLICT_STAGE_OPTIONS,
  CONFLICT_TIER_OPTIONS,
  CONFLICT_TYPE_OPTIONS,
  CHARACTER_PLOT_ROLE_OPTIONS,
  FieldRow,
  FormSection,
  safeParseParticipants,
  SaveButton,
  ScaleSlider,
  TextArea,
  TextInput,
} from './shared'
import { EntityPicker } from './entity-picker'

// ── 冲突编辑表单 ──

export function ConflictForm({ entity }: { entity: NovelConflict }): ReactElement {
  const upsertConflict = useNovelDataStore((s) => s.upsertConflict)
  const characters = useNovelDataStore((s) => s.characters)
  const [form, setForm] = useState({
    description: entity.description,
    type: entity.type,
    intensity: String(entity.intensity),
    stage: entity.stage,
    tier: entity.tier,
    climaxChapter: entity.climaxChapter != null ? String(entity.climaxChapter) : '',
    climaxType: entity.climaxType ?? '',
    stakes: entity.stakes ?? '',
    twistPotential: entity.twistPotential != null ? String(entity.twistPotential) : '',
    // ── P2-1：功能位 + 推进模式 + 参与者（可编辑）──
    plotFunction: entity.plotFunction ?? '',
    progressionMode: entity.progressionMode ?? '',
    participantsList: safeParseParticipants(entity.participants),
    // ── 071：推进粒度（可编辑，让用户能手动修正 LLM 写入的 currentStep/nextStep）──
    currentStep: entity.currentStep ?? '',
    nextStep: entity.nextStep ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * 参与者候选：本项目全部角色。
   *
   * ⚠️ `participants` 存的是**角色 ID** —— `matrix-model` 用
   * `characterNameById.get(characterId)` 反查显示名，后端 `chapter-finalizer`
   * 也按 `parseIdList` 处理。此前这里用手输文本列表，用户输入的名字永远
   * 匹配不上任何 ID，矩阵里只会显示原始字符串、Agent 拿不到真实关联。
   */
  const characterOptions = useMemo(
    () =>
      characters.map((c) => ({
        id: c.id,
        label: c.name,
        hint: CHARACTER_PLOT_ROLE_OPTIONS.find((o) => o.value === c.plotRole)?.label,
      })),
    [characters],
  )

  const dirty =
    form.description !== entity.description ||
    form.type !== entity.type ||
    form.stage !== entity.stage ||
    form.tier !== entity.tier ||
    Number(form.intensity) !== entity.intensity ||
    (form.climaxChapter || '') !== (entity.climaxChapter != null ? String(entity.climaxChapter) : '') ||
    (form.climaxType || '') !== (entity.climaxType ?? '') ||
    form.stakes !== (entity.stakes ?? '') ||
    (form.twistPotential || '') !== (entity.twistPotential != null ? String(entity.twistPotential) : '') ||
    (form.plotFunction || '') !== (entity.plotFunction ?? '') ||
    (form.progressionMode || '') !== (entity.progressionMode ?? '') ||
    (form.currentStep || '') !== (entity.currentStep ?? '') ||
    (form.nextStep || '') !== (entity.nextStep ?? '') ||
    form.participantsList.join('\n') !== safeParseParticipants(entity.participants).join('\n')

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const climaxChapterNum = form.climaxChapter.trim() === '' ? null : Number(form.climaxChapter)
      const twistPotentialNum = form.twistPotential.trim() === '' ? undefined : Number(form.twistPotential)
      const updated = await updateConflict(entity.id, {
        description: form.description,
        type: form.type,
        intensity: Number(form.intensity) || 0,
        stage: form.stage,
        tier: form.tier,
        climaxChapter: climaxChapterNum,
        climaxType: form.climaxType === '' ? null : (form.climaxType as ClimaxType),
        stakes: form.stakes === '' ? null : form.stakes,
        twistPotential: twistPotentialNum,
        // ── P2-1：提交新增三字段 ──
        plotFunction: form.plotFunction === '' ? undefined : (form.plotFunction as ConflictPlotFunction),
        progressionMode: form.progressionMode === '' ? undefined : (form.progressionMode as ConflictProgressionMode),
        // ── 071：推进粒度（空串表示清空，避免 stale nextStep 残留）──
        currentStep: form.currentStep,
        nextStep: form.nextStep,
        participants: form.participantsList.filter((s) => s.trim()),
      })
      upsertConflict(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [entity.id, form, upsertConflict])

  return (
    <div className="space-y-2.5">
      <FormSection title="基本信息" icon={<Info className="size-3.5" />} collapsible={false}>
        <FieldRow label="描述">
          <TextArea variant="medium" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
        </FieldRow>
        {/* 三个枚举横排：它们都是短选项，纵向排会让这一段占掉半屏 */}
        <div className="grid grid-cols-2 gap-2.5">
          <FieldRow label="类型">
            <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v as ConflictType }))}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONFLICT_TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label="层级">
            <Select value={form.tier} onValueChange={(v) => setForm((f) => ({ ...f, tier: v as ConflictTier }))}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONFLICT_TIER_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
        </div>
      </FormSection>

      <FormSection
        title="参与方"
        hint={form.participantsList.length > 0 ? `${form.participantsList.length} 人` : undefined}
        icon={<Users className="size-3.5" />}
        collapsible={false}
      >
        <FieldRow label="参与角色" hint="从角色库选择">
          <EntityPicker
            options={characterOptions}
            value={form.participantsList}
            onChange={(next) => setForm((f) => ({ ...f, participantsList: next }))}
            placeholder="选择参与此冲突的角色"
            searchPlaceholder="搜索角色…"
            emptyHint="本项目还没有角色，请先在左侧新建"
          />
        </FieldRow>
      </FormSection>

      <FormSection title="推进状态" icon={<GitBranch className="size-3.5" />}>
        <div className="grid grid-cols-2 gap-2.5">
          <FieldRow label="阶段">
            <Select value={form.stage} onValueChange={(v) => setForm((f) => ({ ...f, stage: v as ConflictStage }))}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONFLICT_STAGE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label="推进模式">
            <Select value={form.progressionMode || '__none__'} onValueChange={(v) => setForm((f) => ({ ...f, progressionMode: v === '__none__' ? '' : v }))}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="未指定" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">未指定</SelectItem>
                {CONFLICT_PROGRESSION_MODE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
        </div>
        <FieldRow label="强度">
          <ScaleSlider
            value={form.intensity}
            onChange={(v) => setForm((f) => ({ ...f, intensity: v }))}
            endLabels={['平缓', '激烈']}
          />
        </FieldRow>
        {/* 071：推进粒度（细于 stage，承载"已出现图案"vs"已验证图案"这类推进点）*/}
        <FieldRow label="当前进展" hint="比阶段更细的推进点">
          <TextArea
            variant="short"
            value={form.currentStep}
            onChange={(e) => setForm((f) => ({ ...f, currentStep: e.target.value }))}
            placeholder="如「已出现穴位图案」「已验证穴位为真」"
          />
        </FieldRow>
        <FieldRow label="下一步">
          <TextArea
            variant="short"
            value={form.nextStep}
            onChange={(e) => setForm((f) => ({ ...f, nextStep: e.target.value }))}
            placeholder="如「验证图案含义」「寻找下一处穴位」"
          />
        </FieldRow>
      </FormSection>

      <FormSection title="高潮与突转" icon={<Flame className="size-3.5" />} defaultCollapsed>
        <div className="grid grid-cols-2 gap-2.5">
          <FieldRow label="爆发章节">
            <TextInput
              type="number"
              min={1}
              value={form.climaxChapter}
              onChange={(e) => setForm((f) => ({ ...f, climaxChapter: e.target.value }))}
              placeholder="未指定"
            />
          </FieldRow>
          <FieldRow label="高潮类型">
            <Select value={form.climaxType || '__none__'} onValueChange={(v) => setForm((f) => ({ ...f, climaxType: v === '__none__' ? '' : v }))}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="未指定" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">未指定</SelectItem>
                {CLIMAX_TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
        </div>
        <FieldRow label="赌注 / 代价">
          <TextArea variant="short" value={form.stakes} onChange={(e) => setForm((f) => ({ ...f, stakes: e.target.value }))} placeholder="冲突失败或成功后的代价" />
        </FieldRow>
        <FieldRow label="突转潜力">
          <ScaleSlider
            value={form.twistPotential}
            onChange={(v) => setForm((f) => ({ ...f, twistPotential: v }))}
            endLabels={['走向明确', '随时反转']}
          />
        </FieldRow>
      </FormSection>

      <FormSection title="叙事功能" icon={<Target className="size-3.5" />} defaultCollapsed>
        <FieldRow label="功能位" hint="此冲突在全书结构中的作用">
          <Select value={form.plotFunction || '__none__'} onValueChange={(v) => setForm((f) => ({ ...f, plotFunction: v === '__none__' ? '' : v }))}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="未指定" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">未指定</SelectItem>
              {CONFLICT_PLOT_FUNCTION_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldRow>
      </FormSection>

      {error && <p className="text-xs text-destructive">{error}</p>}
      <SaveButton onSave={handleSave} disabled={!dirty} saving={saving} />
    </div>
  )
}
