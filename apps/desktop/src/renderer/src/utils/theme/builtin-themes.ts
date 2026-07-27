import type { Theme } from '@/types/theme'
import proDarkCss from './presets/pro-dark.css?raw'
import proLightCss from './presets/pro-light.css?raw'
import focusSepiaCss from './presets/focus-sepia.css?raw'
import cyberNeonCss from './presets/cyber-neon.css?raw'

function decorative(
  id: string,
  name: string,
  appearance: Theme['appearance'],
  css: string
): Theme {
  return {
    id,
    name,
    appearance,
    css,
    builtin: true,
    created_at: 0,
    updated_at: 0,
  }
}

export const BUILTIN_THEMES: Theme[] = [
  decorative('pro-dark', '深色专业', 'dark', proDarkCss),
  decorative('pro-light', '浅色专业', 'light', proLightCss),
  decorative('focus-sepia', '护眼专注', 'light', focusSepiaCss),
  decorative('cyber-neon', '赛博霓虹', 'dark', cyberNeonCss),
]

export const DEFAULT_THEME_ID = 'pro-dark'

export function resolveActiveTheme(
  activeId: string | undefined,
  themes: Theme[],
  prefersDark: boolean
): Theme {
  if (!activeId || activeId === 'system') {
    // system 模式：根据 prefersDark 选 pro-dark / pro-light
    const id = prefersDark ? 'pro-dark' : 'pro-light'
    return themes.find(t => t.id === id) ?? BUILTIN_THEMES[0]
  }
  return themes.find(t => t.id === activeId) ?? BUILTIN_THEMES[0]
}
