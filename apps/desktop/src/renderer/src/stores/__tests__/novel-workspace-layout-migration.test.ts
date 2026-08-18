/**
 * mainMode × viewMode → layoutMode 的持久化迁移
 *
 * 旧模型用两个独立持久化状态描述同一件事「主工作区显示什么」：
 *   - novel-workspace-layout-store.mainMode: writing | split | matrix
 *   - novel-ui-store.viewMode:               matrix | canvas
 * 6 种组合里有 2 种自相矛盾（选了分屏却没有编辑器 / 选了画布却看到编辑器），
 * 合并为单一 layoutMode 后一一对应。
 *
 * 迁移按「上次屏幕上实际显示的是什么」换算，而不是按字面语义，
 * 否则老用户升级后会跳到一个自己没选过的布局。
 * 这条路径只在版本升级那一次跑，写错的代价是布局偏好被静默丢弃，故单独覆盖。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { migrateRightPanelView, migrateWorkspaceLayoutPersisted } from '../novel-workspace-layout-store'
import { resetLegacyViewModeCache } from '../novel-legacy-view-mode'

const UI_STORE_KEY = 'wenlang-agent-novel-ui'

/** 写入 ui-store 的旧持久化 payload（迁移要跨 store 读这里的 viewMode） */
function seedLegacyViewMode(viewMode: 'matrix' | 'canvas' | undefined): void {
  localStorage.setItem(
    UI_STORE_KEY,
    JSON.stringify({ state: viewMode === undefined ? {} : { viewMode }, version: 0 }),
  )
}

function migrateFromV2(mainMode: string | undefined): Record<string, unknown> {
  const payload: Record<string, unknown> = { sidebarWidth: 260, rightPanelView: 'detail' }
  if (mainMode !== undefined) payload.mainMode = mainMode
  return migrateWorkspaceLayoutPersisted(payload, 2) as Record<string, unknown>
}

beforeEach(() => {
  localStorage.clear()
  resetLegacyViewModeCache()
})

describe('layoutMode 迁移：按上次实际显示的内容换算', () => {
  it('writing → text（该组合下画布本来就到不了，viewMode 无关）', () => {
    seedLegacyViewMode('canvas')
    expect(migrateFromV2('writing').layoutMode).toBe('text')
  })

  it('split + matrix → text-timeline', () => {
    seedLegacyViewMode('matrix')
    expect(migrateFromV2('split').layoutMode).toBe('text-timeline')
  })

  it('split + canvas → graph（旧实现里 canvas 分支优先，编辑器并不显示）', () => {
    seedLegacyViewMode('canvas')
    expect(migrateFromV2('split').layoutMode).toBe('graph')
  })

  it('matrix + matrix → timeline', () => {
    seedLegacyViewMode('matrix')
    expect(migrateFromV2('matrix').layoutMode).toBe('timeline')
  })

  it('matrix + canvas → graph', () => {
    seedLegacyViewMode('canvas')
    expect(migrateFromV2('matrix').layoutMode).toBe('graph')
  })

  it('mainMode 缺失时落到 text-timeline（等于旧默认值 split）', () => {
    seedLegacyViewMode(undefined)
    expect(migrateFromV2(undefined).layoutMode).toBe('text-timeline')
  })

  it('ui-store 的 payload 损坏时按旧默认 matrix 处理，不抛错', () => {
    localStorage.setItem(UI_STORE_KEY, '{ not json')
    expect(migrateFromV2('matrix').layoutMode).toBe('timeline')
  })
})

describe('统一章节会话迁移', () => {
  it('旧 chat Tab 迁移到 conversation', () => {
    expect(migrateRightPanelView('chat')).toBe('conversation')
  })

  it('保留详情、设置和审计面板', () => {
    expect(migrateRightPanelView('detail')).toBe('detail')
    expect(migrateRightPanelView('settings')).toBe('settings')
    expect(migrateRightPanelView('audit')).toBe('audit')
  })
})

describe('layoutMode 迁移：不牵连其他字段', () => {
  it('保留用户已有的尺寸/面板偏好', () => {
    seedLegacyViewMode('matrix')
    const next = migrateFromV2('split')
    expect(next.sidebarWidth).toBe(260)
    expect(next.rightPanelView).toBe('detail')
  })

  it('删掉废弃的 mainMode，避免被 merge 的 `...p` 灌回运行时', () => {
    seedLegacyViewMode('matrix')
    expect('mainMode' in migrateFromV2('split')).toBe(false)
  })

  it('v1 payload 一并剔除更早的零消费字段', () => {
    seedLegacyViewMode('matrix')
    const next = migrateWorkspaceLayoutPersisted(
      { mainMode: 'matrix', splitRatio: 0.5, density: 'compact', rightPanelDocked: true, sidebarWidth: 300 },
      1,
    ) as Record<string, unknown>
    expect(next).toEqual({ layoutMode: 'timeline', sidebarWidth: 300 })
  })

  it('已是 v3 的 payload 原样返回', () => {
    const payload = { layoutMode: 'graph', sidebarWidth: 300 }
    expect(migrateWorkspaceLayoutPersisted(payload, 3)).toBe(payload)
  })

  it('已带 layoutMode 时不被旧字段覆盖', () => {
    seedLegacyViewMode('canvas')
    const next = migrateWorkspaceLayoutPersisted(
      { layoutMode: 'text', mainMode: 'matrix' },
      2,
    ) as Record<string, unknown>
    expect(next.layoutMode).toBe('text')
  })
})

describe('readLegacyViewMode 的 memo 语义', () => {
  it('首次读取后固定，之后 ui-store 删掉 key 也不影响结果', async () => {
    seedLegacyViewMode('canvas')
    const { readLegacyViewMode } = await import('../novel-legacy-view-mode')

    expect(readLegacyViewMode()).toBe('canvas')

    // 模拟 ui-store 的 v1 migrate 已经把 key 清掉
    localStorage.removeItem(UI_STORE_KEY)

    // 两个 store 的 rehydrate 顺序不确定，memo 保证后跑的那个仍拿到真值
    expect(readLegacyViewMode()).toBe('canvas')
    expect(migrateFromV2('matrix').layoutMode).toBe('graph')
  })
})
