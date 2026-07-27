import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useThemeStore } from '@/stores/theme-store'
import { BUILTIN_THEMES } from '@/utils/theme/builtin-themes'

interface ThemeProviderProps {
  children: ReactNode
  defaultTheme?: 'dark' | 'light' | 'system'
}

/**
 * 兼容旧 API：把 'dark' | 'light' | 'system' 映射到 theme store
 * - 'dark' → activeThemeId = 'pro-dark'
 * - 'light' → activeThemeId = 'pro-light'
 * - 'system' → activeThemeId = undefined
 */
const LEGACY_THEME_MAP: Record<'dark' | 'light' | 'system', string | undefined> = {
  dark: 'pro-dark',
  light: 'pro-light',
  system: undefined,
}

export function ThemeProvider({ children, defaultTheme = 'system' }: ThemeProviderProps) {
  const setActiveTheme = useThemeStore((s) => s.setActiveTheme)
  const applyCurrentTheme = useThemeStore((s) => s.applyCurrentTheme)
  const startWatchingSystem = useThemeStore((s) => s.startWatchingSystem)
  const stopWatchingSystem = useThemeStore((s) => s.stopWatchingSystem)
  const activeThemeId = useThemeStore((s) => s.activeThemeId)

  // 首次挂载：迁移旧主题 + 应用 + 启动系统监听
  useEffect(() => {
    const stored = localStorage.getItem('wenlang-agent.theme') // 旧 key
    if (stored && !localStorage.getItem('wenlang-agent.theme-v2')) {
      const legacy = stored.replace(/^"|"$/g, '') as 'dark' | 'light' | 'system'
      setActiveTheme(
        LEGACY_THEME_MAP[legacy] ??
          (defaultTheme === 'system' ? undefined : LEGACY_THEME_MAP[defaultTheme]),
      )
    } else if (activeThemeId === undefined && !localStorage.getItem('wenlang-agent.theme-v2')) {
      setActiveTheme(LEGACY_THEME_MAP[defaultTheme])
    }
    applyCurrentTheme()
    startWatchingSystem()
    return () => stopWatchingSystem()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <>{children}</>
}

export function useTheme() {
  const activeThemeId = useThemeStore((s) => s.activeThemeId)
  const setActiveTheme = useThemeStore((s) => s.setActiveTheme)
  const customThemes = useThemeStore((s) => s.customThemes)
  const allThemes = [...BUILTIN_THEMES, ...customThemes]
  const active = allThemes.find((t) => t.id === activeThemeId)

  // 兼容旧 API
  const theme: 'dark' | 'light' | 'system' =
    activeThemeId === undefined ? 'system' : active?.appearance ?? 'dark'

  return {
    theme,
    setTheme: (t: 'dark' | 'light' | 'system') => setActiveTheme(LEGACY_THEME_MAP[t]),
    // 新 API
    activeThemeId,
    activeTheme: active,
    allThemes,
    setActiveThemeId: setActiveTheme,
  }
}
