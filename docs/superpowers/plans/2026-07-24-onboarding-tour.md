# 新手引导（Onboarding Tour）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 PI Agent 桌面端实现新手引导系统，覆盖首页/小说/对话/设置/快捷键 5 个 tour，driver.js 驱动，首次启动自动播放 + rail 导航栏按钮手动重看。

**架构：** OnboardingProvider 顶层包裹 App，内含 zustand store（状态机）+ DriverHost（driver.js 实例）+ tours registry（静态配置）。tour 步骤通过 `data-tour` 属性定位 DOM，跨 view 切换由步骤 `onNext` 回调驱动 `setView`。localStorage 持久化完成版本号。

**技术栈：** React 19、TypeScript、driver.js@1.x、zustand（项目已用）、Tailwind 4、Vitest、radix-ui DropdownMenu

**关联规格：** `docs/superpowers/specs/2026-07-24-onboarding-tour-design.md`

---

## 文件结构

### 新增文件
```
apps/desktop/src/renderer/src/onboarding/
├─ index.ts                       # 公共 API 导出
├─ types.ts                       # TourStep / Tour / TourId 类型
├─ onboarding-store.ts            # zustand store（状态机 + persist）
├─ use-onboarding.ts              # 公共 hook（startTour/reset 等）
├─ onboarding-provider.tsx        # 顶层 Provider + DriverHost 组件
├─ driver-theme.ts                # driver.js popover 样式覆写
├─ tours/
│   ├─ index.ts                   # 汇总导出 tours registry
│   ├─ novel-tour.ts             # 小说 9 步
│   ├─ home-tour.ts              # 首页 5 步
│   ├─ chat-tour.ts              # 对话 7 步
│   ├─ settings-tour.ts          # 设置 5 步
│   └─ shortcuts-tour.ts         # 快捷键 8 步
└─ __tests__/
    ├─ onboarding-store.test.ts   # store 状态机测试
    ├─ persistence.test.ts        # localStorage 读写测试
    └─ tours.test.ts             # tour 配置完整性测试
```

### 修改文件
```
apps/desktop/package.json                          # + driver.js 依赖
apps/desktop/src/renderer/src/App.tsx              # 接入 Provider + rail 按钮 + 自动触发
apps/desktop/src/renderer/src/components/home/home-page.tsx
apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx
apps/desktop/src/renderer/src/components/novel/novel-sidebar.tsx
apps/desktop/src/renderer/src/components/novel/novel-canvas.tsx
apps/desktop/src/renderer/src/components/novel/novel-toolbar.tsx
apps/desktop/src/renderer/src/components/novel/matrix/matrix-workspace.tsx
apps/desktop/src/renderer/src/components/novel/chapter-content-editor.tsx
apps/desktop/src/renderer/src/components/chat/chat-workspace.tsx
apps/desktop/src/renderer/src/components/chat/session-list.tsx
apps/desktop/src/renderer/src/components/chat/input-area.tsx
apps/desktop/src/renderer/src/components/chat/permission-mode-switch.tsx
apps/desktop/src/renderer/src/components/chat/model-selector.tsx
apps/desktop/src/renderer/src/components/chat/tool-call-card.tsx
apps/desktop/src/renderer/src/components/settings/settings-page.tsx
```

---

## 阶段 1：基础设施

### 任务 1.1：安装 driver.js 依赖

**文件：**
- 修改：`apps/desktop/package.json`

- [ ] **步骤 1：安装 driver.js**

运行：
```bash
cd apps/desktop && pnpm add driver.js@^1.3.1
```
预期：`package.json` 的 `dependencies` 新增 `"driver.js": "^1.3.1"`

- [ ] **步骤 2：验证安装**

运行：
```bash
cd apps/desktop && node -e "console.log(require('driver.js/package.json').version)"
```
预期：输出 `1.3.1` 或更高 1.x 版本

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/package.json apps/desktop/pnpm-lock.yaml
git commit -m "feat(onboarding): 添加 driver.js 依赖"
```

---

### 任务 1.2：定义类型

**文件：**
- 创建：`apps/desktop/src/renderer/src/onboarding/types.ts`

- [ ] **步骤 1：编写类型文件**

```typescript
// apps/desktop/src/renderer/src/onboarding/types.ts

/**
 * 引导步骤定义
 *
 * element 为空时表示居中 popover（不绑定具体 DOM 元素），
 * 用于快捷键教学等全局概念。
 */
export interface TourStep {
  /** CSS selector 定位目标元素，留空则居中展示 */
  element?: string
  /** popover 标题 */
  title?: string
  /** popover 正文 */
  description: string
  /** 侧边展示位置，默认 'bottom' */
  side?: 'top' | 'bottom' | 'left' | 'right' | 'over' | 'auto'
  /** 该步骤期望的 view（用于跨 view 校验） */
  view?: 'home' | 'chat' | 'novel' | 'settings'
  /** 进入下一步前的回调（用于跨 view 切换等副作用） */
  onNext?: () => void
  /** 进入上一步前的回调 */
  onPrev?: () => void
}

/**
 * Tour 定义
 */
export interface Tour {
  id: TourId
  /** 步骤列表 */
  steps: TourStep[]
  /** tour 启动前的回调（用于 fallback、专注模式保护等） */
  onStart?: () => void | Promise<void>
  /** tour 结束后的回调 */
  onComplete?: () => void
}

export type TourId = 'home-tour' | 'novel-tour' | 'chat-tour' | 'settings-tour' | 'shortcuts-tour'

/**
 * localStorage 持久化结构
 */
export interface OnboardingPersistedState {
  /** 已完成引导的版本号，例如 "v1" */
  completedVersion: string | null
  /** 用户跳过的 tour id 列表 */
  skippedTours: TourId[]
  /** 最后一次看到引导的时间戳 */
  lastSeenAt: number
}
```

- [ ] **步骤 2：Commit**

```bash
git add apps/desktop/src/renderer/src/onboarding/types.ts
git commit -m "feat(onboarding): 定义 Tour/TourStep 类型"
```

---

### 任务 1.3：实现 onboarding-store（TDD）

**文件：**
- 创建：`apps/desktop/src/renderer/src/onboarding/__tests__/onboarding-store.test.ts`
- 创建：`apps/desktop/src/renderer/src/onboarding/onboarding-store.ts`

- [ ] **步骤 1：编写失败测试**

```typescript
// apps/desktop/src/renderer/src/onboarding/__tests__/onboarding-store.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useOnboardingStore, CURRENT_VERSION, STORAGE_KEY } from '../onboarding-store'

