import { useState, type ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { BeatDramaticFunction } from '@/api/novel-client'
import { BEAT_FUNCTION_LABELS } from './beat-labels'

// ── 节拍行内编辑表单（节拍表分组与大纲树章节行共用）──

export interface BeatEditFormFields {
  dramaticFunction: BeatDramaticFunction
  emotionalDebt: string
  payoff: string
  arcPosition: string
  summary: string
}

export interface BeatEditFormProps {
  initial: BeatEditFormFields
  saving: boolean
  onSave: (fields: BeatEditFormFields) => void
  onCancel: () => void
}

export function BeatEditForm({ initial, saving, onSave, onCancel }: BeatEditFormProps): ReactElement {
  const [form, setForm] = useState<BeatEditFormFields>(initial)

  return (
    <div className="mx-1 my-0.5 rounded-lg border border-border/60 p-2 space-y-1.5">
      <div className="space-y-1">
        <Label className="text-nano">戏剧功能</Label>
        <Select
          value={form.dramaticFunction}
          onValueChange={(v) => setForm((f) => (f ? { ...f, dramaticFunction: v as BeatDramaticFunction } : f))}
        >
          <SelectTrigger className="w-full h-7">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(BEAT_FUNCTION_LABELS) as BeatDramaticFunction[]).map((fn) => (
              <SelectItem key={fn} value={fn}>{BEAT_FUNCTION_LABELS[fn]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label className="text-nano">情绪债务</Label>
        <Input
          value={form.emotionalDebt}
          onChange={(e) => setForm((f) => (f ? { ...f, emotionalDebt: e.target.value } : f))}
          className="h-7 text-xs"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-nano">爽点/回报</Label>
        <Input
          value={form.payoff}
          onChange={(e) => setForm((f) => (f ? { ...f, payoff: e.target.value } : f))}
          className="h-7 text-xs"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-nano">弧光位置</Label>
        <Input
          value={form.arcPosition}
          onChange={(e) => setForm((f) => (f ? { ...f, arcPosition: e.target.value } : f))}
          className="h-7 text-xs"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-nano">核心走向</Label>
        <Input
          value={form.summary}
          onChange={(e) => setForm((f) => (f ? { ...f, summary: e.target.value } : f))}
          className="h-7 text-xs"
        />
      </div>
      <div className="flex gap-1.5 justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-nano"
          onClick={onCancel}
          disabled={saving}
        >
          取消
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-6 px-2 text-nano"
          onClick={() => onSave(form)}
          disabled={saving}
        >
          {saving ? '保存中...' : '保存'}
        </Button>
      </div>
    </div>
  )
}
