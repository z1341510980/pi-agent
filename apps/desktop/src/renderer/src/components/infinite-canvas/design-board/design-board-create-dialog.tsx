import { useState, type ReactElement } from 'react'
import { useCanvasTheme } from '../canvas-theme'
import { Button } from '@/components/ui/button'
import {
  DEFAULT_DESIGN_BOARD_PRESET_ID,
  DESIGN_BOARD_PRESETS,
  findDesignBoardPreset
} from './design-board-presets'

export interface DesignBoardCreateResult {
  width: number
  height: number
}

const CUSTOM_PRESET_ID = 'custom'

/** 预设选择对话框：选中尺寸后回调，由工作区创建 design-board 节点。 */
export function DesignBoardCreateDialog({
  onConfirm,
  onCancel
}: {
  onConfirm: (result: DesignBoardCreateResult) => void
  onCancel: () => void
}): ReactElement {
  const theme = useCanvasTheme()
  const [presetId, setPresetId] = useState(DEFAULT_DESIGN_BOARD_PRESET_ID)
  const [customWidth, setCustomWidth] = useState('1080')
  const [customHeight, setCustomHeight] = useState('1440')
  const isCustom = presetId === CUSTOM_PRESET_ID
  const preset = findDesignBoardPreset(presetId)
  const confirm = (): void => {
    if (isCustom) {
      onConfirm({ width: clampSize(customWidth, 1080), height: clampSize(customHeight, 1440) })
      return
    }
    onConfirm({ width: preset?.width ?? 1080, height: preset?.height ?? 1440 })
  }
  return (
    <div className="fixed inset-0 z-[200] grid place-items-center bg-black/40" data-canvas-no-zoom>
      <div
        className="w-[420px] rounded-xl border p-4 shadow-2xl"
        style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }}
      >
        <p className="mb-3 text-base font-semibold" style={{ color: theme.node.text }}>
          画板尺寸
        </p>
        <div className="thin-scrollbar mb-3 max-h-64 overflow-y-auto">
          {DESIGN_BOARD_PRESETS.map((item) => (
            <label
              key={item.id}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm"
              style={{ color: theme.node.text }}
            >
              <input
                type="radio"
                name="design-board-preset"
                checked={presetId === item.id}
                onChange={() => setPresetId(item.id)}
                className="accent-current"
              />
              <span className="flex-1">{item.label}</span>
              <span className="text-xs opacity-55">
                {item.width}×{item.height}
              </span>
            </label>
          ))}
          <label
            className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm"
            style={{ color: theme.node.text }}
          >
            <input
              type="radio"
              name="design-board-preset"
              checked={isCustom}
              onChange={() => setPresetId(CUSTOM_PRESET_ID)}
              className="accent-current"
            />
            <span className="flex-1">自定义</span>
          </label>
        </div>
        {isCustom && (
          <div className="mb-3 flex items-center gap-2 text-sm" style={{ color: theme.node.text }}>
            <input
              aria-label="宽"
              value={customWidth}
              onChange={(event) => setCustomWidth(event.target.value)}
              className="w-24 rounded-md border px-2 py-1 outline-none"
              style={{
                borderColor: theme.toolbar.border,
                background: 'transparent',
                color: theme.node.text
              }}
            />
            ×
            <input
              aria-label="高"
              value={customHeight}
              onChange={(event) => setCustomHeight(event.target.value)}
              className="w-24 rounded-md border px-2 py-1 outline-none"
              style={{
                borderColor: theme.toolbar.border,
                background: 'transparent',
                color: theme.node.text
              }}
            />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button onClick={confirm}>创建画板</Button>
        </div>
      </div>
    </div>
  )
}

function clampSize(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(100, Math.min(16000, parsed))
}
