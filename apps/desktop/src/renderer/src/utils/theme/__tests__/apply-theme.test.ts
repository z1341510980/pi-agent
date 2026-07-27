import { describe, it, expect, beforeEach } from 'vitest'
import { applyTheme } from '../apply-theme'
import type { Theme } from '@/types/theme'

describe('apply-theme', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark')
    document.documentElement.removeAttribute('data-theme')
    document.getElementById('theme-tokens')?.remove()
    document.getElementById('theme-decoration')?.remove()
  })

  it('dark 主题加 .dark class + data-theme=dark', () => {
    applyTheme({ id: 'test', name: 'Test', appearance: 'dark', builtin: true, created_at: 0, updated_at: 0 } satisfies Theme)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('light 主题不加 .dark class', () => {
    applyTheme({ id: 'test', name: 'Test', appearance: 'light', builtin: true, created_at: 0, updated_at: 0 })
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('tokens 写入 <style id="theme-tokens">', () => {
    applyTheme({
      id: 'test', name: 'Test', appearance: 'dark', builtin: true, created_at: 0, updated_at: 0,
      tokens: { '--color-primary': '#ff0000' }
    })
    const el = document.getElementById('theme-tokens')
    expect(el?.textContent).toContain('--color-primary: #ff0000')
  })

  it('css 经 processCustomCss 处理后写入 theme-decoration', () => {
    applyTheme({
      id: 'test', name: 'Test', appearance: 'dark', builtin: true, created_at: 0, updated_at: 0,
      css: 'a { color: red; }'
    })
    const el = document.getElementById('theme-decoration')
    expect(el?.textContent).toContain('!important')
    expect(el?.textContent).toContain('用户自定义样式')
  })

  it('css 为空时不创建 theme-decoration', () => {
    applyTheme({ id: 'test', name: 'Test', appearance: 'dark', builtin: true, created_at: 0, updated_at: 0 })
    expect(document.getElementById('theme-decoration')).toBeNull()
  })

  it('system 主题通过 getSystemPrefersDark 解析（matchMedia 未定义时不抛错）', () => {
    // 临时移除 matchMedia 模拟 SSR/jsdom 默认环境
    const original = (window as unknown as { matchMedia?: unknown }).matchMedia
    delete (window as unknown as { matchMedia?: unknown }).matchMedia
    try {
      // 应该不抛错，回退为 light（getSystemPrefersDark 返回 false）
      applyTheme({ id: 'test', name: 'Test', appearance: 'system', builtin: true, created_at: 0, updated_at: 0 } satisfies Theme)
      // matchMedia 未定义时 getSystemPrefersDark 返回 false → appearance='light' → 不加 .dark
      expect(document.documentElement.classList.contains('dark')).toBe(false)
      expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    } finally {
      // 恢复 matchMedia（避免污染后续测试）
      if (original) (window as unknown as { matchMedia?: unknown }).matchMedia = original
    }
  })
})
