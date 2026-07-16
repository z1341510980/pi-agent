/**
 * 后端运行时性能配置（借鉴 PlotPilot frontend/src/config/performance.ts）
 *
 * 集中管理散落各处的性能数字：
 * - LLM 调用超时（默认 300s）
 * - 熔断器阈值（失败 5 次开路 120s）
 * - SSE 节流与队列上限
 * - SQLite 写入重试
 *
 * 所有值可通过环境变量覆盖，便于调优和压测。
 * 环境变量命名约定：PI_<域>_<字段名> 大写下划线。
 */

interface LlmPerfConfig {
  /** LLM 调用超时（毫秒），默认 300s（与 Memory Agent 一致） */
  readonly timeoutMs: number
  /** LLM 调用熔断器配置 */
  readonly circuitBreaker: {
    /** 失败多少次后开路（默认 5） */
    readonly failureThreshold: number
    /** 开路后多久尝试半开（毫秒，默认 120s） */
    readonly resetTimeoutMs: number
  }
}

interface SsePerfConfig {
  /** SSE 事件节流（毫秒，默认 100ms） */
  readonly throttleMs: number
  /** SSE 事件队列上限（默认 50，超出后丢弃最旧事件） */
  readonly maxQueueSize: number
}

interface PersistencePerfConfig {
  /** SQLite 写入重试次数（默认 3） */
  readonly writeRetryCount: number
  /** SQLite 写入重试退避基数（毫秒，默认 50） */
  readonly writeRetryBackoffMs: number
}

export interface RuntimePerformanceConfig {
  readonly llm: LlmPerfConfig
  readonly sse: SsePerfConfig
  readonly persistence: PersistencePerfConfig
}

function readEnvInt(key: string, defaultValue: number): number {
  const v = process.env[key]
  if (v == null || v === '') return defaultValue
  const n = Number.parseInt(v, 10)
  if (!Number.isFinite(n) || n < 0) return defaultValue
  return n
}

function buildConfig(): RuntimePerformanceConfig {
  return {
    llm: {
      timeoutMs: readEnvInt('PI_LLM_TIMEOUT_MS', 300_000),
      circuitBreaker: {
        failureThreshold: readEnvInt('PI_LLM_CIRCUIT_FAILURE_THRESHOLD', 5),
        resetTimeoutMs: readEnvInt('PI_LLM_CIRCUIT_RESET_TIMEOUT_MS', 120_000),
      },
    },
    sse: {
      throttleMs: readEnvInt('PI_SSE_THROTTLE_MS', 100),
      maxQueueSize: readEnvInt('PI_SSE_MAX_QUEUE_SIZE', 50),
    },
    persistence: {
      writeRetryCount: readEnvInt('PI_SQLITE_WRITE_RETRY_COUNT', 3),
      writeRetryBackoffMs: readEnvInt('PI_SQLITE_WRITE_BACKOFF_MS', 50),
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

/** 设置页热更新 LLM 超时，同时保留其他运行时性能配置。 */
export function setRuntimeLlmTimeoutMs(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) {
    throw new RangeError('LLM timeoutMs 必须是大于等于 1000 的整数')
  }
  applyConfig(runtimePerformance, {
    ...runtimePerformance,
    llm: {
      ...runtimePerformance.llm,
      timeoutMs,
    },
  })
}
