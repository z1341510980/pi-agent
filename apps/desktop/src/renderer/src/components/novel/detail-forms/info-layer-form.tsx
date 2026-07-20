import { useCallback, useState, type ReactElement } from 'react'
import { Badge } from '@/components/ui/badge'
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
  SaveButton,
  SectionHeader,
  TextArea,
  TextInput,
} from './shared'

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

  // 解析 linkedForeshadows JSON，映射为带描述的展示项
  let linkedForeshadowIds: string[] = []
  try {
    const arr = JSON.parse(entity.linkedForeshadows)
    if (Array.isArray(arr)) linkedForeshadowIds = arr.filter((x): x is string => typeof x === 'string')
  } catch {
    // ignore
  }
  const linkedForeshadowItems = linkedForeshadowIds.map((id) => {
    const f = foreshadows.find((x) => x.id === id)
    return {
      id,
      description: f?.description ?? id,
      status: f?.status ?? '',
    }
  })

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
    <div className="space-y-2">
      <SectionHeader title="基本信息" />
      <FieldRow label="信息描述">
        <TextArea variant="medium" value={form.infoDescription} onChange={(e) => setForm((f) => ({ ...f, infoDescription: e.target.value }))} placeholder="例如：林墨的真实身世是前朝皇族后裔" />
      </FieldRow>

      <SectionHeader title="认知状态" hint="作者与读者对这条信息的掌握程度" />
      <FieldRow label="作者是否知晓">
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
      <FieldRow label="读者是否知晓">
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

      <SectionHeader title="揭示" hint="信息差何时、以何种方式向读者揭示" />
      <FieldRow label="揭示阶段">
        <TextInput
          value={form.revealStage}
          onChange={(e) => setForm((f) => ({ ...f, revealStage: e.target.value }))}
          placeholder="如：setup / rising / climax，留空表示未指定"
        />
      </FieldRow>
      <FieldRow label="揭示章节">
        <TextInput
          type="number"
          min={1}
          value={form.revealChapter}
          onChange={(e) => setForm((f) => ({ ...f, revealChapter: e.target.value }))}
          placeholder="留空表示未指定"
        />
      </FieldRow>
      <FieldRow label="是否已揭示">
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

      <SectionHeader title="关联伏笔" hint="此信息差承载的伏笔列表（双向关联，由伏笔侧或矩阵视图管理）" />
      <FieldRow label="⚡ 承载伏笔">
        {linkedForeshadowItems.length > 0 ? (
          <div className="space-y-1">
            {linkedForeshadowItems.map((item) => {
              const desc = item.description.length > 16 ? `${item.description.slice(0, 16)}...` : item.description
              return (
                <div key={item.id} className="flex items-center gap-1.5">
                  <Badge variant="outline" className="text-[10px]">{desc}</Badge>
                  <span className="text-[10px] text-muted-foreground">
                    {item.status || '未设定'}
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          <span className="text-[11px] text-muted-foreground">暂无</span>
        )}
      </FieldRow>

      {error && <p className="text-xs text-destructive">{error}</p>}
      <SaveButton onSave={handleSave} disabled={!dirty} saving={saving} />
    </div>
  )
}
