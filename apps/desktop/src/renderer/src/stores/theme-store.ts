import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { Theme } from '@/types/theme'
import { BUILTIN_THEMES, DEFAULT_THEME_ID, resolveActiveTheme } from '@/utils/theme/builtin-themes'
import { applyTheme } from '@/utils/theme/apply-theme'
import { getSystemPrefersDark, watchSystemPrefersDark } from '@/utils/theme/system-appearance'

interface ThemeStoreState {
  activeThemeId: string | undefined // undefined = system
  customThemes: Theme[]
  _unwatchSystem: (() => void) | null
  setActiveTheme: (id: string | undefined) => void
  addCustomTheme: (theme: Theme) => void
  removeCustomTheme: (id: string) => void
  applyCurrentTheme: () => void
  startWatchingSystem: () => void
  stopWatchingSystem: () => void
}

export const useThemeStore = create<ThemeStoreState>()(
  persist(
    (set, get) => ({
      activeThemeId: DEFAULT_THEME_ID,
      customThemes: [],
      _unwatchSystem: null,

      setActiveTheme: (id) => {
        set({ activeThemeId: id })
        get().applyCurrentTheme()
      },

      addCustomTheme: (theme) => {
        set((state) => ({ customThemes: [...state.customThemes, theme] }))
        get().applyCurrentTheme()
      },

      removeCustomTheme: (id) => {
        set((state) => ({ customThemes: state.customThemes.filter((t) => t.id !== id) }))
      },

      applyCurrentTheme: () => {
        const { activeThemeId, customThemes } = get()
        const allThemes = [...BUILTIN_THEMES, ...customThemes]
        const theme = resolveActiveTheme(activeThemeId, allThemes, getSystemPrefersDark())
        applyTheme(theme)
      },

      startWatchingSystem: () => {
        const state = get()
        if (state._unwatchSystem) return
        const unwatch = watchSystemPrefersDark(() => {
          if (state.activeThemeId === undefined) get().applyCurrentTheme()
        })
        set({ _unwatchSystem: unwatch })
      },

      stopWatchingSystem: () => {
        const { _unwatchSystem } = get()
        if (_unwatchSystem) {
          _unwatchSystem()
          set({ _unwatchSystem: null })
        }
      },
    }),
    {
      name: 'wenlang-agent.theme-v2',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        activeThemeId: state.activeThemeId,
        customThemes: state.customThemes,
      }),
    },
  ),
)
