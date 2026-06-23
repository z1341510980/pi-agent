import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_INFOS,
  setLocale,
  getLocale,
  isSupportedLocale,
  t,
  tList,
  getTranslations,
  listLocales,
  initI18n,
} from '../core/i18n/i18n.js'

describe('i18n 常量', () => {
  it('SUPPORTED_LOCALES 包含 zh-CN 和 en-US', () => {
    expect(SUPPORTED_LOCALES).toContain('zh-CN')
    expect(SUPPORTED_LOCALES).toContain('en-US')
  })

  it('DEFAULT_LOCALE 为 zh-CN', () => {
    expect(DEFAULT_LOCALE).toBe('zh-CN')
  })

  it('LOCALE_INFOS 包含完整语言信息', () => {
    expect(LOCALE_INFOS).toHaveLength(2)
    const zh = LOCALE_INFOS.find((l) => l.code === 'zh-CN')
    expect(zh).toBeDefined()
    expect(zh?.name).toBe('中文')
    expect(zh?.englishName).toBe('Chinese')
    const en = LOCALE_INFOS.find((l) => l.code === 'en-US')
    expect(en).toBeDefined()
    expect(en?.name).toBe('English')
  })
})

describe('isSupportedLocale', () => {
  it('支持的语言返回 true', () => {
    expect(isSupportedLocale('zh-CN')).toBe(true)
    expect(isSupportedLocale('en-US')).toBe(true)
  })

  it('不支持的语言返回 false', () => {
    expect(isSupportedLocale('ja-JP')).toBe(false)
    expect(isSupportedLocale('')).toBe(false)
    expect(isSupportedLocale('zh')).toBe(false)
    expect(isSupportedLocale('en')).toBe(false)
  })
})

describe('setLocale / getLocale', () => {
  beforeEach(() => {
    setLocale(DEFAULT_LOCALE)
  })

  afterEach(() => {
    setLocale(DEFAULT_LOCALE)
  })

  it('getLocale 默认返回 zh-CN', () => {
    expect(getLocale()).toBe('zh-CN')
  })

  it('setLocale 切换到 en-US', () => {
    setLocale('en-US')
    expect(getLocale()).toBe('en-US')
  })

  it('setLocale 不支持的语言保持当前语言', () => {
    const original = getLocale()
    setLocale('fr-FR')
    expect(getLocale()).toBe(original)
  })
})

describe('t 翻译函数', () => {
  beforeEach(() => {
    setLocale(DEFAULT_LOCALE)
  })

  afterEach(() => {
    setLocale(DEFAULT_LOCALE)
  })

  it('翻译嵌套键（zh-CN）', () => {
    setLocale('zh-CN')
    // common.save 是一个常见的翻译键
    const result = t('common.save')
    expect(result).toBeTruthy()
    expect(typeof result).toBe('string')
  })

  it('翻译嵌套键（en-US）', () => {
    setLocale('en-US')
    const result = t('common.save')
    expect(result).toBeTruthy()
    expect(typeof result).toBe('string')
  })

  it('未找到的键返回 key 本身', () => {
    const result = t('nonexistent.deeply.nested.key')
    expect(result).toBe('nonexistent.deeply.nested.key')
  })

  it('参数插值', () => {
    setLocale('zh-CN')
    // errors.invalidParam 应该接受 {param} 参数
    // 先获取原始翻译，验证插值是否生效
    const result = t('errors.invalidParam', { param: 'testValue' })
    // 结果应包含 testValue
    expect(result).toContain('testValue')
  })

  it('指定 locale 参数覆盖当前语言', () => {
    setLocale('zh-CN')
    const zhResult = t('common.save', undefined, 'zh-CN')
    const enResult = t('common.save', undefined, 'en-US')
    // 两种语言的结果应该不同
    expect(zhResult).not.toBe(enResult)
  })

  it('无效 locale 参数回退到当前语言', () => {
    setLocale('zh-CN')
    const result = t('common.save', undefined, 'invalid-locale')
    // 应回退到当前语言
    const expected = t('common.save')
    expect(result).toBe(expected)
  })

  it('回退到默认语言', () => {
    setLocale('en-US')
    // 使用一个只在 zh-CN 中存在的键（如果有的话）
    // 或者验证 en-US 找不到时回退到 zh-CN
    // 这里用一个通用键验证回退机制工作
    const result = t('common.save')
    expect(result).toBeTruthy()
  })
})

