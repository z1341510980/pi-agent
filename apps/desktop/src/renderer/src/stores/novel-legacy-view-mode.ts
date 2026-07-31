/**
 * 旧 `viewMode`（矩阵/画布）的一次性读取，供跨 store 迁移使用。
 *
 * 背景：`viewMode` 原先住在 novel-ui-store，`mainMode` 住在
 * novel-workspace-layout-store。两者合并为单一 `layoutMode` 后：
 *   - layout store 的 v3 migrate 需要旧 viewMode 才能还原「上次看到的是哪个视图」
 *   - ui-store 的 v1 migrate 要把这个废弃 key 从 localStorage 删掉
 *
 * 两个 store 谁先 rehydrate 取决于模块导入顺序，所以不能让 layout store
 * 直接去读 localStorage —— ui-store 可能已经把 key 删了。
 * 这里把读取结果 memo 在模块作用域：首次调用时取值，之后恒定返回同一结果，
 * 因此无论哪个 store 先跑迁移，拿到的都是同一个（迁移前的）真值。
 *
 * ui-store 的 migrate 必须在 `delete viewMode` 之前调用一次本函数，
 * 以保证值在被删除前已进内存。
 */

const UI_STORE_KEY = 'wenlang-agent-novel-ui'

type LegacyViewMode = 'matrix' | 'canvas'

let cached: LegacyViewMode | undefined

/** 读取（并 memo）迁移前持久化的 viewMode；读不到时按旧默认值 'matrix' 处理。 */
export function readLegacyViewMode(): LegacyViewMode {
  if (cached !== undefined) return cached
  cached = 'matrix'
  try {
    const raw = localStorage.getItem(UI_STORE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as { state?: { viewMode?: unknown } }
      if (parsed?.state?.viewMode === 'canvas') cached = 'canvas'
    }
  } catch {
    // localStorage 不可用或 JSON 损坏：保持 'matrix'
  }
  return cached
}

/** 仅供测试：清掉 memo，让下一次调用重新读 localStorage。 */
export function resetLegacyViewModeCache(): void {
  cached = undefined
}
