import type { Config } from 'driver.js'

/**
 * driver.js 主题配置
 * 注意：driver.js 1.8.0 的配置类型导出名为 `Config`（非 `DriverOptions`）。
 * 这里复用项目 CSS 变量（--color-* 前缀），与 TRAE Work 设计系统对齐。
 */
export const driverTheme: Partial<Config> = {
  overlayColor: 'var(--color-app-bg)',
  overlayOpacity: 0.7,
  showProgress: true,
  progressText: '{{current}} / {{total}}',
  nextBtnText: '下一步 →',
  prevBtnText: '← 上一步',
  doneBtnText: '完成 ✓',
  allowClose: true,
  smoothScroll: true,
  popoverClass: 'pi-driver-popover',
}
