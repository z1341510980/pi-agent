// apps/desktop/src/renderer/src/types/theme.ts
export type ThemeAppearance = 'light' | 'dark' | 'system'

export interface Theme {
  id: string
  name: string
  appearance: ThemeAppearance
  tokens?: Record<string, string>   // 结构化 token（前向兼容）
  css?: string                       // escape hatch（含 :root { --xxx } 块）
  builtin: boolean
  created_at: number
  updated_at: number
}

export type FontSizeKey = 'display' | 'heading' | 'body' | 'caption' | 'micro'

export interface FontSizes extends Record<FontSizeKey, number> {}
