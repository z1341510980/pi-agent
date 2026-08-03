import { useCallback, useMemo, useState, type ReactElement } from 'react'
import { Eye, Info, Link2, Sparkles } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useNovelDataStore } from '@/stores/novel-data-store'
import {
  updateInfoLayer,
  type NovelInformationLayer,
} from '@/api/novel-client'
import {
  FieldRow,
  FormSection,
  FORESHADOW_STATUS_OPTIONS,
  SaveButton,
  TextArea,
  TextInput,
} from './shared'
import { EdgeRelationField } from './edge-relation-field'

// ── 信息差编辑表单（P3-2） ──

export function InfoLayerForm({ entity }: { entity: NovelInformationLayer }): ReactElement {
  const upsertInfoLayer = useNovelDataStore((s) => s.upsertInfoLayer)
  const foreshadows = useNovelDataStore((s) => s.foreshadows)
  const [form, setForm] = useState({
    infoDescription: entity.infoDescription,
    authorKnows: entity.authorKnows ? 'true' : 'false',
    readerKnows: entity.readerKnows ? 'true' : 'false',
    revealStage: entity.revealStage ?? '',
    revealChapter: entity.revealChapter != null ? String(entity.revealChapter) : '',
    isRevealed: entity.isRevealed ? 'true' : 'false',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * 承载伏笔的候选。
   *
   * 此前这里写死 `linkedForeshadowIds = []`（注释说"已迁移至 edges，暂用空数组占位"），
   * 于是「⚡ 承载伏笔」永远显示「暂无」—— 一个从上线起就不可能有内容的只读字段。
   * 现在改为通过 edges 真正读写。
   */
  const foreshadowOptions = useMemo(
    () =>
      foreshadows.map((f) => ({
        id: f.id,
        label: f.description.length > 30 ? `${f.description.slice(0, 30)}…` : f.description,
        hint: FORESHADOW_STATUS_OPTIONS.find((o) => o.value === f.status)?.label,
      })),
    [foreshadows],
  )

  const toStrOrNull = (v: string): string | null => (v === '' ? null : v)
  const toNumOrNull = (v: string): number | null => (v === '' ? null : Number(v))

  const dirty =
    form.infoDescription !== entity.infoDescription ||
    (form.authorKnows === 'true') !== entity.authorKnows ||
    (form.readerKnows === 'true') !== entity.readerKnows ||
    (form.revealStage || '') !== (entity.revealStage ?? '') ||
    toNumOrNull(form.revealChapter) !== entity.revealChapter ||
    (form.isRevealed === 'true') !== entity.isRevealed

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const updated = await updateInfoLayer(entity.id, {
        infoDescription: form.infoDescription,
        authorKnows: form.authorKnows === 'true',
        readerKnows: form.readerKnows === 'true',
        revealStage: toStrOrNull(form.revealStage),
        revealChapter: toNumOrNull(form.revealChapter),
        isRevealed: form.isRevealed === 'true',
      })
      upsertInfoLayer(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [entity.id, form, upsertInfoLayer])

  return (
    <div className="space-y-2.5">
      <FormSection title="基本信息" icon={<Info className="size-3.5" />} collapsible={false}>
        <FieldRow label="信息描述">
          <TextArea
            variant="medium"
            value={form.infoDescription}
            onChange={(e) => setForm((f) => ({ ...f, infoDescription: e.target.value }))}
            placeholder="例如：林墨的真实身世是前朝皇族后裔"
          />
        </FieldRow>
      </FormSection>

      <FormSection
        title="认知状态"
        hint="谁掌握了这条信息"
        icon={<Eye className="size-3.5" />}
        collapsible={false}
      >
        {/* 两个布尔并排：它们成对使用（作者知道但读者不知道 = 悬念），
            纵向排开会让这层对照关系变弱 */}
        <div className="grid grid-cols-2 gap-2.5">
          <FieldRow label="作者知晓">
            <Select value={form.authorKnows} onValueChange={(v) => setForm((f) => ({ ...f, authorKnows: v }))}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="true">是</SelectItem>
                <SelectItem value="false">否</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label="读者知晓">
            <Select value={form.readerKnows} onValueChange={(v) => setForm((f) => ({ ...f, readerKnows: v }))}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="true">是</SelectItem>
                <SelectItem value="false">否</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
        </div>
        {/* 认知组合的语义解读：这四种组合各自对应不同的叙事效果，
            但从两个「是/否」下拉里读不出来 */}
        <p className="rounded-md bg-surface-2/60 px-2.5 py-1.5 text-nano leading-relaxed text-muted-foreground">
          {form.authorKnows === 'true' && form.readerKnows === 'false'
            ? '作者知道、读者不知道 —— 悬念状态，可用于铺设伏笔'
            : form.authorKnows === 'true' && form.readerKnows === 'true'
              ? '双方都知道 —— 已公开信息，可用于制造角色间的信息差'
              : form.authorKnows === 'false'
                ? '作者尚未确定 —— 这条信息还是待设计状态'
                : '读者知道但作者未定 —— 数据异常，请检查'}
        </p>
      </FormSection>

      <FormSection title="揭示计划" hint="何时向读者交底" icon={<Sparkles className="size-3.5" />}>
        <div className="grid grid-cols-2 gap-2.5">
          <FieldRow label="揭示阶段">
            <TextInput
              value={form.revealStage}
              onChange={(e) => setForm((f) => ({ ...f, revealStage: e.target.value }))}
              placeholder="setup / rising / climax"
            />
          </FieldRow>
          <FieldRow label="揭示章节">
            <TextInput
              type="number"
              min={1}
              value={form.revealChapter}
              onChange={(e) => setForm((f) => ({ ...f, revealChapter: e.target.value }))}
              placeholder="未指定"
            />
          </FieldRow>
        </div>
        <FieldRow label="是否已揭示" hint="事实，非计划">
          <Select value={form.isRevealed} onValueChange={(v) => setForm((f) => ({ ...f, isRevealed: v }))}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="true">是</SelectItem>
              <SelectItem value="false">否</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
      </FormSection>

      <FormSection
        title="承载伏笔"
        hint="即时生效"
        icon={<Link2 className="size-3.5" />}
      >
        <FieldRow label="关联伏笔" hint="勾选即建立关联，无需保存">
          <EdgeRelationField
            entityId={entity.id}
            entityType="info_layer"
            targetType="foreshadow"
            edgeType="foreshadow"
            options={foreshadowOptions}
            placeholder="关联此信息差承载的伏笔"
            searchPlaceholder="搜索伏笔…"
            emptyHint="本项目还没有伏笔"
          />
        </FieldRow>
      </FormSection>

      {error && <p className="text-xs text-destructive">{error}</p>}
      <SaveButton onSave={handleSave} disabled={!dirty} saving={saving} />
    </div>
  )
}
