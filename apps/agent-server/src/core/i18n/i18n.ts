/**
 * i18n 管理器
 *
 * 支持嵌套对象结构的翻译键（如 "common.save"、"settings.title"），
 * 支持参数插值（如 "Hello {name}"）、列表翻译和多语言切换。
 *
 * 默认语言为 zh-CN，语言文件位于 ./locales/*.json。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOCALES_DIR = join(__dirname, 'locales')

/** 支持的语言列表 */
export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]

/** 默认语言 */
export const DEFAULT_LOCALE: Locale = 'zh-CN'

export interface LocaleInfo {
  code: Locale
  name: string
  englishName: string
}

/** 可用语言信息（供 API 返回） */
export const LOCALE_INFOS: LocaleInfo[] = [
  { code: 'zh-CN', name: '中文', englishName: 'Chinese' },
  { code: 'en-US', name: 'English', englishName: 'English' },
]

/** 翻译字典类型（嵌套对象） */
type TranslationDict = Record<string, unknown>

/** 已加载的翻译数据 */
const translations = new Map<Locale, TranslationDict>()

/** 当前语言 */
let currentLocale: Locale = DEFAULT_LOCALE

/**
 * 从文件加载指定语言的翻译
 * 加载失败时静默处理，避免影响进程启动
 */
function loadLocale(locale: Locale): TranslationDict {
  const cached = translations.get(locale)
  if (cached) return cached

  try {
    const filePath = join(LOCALES_DIR, `${locale}.json`)
    const content = readFileSync(filePath, 'utf8')
    const data = JSON.parse(content) as TranslationDict
    translations.set(locale, data)
    return data
  } catch (err) {
    console.error(`[i18n] 加载语言 ${locale} 失败:`, err)
    // 加载失败时使用空字典，t() 会回退到默认语言或返回 key
    translations.set(locale, {})
    return {}
  }
}

/**
 * 在嵌套字典中按点分路径查找值
 * @returns 找到的值；未找到返回 undefined
 */
function lookupPath(dict: TranslationDict, key: string): unknown {
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

/**
 * 替换字符串中的 {param} 占位符
 */
function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value !== undefined ? String(value) : match
  })
}

/**
 * 设置当前语言
 */
export function setLocale(locale: string): void {
  if (isSupportedLocale(locale)) {
    currentLocale = locale
    // 预加载该语言
    loadLocale(currentLocale)
  } else {
    console.warn(`[i18n] 不支持的语言: ${locale}，保留当前语言 ${currentLocale}`)
  }
}

/**
 * 获取当前语言
 */
export function getLocale(): Locale {
  return currentLocale
}

/**
 * 判断是否为支持的语言
 */
export function isSupportedLocale(locale: string): locale is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(locale)
}

/**
 * 翻译文本
 * @param key 点分路径键，如 "common.save"
 * @param params 插值参数，如 { name: "world" }
 * @param locale 指定语言（默认使用当前语言）
 * @returns 翻译后的字符串；未找到时回退到默认语言，仍找不到时返回 key
 */
export function t(
  key: string,
  params?: Record<string, string | number>,
  locale?: string,
): string {
  const targetLocale = (locale && isSupportedLocale(locale) ? locale : currentLocale) as Locale

  // 优先从目标语言查找
  const dict = loadLocale(targetLocale)
  let value = lookupPath(dict, key)

  // 回退到默认语言
  if (value === undefined && targetLocale !== DEFAULT_LOCALE) {
    const defaultDict = loadLocale(DEFAULT_LOCALE)
    value = lookupPath(defaultDict, key)
  }

  if (typeof value === 'string') {
    return interpolate(value, params)
  }

  // 找不到翻译时返回 key
  return key
}

/**
 * 翻译列表（用于数组型翻译）
 * @returns 字符串数组；未找到时返回空数组
 */
export function tList(key: string, locale?: string): string[] {
  const targetLocale = (locale && isSupportedLocale(locale) ? locale : currentLocale) as Locale

  const dict = loadLocale(targetLocale)
  let value = lookupPath(dict, key)

  if (value === undefined && targetLocale !== DEFAULT_LOCALE) {
    const defaultDict = loadLocale(DEFAULT_LOCALE)
    value = lookupPath(defaultDict, key)
  }

  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return value
  }

  return []
}

/**
 * 获取指定语言的完整翻译字典（供 API 返回给前端）
 */
export function getTranslations(locale: string): TranslationDict {
  if (!isSupportedLocale(locale)) {
    return {}
  }
  return loadLocale(locale)
}

/**
 * 列出所有可用语言信息
 */
export function listLocales(): LocaleInfo[] {
  return [...LOCALE_INFOS]
}

/**
 * 初始化 i18n（预加载默认语言）
 */
export function initI18n(locale?: string): void {
  if (locale && isSupportedLocale(locale)) {
    currentLocale = locale
  }
  loadLocale(currentLocale)
  // 预加载默认语言作为回退
  if (currentLocale !== DEFAULT_LOCALE) {
    loadLocale(DEFAULT_LOCALE)
  }
}

// 模块加载时预加载默认语言
loadLocale(DEFAULT_LOCALE)
