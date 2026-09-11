import type { ReactElement } from 'react'
import { Check, X } from 'lucide-react'

import type { CanvasTheme } from './canvas-theme'

export function MediaDialogShell({
  theme,
  title,
  icon,
  onClose,
  children
}: {
  theme: CanvasTheme
  title: string
  icon: ReactElement
  onClose: () => void
  children: ReactElement[] | ReactElement
}): ReactElement {
  return (
    <div
      className="fixed inset-0 z-[110] grid place-items-center bg-black/35 p-5"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border p-4 shadow-2xl"
        style={{
          background: theme.toolbar.panel,
          borderColor: theme.toolbar.border,
          color: theme.node.text
        }}
        data-canvas-no-zoom
        onClick={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            {icon}
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="grid size-7 place-items-center rounded-lg opacity-55 hover:opacity-100"
          >
            <X className="size-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function DialogAction({
  theme,
  label,
  disabled = false,
  onClick
}: {
  theme: CanvasTheme
  label: string
  disabled?: boolean
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      disabled={disabled}
      className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-xs font-medium transition disabled:pointer-events-none disabled:opacity-35"
      style={{ background: theme.toolbar.activeBg, color: theme.toolbar.activeText }}
      onClick={onClick}
    >
      <Check className="size-3.5" />
      {label}
    </button>
  )
}

export function NumberField({
  label,
  value,
  min = 0,
  max = 100,
  onChange
}: {
  label: string
  value: number
  min?: number
  max?: number
  onChange: (value: number) => void
}): ReactElement {
  return (
    <label className="block">
      {label}
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(event) =>
          onChange(Math.min(max, Math.max(min, Number(event.target.value) || 0)))
        }
        className="mt-1 h-8 w-full rounded-lg border bg-transparent px-2"
      />
    </label>
  )
}
