import type { ReactElement, ReactNode } from 'react'
import { createContext, useContext, useEffect, useState } from 'react'

// ── 类型定义 ──

type Theme = 'dark' | 'light' | 'system'

interface ThemeProviderState {
  theme: Theme
  setTheme: (theme: Theme) => void
}

// ── Context ──

const ThemeProviderContext = createContext<ThemeProviderState>({
  theme: 'system',
  setTheme: () => {},
})

const STORAGE_KEY = 'pi-agent.theme'

// ── Provider ──

interface ThemeProviderProps {
  children: ReactNode
  defaultTheme?: Theme
}

export function ThemeProvider({
  children,
  defaultTheme = 'system',
}: ThemeProviderProps): ReactElement {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === 'undefined') return defaultTheme
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
    return defaultTheme
  })

  useEffect(() => {
    const root = document.documentElement

    root.classList.remove('light', 'dark')

    if (theme === 'system') {
      // jsdom 等测试环境可能不支持 matchMedia，回退为浅色
      const mediaQuery = typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null
      const systemDark = mediaQuery?.matches ?? false
      root.classList.add(systemDark ? 'dark' : 'light')

      if (mediaQuery) {
        const handler = (e: MediaQueryListEvent): void => {
          root.classList.remove('light', 'dark')
          root.classList.add(e.matches ? 'dark' : 'light')
        }
        mediaQuery.addEventListener('change', handler)
        return () => mediaQuery.removeEventListener('change', handler)
      }

      return undefined
    }

    root.classList.add(theme)
    return undefined
  }, [theme])

  // 持久化到 localStorage
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, theme)
  }, [theme])

  return (
    <ThemeProviderContext value={{ theme, setTheme }}>
      {children}
    </ThemeProviderContext>
  )
}

// ── Hook ──

export function useTheme(): ThemeProviderState {
  const context = useContext(ThemeProviderContext)
  if (!context) {
    throw new Error('useTheme 必须在 ThemeProvider 内使用')
  }
  return context
}
