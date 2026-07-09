/**
 * 前端 i18n 系统
 *
 * 提供 useTranslation hook，支持嵌套键查找、参数插值和多语言切换。
 * 语言偏好持久化到 localStorage，并同步到后端。
 */

import { createContext, useContext, useState, useCallback, useMemo, useEffect, type ReactNode } from 'react'
import zhCN from './locales/zh-CN.json'
import enUS from './locales/en-US.json'

/** 支持的语言 */
export type Locale = 'zh-CN' | 'en-US'

/** 默认语言 */
export const DEFAULT_LOCALE: Locale = 'zh-CN'

/** 语言信息 */
export interface LocaleInfo {
  code: Locale
  label: string
}

/** 可用语言列表 */
export const LOCALES: LocaleInfo[] = [
  { code: 'zh-CN', label: '中文' },
  { code: 'en-US', label: 'English' },
]

/** 翻译字典 */
const translations: Record<Locale, Record<string, unknown>> = {
  'zh-CN': zhCN,
  'en-US': enUS,
}

/** localStorage 存储 key */
const LOCALE_STORAGE_KEY = 'wenlang-agent.locale'

/** 在嵌套字典中按点分路径查找值 */
function lookupPath(dict: Record<string, unknown>, key: string): unknown {
  const parts = key.split('.')
  let current: unknown = dict
  for (const part of parts) {
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return current
}

/** 替换字符串中的 {param} 占位符 */
function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value !== undefined ? String(value) : match
  })
}

/** 从 localStorage 加载语言偏好 */
function loadStoredLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    if (stored === 'zh-CN' || stored === 'en-US') return stored
    // 兼容旧格式 'zh' / 'en'
    if (stored === 'zh') return 'zh-CN'
    if (stored === 'en') return 'en-US'
  } catch {
    // localStorage 不可用时静默处理
  }
  return DEFAULT_LOCALE
}

/** 翻译函数类型 */
export type TranslateFn = (
  key: string,
  params?: Record<string, string | number>,
) => string

/** i18n 上下文值 */
interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: TranslateFn
}

/** i18n Context */
const I18nContext = createContext<I18nContextValue | null>(null)

/** i18n Provider 属性 */
export interface I18nProviderProps {
  children: ReactNode
}

/**
 * i18n Provider 组件
 * 包裹应用根组件，提供翻译能力
 */
export function I18nProvider({ children }: I18nProviderProps): ReactNode {
  const [locale, setLocaleState] = useState<Locale>(loadStoredLocale)

  // 持久化语言设置到 localStorage
  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale)
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, newLocale)
    } catch {
      // localStorage 不可用时静默处理
    }
    // 非阻塞同步到后端
    void syncLocaleToBackend(newLocale)
  }, [])

  // 翻译函数
  const t = useCallback<TranslateFn>(
    (key, params) => {
      const dict = translations[locale] ?? translations[DEFAULT_LOCALE]
      let value = lookupPath(dict, key)

      // 回退到默认语言
      if (value === undefined && locale !== DEFAULT_LOCALE) {
        value = lookupPath(translations[DEFAULT_LOCALE], key)
      }

      if (typeof value === 'string') {
        return interpolate(value, params)
      }

      return key
    },
    [locale],
  )

  // 首次加载时同步语言到后端
  useEffect(() => {
    void syncLocaleToBackend(locale)
    // 仅在首次挂载时执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

/**
 * useTranslation hook
 * @returns { locale, setLocale, t }
 */
export function useTranslation(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) {
    // 未被 Provider 包裹时返回默认值，避免崩溃
    return {
      locale: DEFAULT_LOCALE,
      setLocale: () => {},
      t: (key) => key,
    }
  }
  return ctx
}

/**
 * 同步语言设置到后端
 * 非阻塞，失败时静默处理
 */
async function syncLocaleToBackend(locale: Locale): Promise<void> {
  try {
    const { browserConfig } = await import('@repo/config/browser')
    await fetch(`${browserConfig.apiBaseUrl}/api/i18n/locale`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale }),
    })
  } catch {
    // 后端不可用时静默处理
  }
}
