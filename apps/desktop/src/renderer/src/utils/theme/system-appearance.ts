/**
 * 系统外观（深色/浅色）监听
 * 与 AionUi systemAppearance.ts 一致，纯 DOM API
 */

export function getSystemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches ?? false
}

export function watchSystemPrefersDark(onChange: (isDark: boolean) => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const mql = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = (e: MediaQueryListEvent) => onChange(e.matches)
  mql.addEventListener('change', handler)
  return () => mql.removeEventListener('change', handler)
}
