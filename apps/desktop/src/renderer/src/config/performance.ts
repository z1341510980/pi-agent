/**
 * 前端运行时性能配置（借鉴 PlotPilot frontend/src/config/performance.ts）
 *
 * 集中管理散落各处的性能数字：
 * - matrix onScroll 节流（默认 16ms = 60fps）
 * - SSE 流式 delta 累积是否用 rAF 批处理
 * - 编辑器 debounce（默认 500ms）
 * - Undo/Redo 历史栈上限（默认 200）
 *
 * env 覆盖使用 Vite 的 import.meta.env，前缀 VITE_。
 */

interface MatrixPerfConfig {
  /** onScroll 节流（毫秒，默认 16 = 60fps） */
  readonly scrollThrottleMs: number
  /** 水平虚拟化 overscan（默认 3 列） */
  readonly overscanColumns: number
  /** 垂直虚拟化 overscan（默认 6 行） */
  readonly overscanRows: number
}

interface SsePerfConfig {
  /** 是否使用 rAF 批处理 delta（默认 true） */
  readonly useRafBatching: boolean
  /** 单帧累积 delta 上限（超出立即 flush，默认 256 字符） */
  readonly rafFlushCharLimit: number
}

interface EditorPerfConfig {
  /** 编辑器 debounce（毫秒，默认 500） */
  readonly debounceMs: number
}

interface UndoPerfConfig {
  /** Undo 历史栈上限（默认 200） */
  readonly historyLimit: number
}

export interface RuntimePerformanceConfig {
  readonly matrix: MatrixPerfConfig
  readonly sse: SsePerfConfig
  readonly editor: EditorPerfConfig
  readonly undo: UndoPerfConfig
}

function readEnvInt(key: string, defaultValue: number): number {
  const v = import.meta.env[key]
  if (v == null || v === '') return defaultValue
  const n = Number.parseInt(String(v), 10)
  if (!Number.isFinite(n) || n < 0) return defaultValue
  return n
}

function readEnvBool(key: string, defaultValue: boolean): boolean {
  const v = import.meta.env[key]
  if (v == null || v === '') return defaultValue
  if (v === 'true' || v === '1') return true
  if (v === 'false' || v === '0') return false
  return defaultValue
}

function buildConfig(): RuntimePerformanceConfig {
  return {
    matrix: {
      scrollThrottleMs: readEnvInt('VITE_MATRIX_SCROLL_THROTTLE_MS', 16),
      overscanColumns: readEnvInt('VITE_MATRIX_OVERSCAN_COLUMNS', 3),
      /**
       * 垂直方向的行 overscan。
       *
       * 与列分开配置：行高（28~40px）远小于列宽（56px 起），且长篇的行数
       * 增长比列数快得多，两者的合适缓冲量不同。
       */
      overscanRows: readEnvInt('VITE_MATRIX_OVERSCAN_ROWS', 6),
    },
    sse: {
      useRafBatching: readEnvBool('VITE_SSE_USE_RAF_BATCHING', true),
      rafFlushCharLimit: readEnvInt('VITE_SSE_RAF_FLUSH_CHAR_LIMIT', 256),
    },
    editor: {
      debounceMs: readEnvInt('VITE_EDITOR_DEBOUNCE_MS', 500),
    },
    undo: {
      historyLimit: readEnvInt('VITE_UNDO_HISTORY_LIMIT', 200),
    },
  }
}

/** 深冻结对象，防止运行时被意外修改（递归冻结内层对象） */
function deepFreeze<T>(obj: T): T {
  if (obj == null || typeof obj !== 'object') return obj
  for (const key of Object.keys(obj)) {
    const v = (obj as Record<string, unknown>)[key]
    if (typeof v === 'object' && v !== null) deepFreeze(v)
  }
  return Object.freeze(obj) as T
}

/**
 * 将 cfg 的顶层字段写入 target，使用 Object.defineProperty + configurable: true，
 * 既保证运行时不可写（writable: false），又允许 reloadPerformanceFromEnv
 * 后续重新覆盖。内层对象通过 deepFreeze 完全锁定。
 */
function applyConfig(target: RuntimePerformanceConfig, cfg: RuntimePerformanceConfig): void {
  for (const key of Object.keys(cfg) as Array<keyof RuntimePerformanceConfig>) {
    Object.defineProperty(target, key, {
      value: deepFreeze(cfg[key]),
      writable: false,
      configurable: true, // 允许下次 reload 再次覆盖
      enumerable: true,
    })
  }
}

export const runtimePerformance: RuntimePerformanceConfig = (() => {
  const target = {} as RuntimePerformanceConfig
  applyConfig(target, buildConfig())
  return target
})()

/**
 * 从环境变量重新加载配置
 * 用于测试或运行时热更新 env 后刷新
 *
 * 实现说明：runtimePerformance 顶层字段在初始化时通过 Object.defineProperty
 * 配置为 configurable: true，因此可以再次覆盖；内层对象已被 deepFreeze，
 * 重新加载时整体替换为新冻结的实例。
 */
export function reloadPerformanceFromEnv(): void {
  applyConfig(runtimePerformance, buildConfig())
}