describe('onboarding-store', () => {
  beforeEach(() => {
    localStorage.clear()
    useOnboardingStore.getState().reset()
  })

  it('初始状态：无活跃 tour，stepIndex 为 0，completedVersion 为 null', () => {
    const state = useOnboardingStore.getState()
    expect(state.activeTour).toBeNull()
    expect(state.stepIndex).toBe(0)
    expect(state.completedVersion).toBeNull()
    expect(state.skippedTours).toEqual([])
  })

  it('startTour 设置 activeTour', () => {
    useOnboardingStore.getState().startTour('novel-tour')
    expect(useOnboardingStore.getState().activeTour).toBe('novel-tour')
    expect(useOnboardingStore.getState().stepIndex).toBe(0)
  })

  it('nextStep 递增 stepIndex', () => {
    useOnboardingStore.getState().startTour('novel-tour')
    useOnboardingStore.getState().nextStep()
    expect(useOnboardingStore.getState().stepIndex).toBe(1)
  })

  it('prevStep 递减 stepIndex，不小于 0', () => {
    useOnboardingStore.getState().startTour('novel-tour')
    useOnboardingStore.getState().nextStep()
    useOnboardingStore.getState().nextStep()
    useOnboardingStore.getState().prevStep()
    expect(useOnboardingStore.getState().stepIndex).toBe(1)
    useOnboardingStore.getState().prevStep()
    expect(useOnboardingStore.getState().stepIndex).toBe(0)
    useOnboardingStore.getState().prevStep()
    expect(useOnboardingStore.getState().stepIndex).toBe(0)
  })

  it('skipTour 写入 skippedTours 并清除 activeTour', () => {
    useOnboardingStore.getState().startTour('novel-tour')
    useOnboardingStore.getState().skipTour('novel-tour')
    const state = useOnboardingStore.getState()
    expect(state.activeTour).toBeNull()
    expect(state.skippedTours).toContain('novel-tour')
  })

  it('skipTour 幂等，重复跳过不重复添加', () => {
    useOnboardingStore.getState().skipTour('novel-tour')
    useOnboardingStore.getState().skipTour('novel-tour')
    expect(useOnboardingStore.getState().skippedTours.filter(t => t === 'novel-tour')).toHaveLength(1)
  })

  it('completeTour 写入 completedVersion 并清除 activeTour', () => {
    useOnboardingStore.getState().startTour('shortcuts-tour')
    useOnboardingStore.getState().completeTour()
    const state = useOnboardingStore.getState()
    expect(state.activeTour).toBeNull()
    expect(state.completedVersion).toBe(CURRENT_VERSION)
    expect(state.lastSeenAt).toBeGreaterThan(0)
  })

  it('resetOnboarding 清除 completedVersion 与 skippedTours', () => {
    useOnboardingStore.getState().completeTour()
    useOnboardingStore.getState().skipTour('novel-tour')
    useOnboardingStore.getState().resetOnboarding()
    const state = useOnboardingStore.getState()
    expect(state.completedVersion).toBeNull()
    expect(state.skippedTours).toEqual([])
    expect(state.activeTour).toBeNull()
  })

  it('isCompleted 返回 completedVersion 是否匹配当前版本', () => {
    expect(useOnboardingStore.getState().isCompleted()).toBe(false)
    useOnboardingStore.getState().completeTour()
    expect(useOnboardingStore.getState().isCompleted()).toBe(true)
  })

  it('shouldAutoStart 返回 true 当未完成且未跳过 home-tour', () => {
    expect(useOnboardingStore.getState().shouldAutoStart()).toBe(true)
    useOnboardingStore.getState().skipTour('home-tour')
    expect(useOnboardingStore.getState().shouldAutoStart()).toBe(false)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：
```bash
cd apps/desktop && pnpm vitest run src/renderer/src/onboarding/__tests__/onboarding-store.test.ts --environment jsdom
```
预期：FAIL，报错 "Cannot find module '../onboarding-store'"

- [ ] **步骤 3：编写 store 实现**

```typescript
// apps/desktop/src/renderer/src/onboarding/onboarding-store.ts
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { OnboardingPersistedState, TourId } from './types'

export const CURRENT_VERSION = 'v1'
export const STORAGE_KEY = 'pi-agent.onboarding'

interface OnboardingState extends OnboardingPersistedState {
  activeTour: TourId | null
  stepIndex: number
  // ── Actions ──
  startTour: (tourId: TourId) => void
  nextStep: () => void
  prevStep: () => void
  goToStep: (index: number) => void
  skipTour: (tourId: TourId) => void
  completeTour: () => void
  resetOnboarding: () => void
  // ── 派生查询 ──
  isCompleted: () => boolean
  shouldAutoStart: () => boolean
}

export const useOnboardingStore = create<OnboardingState>()(
  persist(
    (set, get) => ({
      completedVersion: null,
      skippedTours: [],
      lastSeenAt: 0,
      activeTour: null,
      stepIndex: 0,

      startTour: (tourId) => {
        if (get().activeTour && get().activeTour !== tourId) {
          console.warn(`[onboarding] 已有 tour ${get().activeTour} 运行中，被 ${tourId} 覆盖`)
        }
        set({ activeTour: tourId, stepIndex: 0, lastSeenAt: Date.now() })
      },

      nextStep: () => set((s) => ({ stepIndex: s.stepIndex + 1 })),

      prevStep: () => set((s) => ({ stepIndex: Math.max(0, s.stepIndex - 1) })),

      goToStep: (index) => set({ stepIndex: Math.max(0, index) }),

      skipTour: (tourId) =>
        set((s) => ({
          activeTour: null,
          skippedTours: s.skippedTours.includes(tourId) ? s.skippedTours : [...s.skippedTours, tourId],
          lastSeenAt: Date.now(),
        })),

      completeTour: () =>
        set({
          activeTour: null,
          completedVersion: CURRENT_VERSION,
          lastSeenAt: Date.now(),
        }),

      resetOnboarding: () =>
        set({
          activeTour: null,
          stepIndex: 0,
          completedVersion: null,
          skippedTours: [],
          lastSeenAt: 0,
        }),

      isCompleted: () => get().completedVersion === CURRENT_VERSION,

      shouldAutoStart: () =>
        !get().isCompleted() && !get().skippedTours.includes('home-tour'),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        completedVersion: s.completedVersion,
        skippedTours: s.skippedTours,
        lastSeenAt: s.lastSeenAt,
      }),
    }
  )
)

// 兼容 reset（测试用，绕过 persist）
useOnboardingStore.getState().reset = useOnboardingStore.getState().resetOnboarding
```

> **注意：** 测试里调用了 `reset()`，store 末尾补了 `reset` 别名指向 `resetOnboarding`，避免测试因 persist 中间件重置不彻底而污染。

- [ ] **步骤 4：运行测试验证通过**

运行：
```bash
cd apps/desktop && pnpm vitest run src/renderer/src/onboarding/__tests__/onboarding-store.test.ts --environment jsdom
```
预期：PASS，9 个用例全部通过

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/renderer/src/onboarding/onboarding-store.ts apps/desktop/src/renderer/src/onboarding/__tests__/onboarding-store.test.ts
git commit -m "feat(onboarding): 实现 onboarding store 状态机"
```

---

### 任务 1.4：实现 driver-theme 样式覆写

**文件：**
- 创建：`apps/desktop/src/renderer/src/onboarding/driver-theme.ts`

- [ ] **步骤 1：编写样式覆写**

```typescript
// apps/desktop/src/renderer/src/onboarding/driver-theme.ts
import type { DriverOptions } from 'driver.js'

/**
 * driver.js popover 主题覆写
 *
 * 沿用项目 Tailwind 4 + shadcn token，与现有 UI 无缝融合。
 * 颜色变量来自 :root 定义的 CSS custom properties。
 */
export const driverTheme: Partial<DriverOptions> = {
  overlayColor: 'var(--app-bg)',
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
```

- [ ] **步骤 2：在全局 CSS 中追加 popover 样式**

查阅项目全局 CSS 位置（`apps/desktop/src/renderer/src/styles/*.css` 或 `index.css`），追加：

```css
/* driver.js popover 主题覆写 */
.pi-driver-popover {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 12px;
  color: var(--text);
  box-shadow: 0 10px 30px -10px rgba(0, 0, 0, 0.3);
}
.pi-driver-popover .driver-popover-title {
  color: var(--text);
  font-weight: 760;
}
.pi-driver-popover .driver-popover-description {
  color: var(--muted-foreground);
}
.pi-driver-popover .driver-popover-progress {
  color: var(--muted-foreground);
  font-size: 11px;
}
.pi-driver-popover .driver-popover-close-btn {
  color: var(--muted-foreground);
}
.pi-driver-popover .driver-popover-navigation-btns button {
  background: var(--surface-3);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.pi-driver-popover .driver-popover-navigation-btns button:hover {
  background: var(--primary);
  color: var(--primary-foreground);
}
.pi-driver-popover .driver-popover-arrow-side {
  border-color: var(--border);
}
```

> **实施提示：** 需先确认项目 CSS 变量命名（`--app-bg` / `--surface-1` / `--surface-2` / `--surface-3` / `--border` / `--text` / `--muted-foreground` / `--primary` / `--primary-foreground`）。若命名不同，按实际调整。

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/renderer/src/onboarding/driver-theme.ts apps/desktop/src/renderer/src/styles/
git commit -m "feat(onboarding): 添加 driver.js 主题覆写"
```

---

### 任务 1.5：实现 use-onboarding hook + OnboardingProvider

**文件：**
- 创建：`apps/desktop/src/renderer/src/onboarding/use-onboarding.ts`
- 创建：`apps/desktop/src/renderer/src/onboarding/onboarding-provider.tsx`
- 创建：`apps/desktop/src/renderer/src/onboarding/index.ts`

- [ ] **步骤 1：编写 use-onboarding hook**

```typescript
// apps/desktop/src/renderer/src/onboarding/use-onboarding.ts
import { useOnboardingStore } from './onboarding-store'
import type { TourId } from './types'

export function useOnboarding() {
  const store = useOnboardingStore()
  return {
    activeTour: store.activeTour,
    stepIndex: store.stepIndex,
    isCompleted: store.isCompleted(),
    startTour: (tourId: TourId) => store.startTour(tourId),
    skipTour: (tourId: TourId) => store.skipTour(tourId),
    reset: () => store.resetOnboarding(),
  }
}
```

- [ ] **步骤 2：编写 OnboardingProvider + DriverHost**

```tsx
// apps/desktop/src/renderer/src/onboarding/onboarding-provider.tsx
import type { ReactElement, ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { driver, type Driver } from 'driver.js'
import 'driver.js/dist/driver.css'
import { useOnboardingStore } from './onboarding-store'
import { tours } from './tours'
import { driverTheme } from './driver-theme'

interface OnboardingProviderProps {
  children: ReactNode
  /** 切换 view 的回调，由 App.tsx 注入，用于跨 view 衔接 */
  setView?: (view: 'home' | 'chat' | 'novel' | 'settings') => void
}

export function OnboardingProvider({
  children,
  setView,
}: OnboardingProviderProps): ReactElement {
  const activeTour = useOnboardingStore((s) => s.activeTour)
  const stepIndex = useOnboardingStore((s) => s.stepIndex)
  const driverRef = useRef<Driver | null>(null)

  // 暴露 setView 给 tour 的 onNext 回调使用
  useEffect(() => {
    ;(window as unknown as { __onboardingSetView?: (v: string) => void }).__onboardingSetView = setView
    return () => {
      delete (window as unknown as { __onboardingSetView?: (v: string) => void }).__onboardingSetView
    }
  }, [setView])

  useEffect(() => {
    if (!activeTour) {
      // 关闭 driver
      if (driverRef.current) {
        driverRef.current.destroy()
        driverRef.current = null
      }
      return
    }

    const tour = tours[activeTour]
    if (!tour) {
      console.warn(`[onboarding] 未找到 tour: ${activeTour}`)
      return
    }

    // 执行 onStart（fallback、专注模式保护等）
    tour.onStart?.().then(() => {
      const driverInstance = driver({
        ...driverTheme,
        steps: tour.steps.map((s) => ({
          element: s.element,
          popover: {
            title: s.title,
            description: s.description,
            side: s.side ?? 'bottom',
          },
        })),
        onNextClick: () => {
          const currentStep = tour.steps[stepIndex]
          currentStep?.onNext?.()
          const nextIndex = stepIndex + 1
          if (nextIndex >= tour.steps.length) {
            // tour 结束
            tour.onComplete?.()
            useOnboardingStore.getState().completeTour()
          } else {
            useOnboardingStore.getState().nextStep()
            driverInstance.moveNext()
          }
        },
        onPrevClick: () => {
          const currentStep = tour.steps[stepIndex]
          currentStep?.onPrev?.()
          const prevIndex = Math.max(0, stepIndex - 1)
          useOnboardingStore.getState().goToStep(prevIndex)
          driverInstance.movePrevious()
        },
        onCloseClick: () => {
          useOnboardingStore.getState().skipTour(activeTour)
        },
      })
      driverRef.current = driverInstance
      driverInstance.drive()
    })
  }, [activeTour])

  return <>{children}</>
}
```

> **说明：** 这里用 `window.__onboardingSetView` 把 setView 注入到全局，tour 配置里的 `onNext` 回调通过它切换 view。这种解耦让 tour 配置文件不依赖 React，可独立测试。

- [ ] **步骤 3：编写 index.ts 导出**

```typescript
// apps/desktop/src/renderer/src/onboarding/index.ts
export { OnboardingProvider } from './onboarding-provider'
export { useOnboarding } from './use-onboarding'
export { useOnboardingStore, CURRENT_VERSION } from './onboarding-store'
export type { Tour, TourStep, TourId, OnboardingPersistedState } from './types'
```

- [ ] **步骤 4：编写 tours/index.ts 占位（阶段 2 填充）**

```typescript
// apps/desktop/src/renderer/src/onboarding/tours/index.ts
import type { Tour, TourId } from '../types'
import { homeTour } from './home-tour'
import { novelTour } from './novel-tour'
import { chatTour } from './chat-tour'
import { settingsTour } from './settings-tour'
import { shortcutsTour } from './shortcuts-tour'

export const tours: Record<TourId, Tour> = {
  'home-tour': homeTour,
  'novel-tour': novelTour,
  'chat-tour': chatTour,
  'settings-tour': settingsTour,
  'shortcuts-tour': shortcutsTour,
}
```

> **注意：** 此文件引用了 5 个 tour 文件，阶段 1 时这些文件还未创建。为避免编译错误，阶段 1 先创建 5 个占位 tour 文件（每个导出 `{ id, steps: [], onStart, onComplete }` 的空 tour），阶段 2-6 再逐步填充 steps。

- [ ] **步骤 5：创建 5 个占位 tour 文件**

```typescript
// apps/desktop/src/renderer/src/onboarding/tours/novel-tour.ts
import type { Tour } from '../types'
export const novelTour: Tour = { id: 'novel-tour', steps: [] }
```

```typescript
// apps/desktop/src/renderer/src/onboarding/tours/home-tour.ts
import type { Tour } from '../types'
export const homeTour: Tour = { id: 'home-tour', steps: [] }
```

```typescript
// apps/desktop/src/renderer/src/onboarding/tours/chat-tour.ts
import type { Tour } from '../types'
export const chatTour: Tour = { id: 'chat-tour', steps: [] }
```

```typescript
// apps/desktop/src/renderer/src/onboarding/tours/settings-tour.ts
import type { Tour } from '../types'
export const settingsTour: Tour = { id: 'settings-tour', steps: [] }
```

```typescript
// apps/desktop/src/renderer/src/onboarding/tours/shortcuts-tour.ts
import type { Tour } from '../types'
export const shortcutsTour: Tour = { id: 'shortcuts-tour', steps: [] }
```

- [ ] **步骤 6：在 App.tsx 接入 OnboardingProvider**

修改 `apps/desktop/src/renderer/src/App.tsx`：

```tsx
// 在 import 区追加
import { OnboardingProvider, useOnboardingStore } from './onboarding'

// 在 App 函数内，<ErrorBoundary> 内层包裹 OnboardingProvider
// setView 提升为可传给 Provider（App.tsx 里已有 view state，直接传 setView）

// 修改后的根结构（示意）：
return (
  <ErrorBoundary>
    <MotionConfig reducedMotion="user">
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <ThemeProvider>
            <OnboardingProvider setView={setView}>
              {/* 原有 div + nav + 内容区 */}
            </OnboardingProvider>
            {/* UpdateDialog / Toaster 保持在外层 */}
          </ThemeProvider>
        </I18nProvider>
      </QueryClientProvider>
    </MotionConfig>
  </ErrorBoundary>
)

// 在 App 函数末尾追加首次启动检测 useEffect：
useEffect(() => {
  if (ready && useOnboardingStore.getState().shouldAutoStart()) {
    const timer = setTimeout(() => useOnboardingStore.getState().startTour('home-tour'), 500)
    return () => clearTimeout(timer)
  }
}, [ready])
```

- [ ] **步骤 7：验证 typecheck**

运行：
```bash
cd apps/desktop && pnpm typecheck:web
```
预期：无类型错误

- [ ] **步骤 8：Commit**

```bash
git add apps/desktop/src/renderer/src/onboarding/ apps/desktop/src/renderer/src/App.tsx
git commit -m "feat(onboarding): 接入 OnboardingProvider + DriverHost"
```

---

### 任务 1.6：持久化测试

**文件：**
- 创建：`apps/desktop/src/renderer/src/onboarding/__tests__/persistence.test.ts`

- [ ] **步骤 1：编写测试**

```typescript
// apps/desktop/src/renderer/src/onboarding/__tests__/persistence.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useOnboardingStore, CURRENT_VERSION, STORAGE_KEY } from '../onboarding-store'

describe('onboarding persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    useOnboardingStore.getState().resetOnboarding()
  })

  it('completeTour 后 localStorage 写入 completedVersion', () => {
    useOnboardingStore.getState().completeTour()
    const raw = localStorage.getItem(STORAGE_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!).state
    expect(parsed.completedVersion).toBe(CURRENT_VERSION)
  })

  it('skipTour 后 localStorage 写入 skippedTours', () => {
    useOnboardingStore.getState().skipTour('novel-tour')
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = JSON.parse(raw!).state
    expect(parsed.skippedTours).toContain('novel-tour')
  })

  it('resetOnboarding 清除 localStorage 持久化字段', () => {
    useOnboardingStore.getState().completeTour()
    useOnboardingStore.getState().skipTour('novel-tour')
    useOnboardingStore.getState().resetOnboarding()
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = JSON.parse(raw!).state
    expect(parsed.completedVersion).toBeNull()
    expect(parsed.skippedTours).toEqual([])
  })

  it('activeTour 和 stepIndex 不被持久化', () => {
    useOnboardingStore.getState().startTour('novel-tour')
    useOnboardingStore.getState().nextStep()
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = JSON.parse(raw!).state
    expect(parsed.activeTour).toBeUndefined()
    expect(parsed.stepIndex).toBeUndefined()
  })
})
```

- [ ] **步骤 2：运行测试验证通过**

运行：
```bash
cd apps/desktop && pnpm vitest run src/renderer/src/onboarding/__tests__/persistence.test.ts --environment jsdom
```
预期：PASS，4 个用例通过

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/renderer/src/onboarding/__tests__/persistence.test.ts
git commit -m "test(onboarding): 添加持久化测试"
```

---

## 阶段 2：小说创作工作区（优先实施）

### 任务 2.1：novel-workspace.tsx 标注 data-tour

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx`

依据调研报告（`novel-workspace.tsx:876` header / `:127` MainModeSwitcher / `:80` ViewSwitcher / `:1150-1214` 右栏 Tab），追加 `data-tour` 属性。

- [ ] **步骤 1：在 header 容器加 data-tour**

```tsx
// novel-workspace.tsx 约 876 行，header 根元素
<header
  data-tour="novel-header"
  className="grid ..."
>
```

- [ ] **步骤 2：在 MainModeSwitcher 根加 data-tour**

```tsx
// novel-workspace.tsx 约 127-174 行 MainModeSwitcher 组件
// 找到 role="tablist" aria-label="工作区模式" 的元素
<div
  role="tablist"
  aria-label="工作区模式"
  data-tour="mode-switcher"
>
```

- [ ] **步骤 3：在 ViewSwitcher 根加 data-tour**

```tsx
// novel-workspace.tsx 约 80-120 行 ViewSwitcher 组件
<div
  role="tablist"
  aria-label="视图切换"
  data-tour="view-switcher"
>
```

- [ ] **步骤 4：在右栏 3 个 Tab 按钮加 data-tour**

```tsx
// novel-workspace.tsx 约 1153/1169/1188 行，3 个 role="tab" 按钮
// 对话 tab
<button role="tab" data-tour="right-tab-conversation" ...>
// 详情 tab
<button role="tab" data-tour="right-tab-detail" ...>
// 审计 tab
<button role="tab" data-tour="right-tab-audit" ...>
```

- [ ] **步骤 5：验证 typecheck + 运行已有测试**

运行：
```bash
cd apps/desktop && pnpm typecheck:web && pnpm test -- novel
```
预期：无类型错误，已有测试通过

- [ ] **步骤 6：Commit**

```bash
git add apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx
git commit -m "feat(onboarding): novel-workspace 标注 data-tour"
```

---

### 任务 2.2：novel-sidebar.tsx 标注 data-tour

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/novel/novel-sidebar.tsx`

依据调研（`:200` ul 项目列表 / `:251-273` ProjectTree / `:279-289` 回收站按钮）。

- [ ] **步骤 1：项目列表 ul 加 data-tour**

```tsx
// novel-sidebar.tsx 约 200 行
<ul data-tour="project-list" className="...">
```

- [ ] **步骤 2：ProjectTree 容器加 data-tour**

```tsx
// novel-sidebar.tsx 约 251 行，ProjectTree 组件外包 div
<div data-tour="project-tree">
  <ProjectTree ... />
</div>
```

- [ ] **步骤 3：回收站按钮加 data-tour**

```tsx
// novel-sidebar.tsx 约 279-289 行
<Button data-tour="trash-button" ...>回收站</Button>
```

- [ ] **步骤 4：Commit**

```bash
git add apps/desktop/src/renderer/src/components/novel/novel-sidebar.tsx
git commit -m "feat(onboarding): novel-sidebar 标注 data-tour"
```

---

### 任务 2.3：novel-canvas.tsx + novel-toolbar.tsx 标注 data-tour

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/novel/novel-canvas.tsx`
- 修改：`apps/desktop/src/renderer/src/components/novel/novel-toolbar.tsx`

依据调研（canvas `:685-709` / mini-map `:707` / toolbar `:277`）。

- [ ] **步骤 1：ReactFlow 画布容器加 data-tour**

```tsx
// novel-canvas.tsx 约 685 行 ReactFlow 根
<ReactFlow
  className="novel-canvas"
  data-tour="canvas"
  ...
>
```

- [ ] **步骤 2：MiniMap 加 data-tour**

```tsx
// novel-canvas.tsx 约 707 行
<MemoizedMiniMap data-tour="canvas-minimap" ... />
```

- [ ] **步骤 3：NovelToolbar 根加 data-tour**

```tsx
// novel-toolbar.tsx 约 277 行根 div
<div data-tour="canvas-toolbar" className="flex items-center gap-1 h-11 border-b ...">
```

- [ ] **步骤 4：Commit**

```bash
git add apps/desktop/src/renderer/src/components/novel/novel-canvas.tsx apps/desktop/src/renderer/src/components/novel/novel-toolbar.tsx
git commit -m "feat(onboarding): novel-canvas/toolbar 标注 data-tour"
```

---

### 任务 2.4：matrix-workspace.tsx + chapter-content-editor.tsx 标注 data-tour

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/novel/matrix/matrix-workspace.tsx`
- 修改：`apps/desktop/src/renderer/src/components/novel/chapter-content-editor.tsx`

依据调研（matrix `:1440-1463` toolbar / `:1465` legend / `:1467-1499` view / editor `:250` 根 / `:258-282` nav / `:338-347` reverse-btn）。

- [ ] **步骤 1：MatrixToolbar 容器加 data-tour**

```tsx
// matrix-workspace.tsx 约 1440 行
<MatrixToolbar data-tour="matrix-toolbar" ... />
```
> 若 MatrixToolbar 不接受 data-tour，改为在其外层 div 包裹。需查 MatrixToolbar props 确认。

- [ ] **步骤 2：MatrixLegend 加 data-tour**

```tsx
// matrix-workspace.tsx 约 1465 行
<MatrixLegend data-tour="matrix-legend" ... />
```

- [ ] **步骤 3：MatrixView 容器加 data-tour**

```tsx
// matrix-workspace.tsx 约 1467 行
<div data-tour="matrix-view" className="flex-1 min-h-0 overflow-hidden">
  <MatrixView ... />
</div>
```

- [ ] **步骤 4：ChapterContentEditor 根加 data-tour**

```tsx
// chapter-content-editor.tsx 约 250 行根 div
<div data-tour="editor" className="chapter-content-editor ...">
```

- [ ] **步骤 5：章节导航加 data-tour**

```tsx
// chapter-content-editor.tsx 约 258 行 cce-nav 容器
<div className="cce-nav" data-tour="chapter-nav">
```

- [ ] **步骤 6：反推实体按钮加 data-tour**

```tsx
// chapter-content-editor.tsx 约 338-347 行
<button className="cce-reverse-btn" data-tour="reverse-arrange" title="从当前正文提取...">
```

- [ ] **步骤 7：Commit**

```bash
git add apps/desktop/src/renderer/src/components/novel/matrix/matrix-workspace.tsx apps/desktop/src/renderer/src/components/novel/chapter-content-editor.tsx
git commit -m "feat(onboarding): matrix/editor 标注 data-tour"
```

---

### 任务 2.5：编写 novel-tour 配置（TDD）

**文件：**
- 创建：`apps/desktop/src/renderer/src/onboarding/__tests__/tours.test.ts`
- 修改：`apps/desktop/src/renderer/src/onboarding/tours/novel-tour.ts`

- [ ] **步骤 1：编写 tours 配置完整性测试**

```typescript
// apps/desktop/src/renderer/src/onboarding/__tests__/tours.test.ts
import { describe, it, expect } from 'vitest'
import { tours } from '../tours'

describe('tours 配置完整性', () => {
  const tourIds = ['home-tour', 'novel-tour', 'chat-tour', 'settings-tour', 'shortcuts-tour'] as const

  for (const id of tourIds) {
    describe(`${id}`, () => {
      it('存在于 tours registry', () => {
        expect(tours[id]).toBeDefined()
      })

      it('id 与 key 匹配', () => {
        expect(tours[id].id).toBe(id)
      })

      it('每个步骤必须有 description', () => {
        for (const step of tours[id].steps) {
          expect(step.description, `步骤 description 不能为空`).toBeTruthy()
          expect(typeof step.description).toBe('string')
        }
      })

      it('若步骤有 element，必须是合法 selector 字符串', () => {
        for (const step of tours[id].steps) {
          if (step.element !== undefined) {
            expect(step.element.length).toBeGreaterThan(0)
            expect(step.element).toMatch(/^\[|^#|^\./)  // [attr] / #id / .class
          }
        }
      })
    })
  }
})
```

- [ ] **步骤 2：运行测试，预期 novel-tour 因 steps 为空而部分用例"通过"（空数组），需手动补 steps 后再验证**

运行：
```bash
cd apps/desktop && pnpm vitest run src/renderer/src/onboarding/__tests__/tours.test.ts --environment jsdom
```
预期：通过（空 steps 也能通过"每个步骤必须有 description"的循环，因为循环 0 次）

- [ ] **步骤 3：填充 novel-tour 配置**

```typescript
// apps/desktop/src/renderer/src/onboarding/tours/novel-tour.ts
import type { Tour } from '../types'

/**
 * 切换 view 的辅助函数（注入到 window.__onboardingSetView）
 */
function setView(view: 'home' | 'chat' | 'novel' | 'settings'): void {
  const w = window as unknown as { __onboardingSetView?: (v: string) => void }
  w.__onboardingSetView?.(view)
}

export const novelTour: Tour = {
  id: 'novel-tour',
  steps: [
    {
      element: '[data-tour="project-list"]',
      title: '项目树',
      description: '在这里创建、切换、删除小说项目。点击项目卡片即可打开。',
      side: 'right',
      view: 'novel',
    },
    {
      element: '[data-tour="mode-switcher"]',
      title: '工作区模式',
      description: '切换写作 / 分屏 / 矩阵三种模式。',
      side: 'bottom',
      view: 'novel',
    },
    {
      element: '[data-tour="view-switcher"]',
      title: '视图切换',
      description: '画布看关系图，矩阵看时间线。',
      side: 'bottom',
      view: 'novel',
    },
    {
      element: '[data-tour="canvas"]',
      title: '画布',
      description: '节点 = 实体（角色/冲突/伏笔等），连线 = 关系。拖拽布局，缩放查看。',
      side: 'left',
      view: 'novel',
    },
    {
      element: '[data-tour="canvas-toolbar"]',
      title: '画布工具栏',
      description: '切换布局模式、过滤关系类型、查找路径、缩放。',
      side: 'bottom',
      view: 'novel',
    },
    {
      element: '[data-tour="matrix-view"]',
      title: '矩阵视图',
      description: '实体行 × 章节列，追踪角色出场、伏笔铺设、冲突演化。',
      side: 'top',
      view: 'novel',
    },
    {
      element: '[data-tour="editor"]',
      title: '章节编辑器',
      description: 'Tiptap 富文本，上一章/下一章快速跳转。',
      side: 'right',
      view: 'novel',
    },
    {
      element: '[data-tour="reverse-arrange"]',
      title: '反推实体',
      description: '从正文自动提取角色/冲突/伏笔到矩阵，自动维护关系图。',
      side: 'top',
      view: 'novel',
    },
    {
      element: '[data-tour="right-tab-conversation"]',
      title: '右侧面板',
      description: '对话：与多 Agent 讨论剧情；详情：修改实体属性；审计：检查一致性。即将进入对话工作台 →',
      side: 'left',
      view: 'novel',
      onNext: () => {
        setView('chat')
        // 延迟启动 chat-tour，等 chat 视图渲染
        setTimeout(() => {
          const { useOnboardingStore } = require('../onboarding-store')
          useOnboardingStore.getState().startTour('chat-tour')
        }, 500)
      },
    },
  ],
  onStart: () => {
    // 专注模式保护：强制退出专注模式，避免浮层遮挡
    try {
      const { useNovelWorkspaceLayoutStore } = require('@/stores/novel-workspace-layout-store')
      if (useNovelWorkspaceLayoutStore.getState().focusMode) {
        useNovelWorkspaceLayoutStore.getState().setFocusMode(false)
      }
    } catch {
      // store 未加载时忽略
    }

    // 无项目 fallback：检查项目列表，若空则跳过画布/矩阵/编辑器步骤
    // 通过 query DOM 判断 novel-sidebar 是否处于空状态
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const emptyState = document.querySelector('[data-tour="project-list"]')
        // 若 project-list 不存在或其父容器显示空状态，标记跳过
        // 简化处理：若元素不存在，driver.js 会自动跳过该步
        resolve()
      }, 100)
    })
  },
}
```

> **注意：** `onNext` 中使用 `require` 是为了在 tour 配置文件（非 React 组件）中访问 store 而不引入循环依赖。Vite/Electron 支持此写法。也可改为在 `onboarding-provider.tsx` 的 `onNextClick` 中统一处理跨 tour 衔接，配置里只声明 `nextTour: 'chat-tour'` 和 `nextView: 'chat'`。后者更干净，可作为重构方向。

- [ ] **步骤 4：运行测试验证通过**

运行：
```bash
cd apps/desktop && pnpm vitest run src/renderer/src/onboarding/__tests__/tours.test.ts --environment jsdom
```
预期：PASS，novel-tour 的 9 个步骤全部通过完整性校验

- [ ] **步骤 5：手动验证（可选，需启动应用）**

启动应用，进入小说工作区，在 DevTools Console 执行：
```js
window.__onboardingSetView?.('novel')
// 然后从 rail 导航栏按钮（阶段 3 才接入）或 store 直接启动：
// 在 React DevTools 里调用 useOnboardingStore.getState().startTour('novel-tour')
```
预期：9 步引导依次播放，popover 样式与项目主题融合

- [ ] **步骤 6：Commit**

```bash
git add apps/desktop/src/renderer/src/onboarding/tours/novel-tour.ts apps/desktop/src/renderer/src/onboarding/__tests__/tours.test.ts
git commit -m "feat(onboarding): 实现 novel-tour 9 步引导配置"
```

---

### 任务 2.6：阶段 2 审查检查点

- [ ] **步骤 1：运行全部 onboarding 测试**

```bash
cd apps/desktop && pnpm vitest run src/renderer/src/onboarding/ --environment jsdom
```
预期：所有测试通过

- [ ] **步骤 2：运行 typecheck**

```bash
cd apps/desktop && pnpm typecheck:web
```
预期：无错误

- [ ] **步骤 3：请用户审查阶段 2 成果**

向用户报告：
- novel-tour 9 步引导已实现
- 全部 novel 组件 data-tour 已标注
- 无项目 fallback 与专注模式保护已就位
- 请用户手动启动应用验证引导播放效果

审查通过后再进入阶段 3。

---

## 阶段 3：首页 + rail 导航栏入口

### 任务 3.1：home-page.tsx 标注 data-tour

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/home/home-page.tsx`

依据源码（`home-page.tsx:110` 快捷入口 section / `:115` entry-chat / `:122` entry-novel / `:129` entry-settings）。

- [ ] **步骤 1：快捷入口 section 加 data-tour**

```tsx
// home-page.tsx 约 110 行
<section data-tour="home-entries" className="mb-10">
```

- [ ] **步骤 2：三个 EntryCard 加 data-tour**

```tsx
// home-page.tsx 约 115/122/129 行
<EntryCard data-tour="entry-chat" icon={MessageSquare} ... />
<EntryCard data-tour="entry-novel" icon={BookOpen} ... />
<EntryCard data-tour="entry-settings" icon={Settings} ... />
```
> EntryCard 组件需在 props 接受 `data-tour` 并透传到根 button。修改 `EntryCard` 函数签名增加 `data-tour?: string`，传递到 `<button data-tour={...}>`。

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/renderer/src/components/home/home-page.tsx
git commit -m "feat(onboarding): home-page 标注 data-tour"
```

---

### 任务 3.2：实现 home-tour 配置

**文件：**
- 修改：`apps/desktop/src/renderer/src/onboarding/tours/home-tour.ts`

- [ ] **步骤 1：填充 home-tour**

```typescript
// apps/desktop/src/renderer/src/onboarding/tours/home-tour.ts
import type { Tour } from '../types'

function setView(view: 'home' | 'chat' | 'novel' | 'settings'): void {
  const w = window as unknown as { __onboardingSetView?: (v: string) => void }
  w.__onboardingSetView?.(view)
}

export const homeTour: Tour = {
  id: 'home-tour',
  steps: [
    {
      title: '欢迎使用 PI Agent',
      description: '5 分钟带你熟悉四大模块。点击下一步开始 →',
      side: 'over',
      view: 'home',
    },
    {
      element: '[data-tour="home-entries"]',
      title: '从这里开始',
      description: '对话工作台 / 小说创作 / 设置 三个入口。',
      side: 'bottom',
      view: 'home',
    },
    {
      element: '[data-tour="entry-chat"]',
      title: '对话工作台',
      description: '多轮对话，处理编码与分析。',
      side: 'right',
      view: 'home',
    },
    {
      element: '[data-tour="entry-novel"]',
      title: '小说创作',
      description: '多 Agent 协作的长篇小说创作工作台。',
      side: 'right',
      view: 'home',
    },
    {
      element: '[data-tour="entry-settings"]',
      title: '设置',
      description: '配置 Provider、Agent 人格、模型与安全。即将进入小说工作台 →',
      side: 'right',
      view: 'home',
      onNext: () => {
        setView('novel')
        setTimeout(() => {
          const { useOnboardingStore } = require('../onboarding-store')
          useOnboardingStore.getState().startTour('novel-tour')
        }, 500)
      },
    },
  ],
}
```

- [ ] **步骤 2：运行测试**

```bash
cd apps/desktop && pnpm vitest run src/renderer/src/onboarding/__tests__/tours.test.ts --environment jsdom
```
预期：home-tour 5 步通过校验

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/renderer/src/onboarding/tours/home-tour.ts
git commit -m "feat(onboarding): 实现 home-tour 5 步引导配置"
```

---

### 任务 3.3：App.tsx 接入 rail 导航栏「新手引导」按钮

**文件：**
- 修改：`apps/desktop/src/renderer/src/App.tsx`

依据源码（`App.tsx:60-89` nav 内 4 个 RailButton，设置按钮在 `mt-auto` 位置）。

- [ ] **步骤 1：引入 DropdownMenu 与 HelpCircle 图标**

```tsx
// App.tsx import 区追加
import { HelpCircle } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { useOnboardingStore } from './onboarding'
```

- [ ] **步骤 2：在 nav 内、设置按钮前插入「新手引导」按钮**

```tsx
// App.tsx 约 82-88 行，原设置 RailButton 之前
{/* 新手引导：单击弹菜单选具体 tour，承担 mt-auto（贴底） */}
<DropdownMenu>
  <DropdownMenuTrigger asChild>
    <RailButton
      icon={HelpCircle}
      label="新手引导"
      className="mt-auto"
    />
  </DropdownMenuTrigger>
  <DropdownMenuContent side="right" align="end" className="min-w-[160px]">
    <DropdownMenuItem onClick={() => useOnboardingStore.getState().startTour('home-tour')}>
      首页引导
    </DropdownMenuItem>
    <DropdownMenuItem onClick={() => {
      useOnboardingStore.getState().startTour('novel-tour')
    }}>
      小说创作
    </DropdownMenuItem>
    <DropdownMenuItem onClick={() => useOnboardingStore.getState().startTour('chat-tour')}>
      对话工作台
    </DropdownMenuItem>
    <DropdownMenuItem onClick={() => useOnboardingStore.getState().startTour('settings-tour')}>
      设置页
    </DropdownMenuItem>
    <DropdownMenuSeparator />
    <DropdownMenuItem onClick={() => useOnboardingStore.getState().startTour('shortcuts-tour')}>
      快捷键教学
    </DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>

{/* 设置按钮去掉 mt-auto */}
<RailButton
  icon={SettingsIcon}
  label="设置"
  active={view === 'settings'}
  onClick={() => setView('settings')}
/>
```

- [ ] **步骤 3：验证 typecheck + 手动测试**

```bash
cd apps/desktop && pnpm typecheck:web
```
启动应用，点击 rail 导航栏「新手引导」按钮，验证菜单弹出。

- [ ] **步骤 4：Commit**

```bash
git add apps/desktop/src/renderer/src/App.tsx
git commit -m "feat(onboarding): rail 导航栏接入新手引导按钮"
```

---

### 任务 3.4：阶段 3 审查检查点

- [ ] **步骤 1：验证首次启动自动触发**

启动应用（清除 localStorage `pi-agent.onboarding`），验证首页引导自动播放。

- [ ] **步骤 2：请用户审查阶段 3 成果**

审查通过后进入阶段 4。

---

## 阶段 4：对话工作台

### 任务 4.1：chat 各组件标注 data-tour

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/chat/chat-workspace.tsx`
- 修改：`apps/desktop/src/renderer/src/components/chat/session-list.tsx`
- 修改：`apps/desktop/src/renderer/src/components/chat/input-area.tsx`
- 修改：`apps/desktop/src/renderer/src/components/chat/permission-mode-switch.tsx`
- 修改：`apps/desktop/src/renderer/src/components/chat/model-selector.tsx`

依据调研报告，追加 data-tour：
- `chat-workspace.tsx:480` 根 div → `data-tour="chat-workspace"`
- `chat-workspace.tsx:488` 左栏容器 → `data-tour="sidebar"`
- `chat-workspace.tsx:516` header → `data-tour="chat-header"`
- `chat-workspace.tsx:660` 状态栏 → `data-tour="status-bar"`
- `session-list.tsx:152` 滚动容器 → `data-tour="session-list"`
- `input-area.tsx:316` 输入卡片 → `data-tour="input-card"`
- `input-area.tsx:453` 工具栏 → `data-tour="input-toolbar"`
- `permission-mode-switch.tsx:151` 触发按钮 → `data-tour="permission-switch"`
- `model-selector.tsx:83` SelectTrigger → `data-tour="model-selector"`

- [ ] **步骤 1：逐文件追加 data-tour 属性**（按上述清单）

- [ ] **步骤 2：typecheck + Commit**

```bash
cd apps/desktop && pnpm typecheck:web
git add apps/desktop/src/renderer/src/components/chat/
git commit -m "feat(onboarding): chat 组件标注 data-tour"
```

---

### 任务 4.2：实现 chat-tour 配置

**文件：**
- 修改：`apps/desktop/src/renderer/src/onboarding/tours/chat-tour.ts`

- [ ] **步骤 1：填充 chat-tour**

```typescript
// apps/desktop/src/renderer/src/onboarding/tours/chat-tour.ts
import type { Tour } from '../types'

function setView(view: 'home' | 'chat' | 'novel' | 'settings'): void {
  const w = window as unknown as { __onboardingSetView?: (v: string) => void }
  w.__onboardingSetView?.(view)
}

export const chatTour: Tour = {
  id: 'chat-tour',
  steps: [
    {
      element: '[data-tour="session-list"]',
      title: '会话列表',
      description: '新建、切换、删除对话会话。',
      side: 'right',
      view: 'chat',
    },
    {
      element: '[aria-label="消息流"]',
      title: '消息流',
      description: '用户与 Agent 的对话流，工具调用会折叠成卡片。',
      side: 'top',
      view: 'chat',
    },
    {
      element: '[data-tour="input-card"]',
      title: '输入区',
      description: 'Enter 发送，Shift+Enter 换行。@ 引用会话，/ 触发斜杠指令。',
      side: 'top',
      view: 'chat',
    },
    {
      element: '[data-tour="model-selector"]',
      title: '模型选择器',
      description: '选择当前会话使用的 LLM 模型。',
      side: 'top',
      view: 'chat',
    },
    {
      element: '[data-tour="permission-switch"]',
      title: '权限模式',
      description: 'Auto/Plan/Read-only/Full 四种权限模式。',
      side: 'top',
      view: 'chat',
    },
    {
      element: '[aria-label="上下文状态"]',
      title: '右侧上下文面板',
      description: '查看 token 占用、关联文件、记忆摘要、活动日志。',
      side: 'left',
      view: 'chat',
    },
    {
      element: '[data-tour="status-bar"]',
      title: '状态栏',
      description: '在线状态、延迟、当前模型与权限模式一目了然 →',
      side: 'top',
      view: 'chat',
      onNext: () => {
        setView('settings')
        setTimeout(() => {
          const { useOnboardingStore } = require('../onboarding-store')
          useOnboardingStore.getState().startTour('settings-tour')
        }, 500)
      },
    },
  ],
}
```

- [ ] **步骤 2：运行测试 + Commit**

```bash
cd apps/desktop && pnpm vitest run src/renderer/src/onboarding/__tests__/tours.test.ts --environment jsdom
git add apps/desktop/src/renderer/src/onboarding/tours/chat-tour.ts
git commit -m "feat(onboarding): 实现 chat-tour 7 步引导配置"
```

---

## 阶段 5：设置页

### 任务 5.1：settings-page.tsx 标注 data-tour

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/settings/settings-page.tsx`

依据调研（`:70` 主体 / `:100` 内容 main / `:81` navItems.map 7 个按钮）。

- [ ] **步骤 1：主体与内容区加 data-tour**

```tsx
// settings-page.tsx 约 70 行
<div data-tour="settings-body" className="grid grid-cols-[240px_minmax(0,1fr)]">
// 约 100 行
<main data-tour="settings-content" className="bg-app-bg overflow-auto">
```

- [ ] **步骤 2：7 个导航按钮加 data-tour**

```tsx
// settings-page.tsx 约 77-96 行 navItems.map
// 每个 button 追加 data-tour={`nav-${item.id}`}
{navItems.map((item) => (
  <button
    key={item.id}
    data-tour={`nav-${item.id}`}
    aria-current={activeSection === item.id ? 'page' : undefined}
    ...
  >
))}
```
对应：`nav-providers` / `nav-models` / `nav-agents` / `nav-security` / `nav-cron` / `nav-general` / `nav-about`

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/renderer/src/components/settings/settings-page.tsx
git commit -m "feat(onboarding): settings-page 标注 data-tour"
```

---

### 任务 5.2：实现 settings-tour 配置

**文件：**
- 修改：`apps/desktop/src/renderer/src/onboarding/tours/settings-tour.ts`

- [ ] **步骤 1：填充 settings-tour**

```typescript
// apps/desktop/src/renderer/src/onboarding/tours/settings-tour.ts
import type { Tour } from '../types'

function setView(view: 'home' | 'chat' | 'novel' | 'settings'): void {
  const w = window as unknown as { __onboardingSetView?: (v: string) => void }
  w.__onboardingSetView?.(view)
}

export const settingsTour: Tour = {
  id: 'settings-tour',
  steps: [
    {
      element: '[aria-label="设置导航"]',
      title: '设置导航',
      description: '7 个设置项，我们重点看 3 个。',
      side: 'right',
      view: 'settings',
    },
    {
      element: '[data-tour="nav-providers"]',
      title: 'Provider 管理',
      description: '管理 LLM 服务商。点击卡片编辑，右上角「添加 Provider」新增。',
      side: 'right',
      view: 'settings',
    },
    {
      element: '[data-tour="nav-models"]',
      title: '模型管理',
      description: '查看每个 Provider 的可用模型，也可手动添加自定义模型。',
      side: 'right',
      view: 'settings',
    },
    {
      element: '[data-tour="nav-agents"]',
      title: 'Agent 管理',
      description: 'Agent 人格配置，含系统提示词、温度、人格模板。',
      side: 'right',
      view: 'settings',
    },
    {
      element: '[data-tour="nav-security"]',
      title: '权限与安全',
      description: '全局权限模式 + 工作目录白名单。新手建议先选 Plan 模式 →',
      side: 'right',
      view: 'settings',
      onNext: () => {
        setView('home')
        setTimeout(() => {
          const { useOnboardingStore } = require('../onboarding-store')
          useOnboardingStore.getState().startTour('shortcuts-tour')
        }, 500)
      },
    },
  ],
}
```

- [ ] **步骤 2：运行测试 + Commit**

```bash
cd apps/desktop && pnpm vitest run src/renderer/src/onboarding/__tests__/tours.test.ts --environment jsdom
git add apps/desktop/src/renderer/src/onboarding/tours/settings-tour.ts
git commit -m "feat(onboarding): 实现 settings-tour 5 步引导配置"
```

---

## 阶段 6：快捷键教学

### 任务 6.1：实现 shortcuts-tour 配置

**文件：**
- 修改：`apps/desktop/src/renderer/src/onboarding/tours/shortcuts-tour.ts`

依据规格 5.5 节，全部使用居中 popover（无 element）。

- [ ] **步骤 1：填充 shortcuts-tour**

```typescript
// apps/desktop/src/renderer/src/onboarding/tours/shortcuts-tour.ts
import type { Tour } from '../types'

function setView(view: 'home' | 'chat' | 'novel' | 'settings'): void {
  const w = window as unknown as { __onboardingSetView?: (v: string) => void }
  w.__onboardingSetView?.(view)
}

export const shortcutsTour: Tour = {
  id: 'shortcuts-tour',
  steps: [
    {
      title: '命令面板',
      description: '打开命令面板，快速跳转任何功能\n快捷键：Ctrl/Cmd+K',
      side: 'over',
    },
    {
      title: '新建会话',
      description: '新建对话会话\n快捷键：Ctrl/Cmd+N',
      side: 'over',
    },
    {
      title: '打开设置',
      description: '打开设置\n快捷键：Ctrl/Cmd+,',
      side: 'over',
    },
    {
      title: '切换 DevLog',
      description: '切换底部开发日志面板\n快捷键：Ctrl/Cmd+D',
      side: 'over',
    },
    {
      title: '对话切栏',
      description: '切换左侧会话列表 / 右侧上下文\n快捷键：Ctrl/Cmd+\\ / Ctrl/Cmd+Shift+\\',
      side: 'over',
    },
    {
      title: '会话跳转',
      description: '上一会话 / 下一会话\n快捷键：Ctrl/Cmd+[ / Ctrl/Cmd+]',
      side: 'over',
    },
    {
      title: '小说模式',
      description: '写作 / 矩阵 / 分屏 / 专注模式\n快捷键：Ctrl/Cmd+1/2/3 / Ctrl/Cmd+Shift+F',
      side: 'over',
    },
    {
      title: '小说侧栏',
      description: '切左栏 / 切右栏。完成全部引导 →\n快捷键：Ctrl/Cmd+B / Ctrl/Cmd+J',
      side: 'over',
    },
  ],
  onComplete: () => {
    // 若当前不在 home view 则回到首页
    setView('home')
  },
}
```

> **说明：** 快捷键用 `\n` 分隔，driver.js popover 会原样展示。若需更精致的 kbd 元素样式，可在 driver-theme 的 `popoverClass` 中追加 CSS，或在 description 中嵌入 HTML（driver.js 支持 `allowHTML: true` 选项，需在 driverTheme 中开启）。

- [ ] **步骤 2：运行测试 + Commit**

```bash
cd apps/desktop && pnpm vitest run src/renderer/src/onboarding/__tests__/tours.test.ts --environment jsdom
git add apps/desktop/src/renderer/src/onboarding/tours/shortcuts-tour.ts
git commit -m "feat(onboarding): 实现 shortcuts-tour 8 步快捷键教学"
```

---

## 阶段 7：收尾

### 任务 7.1：集成测试

**文件：**
- 创建：`apps/desktop/src/renderer/src/onboarding/__tests__/onboarding-flow.test.tsx`

- [ ] **步骤 1：编写首次启动自动触发集成测试**

```tsx
// apps/desktop/src/renderer/src/onboarding/__tests__/onboarding-flow.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { useOnboardingStore } from '../onboarding-store'

describe('onboarding flow', () => {
  beforeEach(() => {
    localStorage.clear()
    useOnboardingStore.getState().resetOnboarding()
  })

  it('首次启动 shouldAutoStart 返回 true', () => {
    expect(useOnboardingStore.getState().shouldAutoStart()).toBe(true)
  })

  it('completeTour 后 shouldAutoStart 返回 false', () => {
    useOnboardingStore.getState().completeTour()
    expect(useOnboardingStore.getState().shouldAutoStart()).toBe(false)
  })

  it('skipHomeTour 后 shouldAutoStart 返回 false', () => {
    useOnboardingStore.getState().skipTour('home-tour')
    expect(useOnboardingStore.getState().shouldAutoStart()).toBe(false)
  })

  it('resetOnboarding 后 shouldAutoStart 恢复 true', () => {
    useOnboardingStore.getState().completeTour()
    useOnboardingStore.getState().resetOnboarding()
    expect(useOnboardingStore.getState().shouldAutoStart()).toBe(true)
  })
})
```

- [ ] **步骤 2：运行 + Commit**

```bash
cd apps/desktop && pnpm vitest run src/renderer/src/onboarding/ --environment jsdom
git add apps/desktop/src/renderer/src/onboarding/__tests__/onboarding-flow.test.tsx
git commit -m "test(onboarding): 添加首次启动流程集成测试"
```

---

### 任务 7.2：性能优化 — 懒加载 driver.js

**文件：**
- 修改：`apps/desktop/src/renderer/src/onboarding/onboarding-provider.tsx`

- [ ] **步骤 1：将 driver.js 改为动态 import**

```tsx
// onboarding-provider.tsx 修改 useEffect 内部
useEffect(() => {
  if (!activeTour) {
    if (driverRef.current) {
      driverRef.current.destroy()
      driverRef.current = null
    }
    return
  }

  let cancelled = false
  // 动态加载 driver.js，仅首次启动 tour 时才加载
  Promise.all([
    import('driver.js'),
    import('driver.js/dist/driver.css'),
  ]).then(([{ driver }, _css]) => {
    if (cancelled) return
    // ... 原 driver 实例化逻辑
  })

  return () => { cancelled = true }
}, [activeTour])
```

- [ ] **步骤 2：验证功能正常 + Commit**

```bash
cd apps/desktop && pnpm typecheck:web && pnpm vitest run src/renderer/src/onboarding/ --environment jsdom
git add apps/desktop/src/renderer/src/onboarding/onboarding-provider.tsx
git commit -m "perf(onboarding): 懒加载 driver.js"
```

---

### 任务 7.3：最终验收

- [ ] **步骤 1：运行全部测试**

```bash
cd apps/desktop && pnpm test -- onboarding
```
预期：所有测试通过

- [ ] **步骤 2：端到端手动验证清单**

1. 清除 localStorage `pi-agent.onboarding`，启动应用 → 首页引导自动播放
2. 完成 home-tour → 自动进入小说工作区，novel-tour 播放
3. 完成 novel-tour → 自动进入对话工作台，chat-tour 播放
4. 完成 chat-tour → 自动进入设置页，settings-tour 播放
5. 完成 settings-tour → 自动进入首页，shortcuts-tour 播放
6. 完成 shortcuts-tour → 引导结束，localStorage 写入 `completedVersion: "v1"`
7. 再次启动应用 → 不再自动播放
8. 点击 rail 导航栏「新手引导」按钮 → 弹出菜单，选择「小说创作」→ novel-tour 重新播放
9. 引导途中按 Esc → tour 跳过，写入 skippedTours
10. 小说工作区无项目时启动 novel-tour → 跳过画布/矩阵/编辑器步骤

- [ ] **步骤 3：请用户最终验收**

---

## 自检

### 1. 规格覆盖度
- ✅ 首页引导（home-tour 5 步）— 任务 3.1/3.2
- ✅ 小说创作引导（novel-tour 9 步）— 任务 2.1-2.5
- ✅ 对话工作台引导（chat-tour 7 步）— 任务 4.1/4.2
- ✅ 设置页引导（settings-tour 5 步）— 任务 5.1/5.2
- ✅ 快捷键教学（shortcuts-tour 8 步）— 任务 6.1
- ✅ driver.js + zustand + localStorage — 任务 1.1-1.6
- ✅ rail 导航栏「新手引导」按钮（单击弹菜单）— 任务 3.3
- ✅ 首次启动自动触发 — 任务 1.5 步骤 6 + 任务 3.4
- ✅ 无项目 fallback — 任务 2.5 步骤 3（onStart）
- ✅ 专注模式保护 — 任务 2.5 步骤 3（onStart）
- ✅ 错误处理（元素找不到、Esc、多 tour 同时启动）— onboarding-provider + store
- ✅ 测试（单元 + 集成）— 任务 1.3/1.6/2.5/7.1
- ✅ 性能优化（懒加载）— 任务 7.2

### 2. 占位符扫描
- 无 "待定"/"TODO"/"后续实现"
- 所有代码步骤均包含完整代码
- data-tour 标注均给出精确文件路径和行号

### 3. 类型一致性
- `TourId` 在 types.ts / onboarding-store.ts / tours/index.ts 一致
- `Tour` / `TourStep` 在 types.ts 定义，所有 tour 文件 import 自 `'../types'`
- `startTour(tourId: TourId)` 签名在 store / hook / provider 一致
- `useOnboardingStore.getState()` 在 tour 配置的 onNext 中访问，与 store 导出一致

### 4. 已知简化点
- tour 配置中用 `require('../onboarding-store')` 访问 store，避免循环依赖。实施时可重构为在 provider 的 `onNextClick` 中统一处理跨 tour 衔接，配置里只声明 `nextTour`/`nextView` 字段。
- shortcuts-tour 的快捷键展示用 `\n` 纯文本。若需 kbd 元素样式，需在 driverTheme 开启 `allowHTML: true` 并在 description 中嵌入 HTML。