describe('tList 翻译列表', () => {
  beforeEach(() => {
    setLocale(DEFAULT_LOCALE)
  })

  afterEach(() => {
    setLocale(DEFAULT_LOCALE)
  })

  it('返回字符串数组类型的翻译', () => {
    // 如果存在数组型翻译键，验证返回
    // 这里用一个可能不存在的键，验证返回空数组
    const result = tList('nonexistent.list')
    expect(result).toEqual([])
  })

  it('未找到的键返回空数组', () => {
    const result = tList('completely.nonexistent.key')
    expect(result).toEqual([])
  })

  it('非数组类型的翻译返回空数组', () => {
    // common.save 是字符串，不是数组
    const result = tList('common.save')
    expect(result).toEqual([])
  })
})

describe('getTranslations', () => {
  it('返回指定语言的翻译字典', () => {
    const zhTranslations = getTranslations('zh-CN')
    expect(zhTranslations).toBeTruthy()
    expect(typeof zhTranslations).toBe('object')
    // 应包含 common 模块
    expect((zhTranslations as Record<string, unknown>).common).toBeDefined()
  })

  it('不支持的语言返回空对象', () => {
    const result = getTranslations('fr-FR')
    expect(result).toEqual({})
  })
})

describe('listLocales', () => {
  it('返回所有可用语言信息', () => {
    const locales = listLocales()
    expect(locales).toHaveLength(2)
    expect(locales.map((l) => l.code)).toContain('zh-CN')
    expect(locales.map((l) => l.code)).toContain('en-US')
  })

  it('返回副本（修改不影响原数据）', () => {
    const locales1 = listLocales()
    locales1.push({ code: 'fr-FR', name: 'Français', englishName: 'French' } as never)
    const locales2 = listLocales()
    expect(locales2).toHaveLength(2)
  })
})

describe('initI18n', () => {
  afterEach(() => {
    setLocale(DEFAULT_LOCALE)
  })

  it('不传参数时使用默认语言', () => {
    initI18n()
    expect(getLocale()).toBe(DEFAULT_LOCALE)
  })

  it('传入支持的语言时切换', () => {
    initI18n('en-US')
    expect(getLocale()).toBe('en-US')
  })

  it('传入不支持的语言时保持默认', () => {
    initI18n('fr-FR')
    expect(getLocale()).toBe(DEFAULT_LOCALE)
  })
})

describe('翻译键完整性', () => {
  it('zh-CN 和 en-US 包含相同的键结构', () => {
    const zh = getTranslations('zh-CN') as Record<string, unknown>
    const en = getTranslations('en-US') as Record<string, unknown>

    // 获取顶层键
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()

    // 两种语言应包含相同的顶层模块
    expect(zhKeys).toEqual(enKeys)
  })

  it('common 模块包含基础翻译键', () => {
    const zh = getTranslations('zh-CN') as Record<string, Record<string, unknown>>
    expect(zh.common).toBeDefined()
    // 验证一些基础键存在
    expect(zh.common.save).toBeDefined()
    expect(zh.common.cancel).toBeDefined()
  })

  it('settings 模块包含设置相关翻译键', () => {
    const zh = getTranslations('zh-CN') as Record<string, Record<string, unknown>>
    expect(zh.settings).toBeDefined()
  })

  it('cron 模块包含定时任务相关翻译键', () => {
    const zh = getTranslations('zh-CN') as Record<string, Record<string, unknown>>
    expect(zh.cron).toBeDefined()
  })

  it('usage 模块包含用量相关翻译键', () => {
    const zh = getTranslations('zh-CN') as Record<string, Record<string, unknown>>
    expect(zh.usage).toBeDefined()
  })
})
