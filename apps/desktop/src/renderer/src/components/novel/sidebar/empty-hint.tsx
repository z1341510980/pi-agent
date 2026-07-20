import { type ReactElement } from 'react'

// ── 空提示 ──

export function EmptyHint({ text }: { text: string }): ReactElement {
  return <div className="text-[10px] text-muted-foreground/70 px-1.5 py-1">{text}</div>
}
