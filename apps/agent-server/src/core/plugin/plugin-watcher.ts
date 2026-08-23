/**
 * 插件文件监视器（热更新）
 *
 * 职责：
 * 1. 监视 local/npm 插件入口文件所在目录的变更
 * 2. 按插件去抖：编辑器一次保存往往触发多次事件（临时文件 + 原子替换），
 *    去抖窗口内只重载一次
 * 3. 合并并发重载：上一次 reload 尚未结束时再次触发改为顺延重试，
 *    避免并发 reload 破坏 PluginManager 注册表状态
 *
 * 实现说明：
 * - 使用 node:fs 原生 watch，不引入 chokidar 等额外依赖。
 * - 优先 recursive 监听插件包目录（Windows / macOS 支持）；平台不支持时
 *   降级为仅监听目录一层（部分 Linux），子目录变更可能漏报，属已知限制。
 *
 * @module core/plugin/plugin-watcher
 */

import { watch, type FSWatcher } from 'node:fs'
import { dirname } from 'node:path'
import type { FastifyBaseLogger } from 'fastify'

/** 重载回调签名：由调用方（plugin-loader）绑定到 PluginManager.reload */
export type ReloadTrigger = (pluginId: string) => Promise<void>

export interface PluginWatcherOptions {
  /** 变更去抖毫秒数（默认 500） */
  debounceMs?: number
}

/** 编辑器/系统产生的非源码变更，忽略以避免无意义重载 */
function shouldIgnoreChange(filename: string | null): boolean {
  if (!filename) return false
  const base = filename.split(/[\\/]/).pop() ?? ''
  return (
    base.startsWith('.#') ||
    base.endsWith('~') ||
    /^\..*\.swp$/.test(base) ||
    /\.(tmp|bak)$/.test(base) ||
    base === '.DS_Store' ||
    base === 'Thumbs.db'
  )
}

export class PluginWatcher {
  /** 监听根目录 → FSWatcher */
  private readonly watchers = new Map<string, FSWatcher>()
  /** 监听根目录 → 该目录下登记的插件集合 */
  private readonly rootPlugins = new Map<string, Set<string>>()
  /** 插件 → 去抖定时器 */
  private readonly timers = new Map<string, NodeJS.Timeout>()
  /** 正在执行 reload 回调的插件 */
  private readonly inflight = new Set<string>()
  /** 在途回调的 promise 集合，close 时排空 */
  private readonly inflightTasks = new Set<Promise<void>>()
  private closed = false

  constructor(
    private readonly logger: FastifyBaseLogger,
    private readonly onReload: ReloadTrigger,
    private readonly options: PluginWatcherOptions = {}
  ) {}

  /**
   * 登记一个插件的监视目标。
   *
   * @param filePath 插件入口文件（用于缺省推导航运根目录）
   * @param scopeDir 监视范围根目录；缺省取入口文件所在目录。
   *   npm 插件的 main 可能指向 dist/，应传包根目录避免漏监视包内其他目录。
   *
   * 多个插件共享同一根目录时复用同一个 watcher，事件会分别去抖到各自的
   * 重载回调（无模块图无法按文件归因，同根目录插件共同触发属预期行为）。
   */
  add(pluginId: string, filePath: string, scopeDir?: string): void {
    if (this.closed) {
      this.logger.warn({ pluginId }, 'PluginWatcher 已关闭，忽略监视登记')
      return
    }
    const root = scopeDir ?? dirname(filePath)
    let pluginIds = this.rootPlugins.get(root)
    if (!pluginIds) {
      pluginIds = new Set()
      this.rootPlugins.set(root, pluginIds)
    }
    if (pluginIds.has(pluginId)) return
    pluginIds.add(pluginId)
    if (this.watchers.has(root)) return

    const handleChange = (_event: string, filename: string | null): void => {
      if (shouldIgnoreChange(filename)) return
      for (const id of this.rootPlugins.get(root) ?? []) this.schedule(id)
    }
    const handleError = (err: unknown): void => {
      // 监听句柄失效（目录被删、句柄耗尽等）：停止该根目录并如实上报，
      // 不能让 watcher 静默变成"看起来在监视实际已失联"的状态。
      this.logger.warn({ root, err }, '插件文件监视器异常，停止监听该目录')
      this.removeRoot(root)
    }

    try {
      let watcher: FSWatcher
      try {
        watcher = watch(root, { recursive: true })
      } catch {
        this.logger.debug({ root }, '当前平台不支持递归监听，降级为单层目录监听')
        watcher = watch(root)
      }
      watcher.on('change', handleChange)
      watcher.on('error', handleError)
      this.watchers.set(root, watcher)
      this.logger.debug({ root, pluginId }, '已监视插件目录')
    } catch (err) {
      // 目录不存在等启动失败：登记作废，不影响其他插件
      pluginIds.delete(pluginId)
      this.logger.warn({ root, pluginId, err }, '插件目录监视失败')
      if (pluginIds.size === 0) this.rootPlugins.delete(root)
    }
  }

  /**
   * 摘除一个插件的监视登记（运行期 disable 时调用）。
   *
   * 禁用的第三方代码不应因磁盘变更被重新 import。该插件独占的监听根会一并关闭；
   * 同时丢弃它尚未触发的去抖任务。在途重载不打断 —— reload 会按 desiredEnabled
   * 决定是否启动，禁用后只重登记不 setup，语义安全。
   */
  remove(pluginId: string): void {
    for (const [root, pluginIds] of [...this.rootPlugins]) {
      if (!pluginIds.delete(pluginId)) continue
      const timer = this.timers.get(pluginId)
      if (timer) {
        clearTimeout(timer)
        this.timers.delete(pluginId)
      }
      if (pluginIds.size === 0) this.removeRoot(root)
    }
  }

  /** 当前正在监视的目录数 */
  get watchedRootCount(): number {
    return this.watchers.size
  }

  /**
   * 排空：停止接受新事件，丢弃待处理任务，并等待在途重载结束。
   *
   * dsh 的 quiesce 纪律：dispose 必须先停事件再等在途操作结算，
   * 否则关闭流程之后还可能有迟到的 startPlugin 在写注册表。
   */
  async settle(): Promise<void> {
    this.closed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    await Promise.allSettled([...this.inflightTasks])
  }

  /**
   * 关闭所有监视句柄并排空在途任务。
   *
   * 句柄先释放（立即止血，不再有新事件），再等在途重载结算；
   * 关闭后的迟到事件一律忽略。
   */
  async close(): Promise<void> {
    for (const [root, watcher] of [...this.watchers]) {
      watcher.close()
      this.watchers.delete(root)
    }
    this.rootPlugins.clear()
    await this.settle()
  }

  /** 移除某个监听根及其插件映射 */
  private removeRoot(root: string): void {
    this.watchers.get(root)?.close()
    this.watchers.delete(root)
    this.rootPlugins.delete(root)
  }

  /** 去抖调度：窗口内重复触发只保留最后一次 */
  private schedule(pluginId: string, delay?: number): void {
    if (this.closed) return
    const existing = this.timers.get(pluginId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.timers.delete(pluginId)
      void this.run(pluginId)
    }, delay ?? this.options.debounceMs ?? 500)
    timer.unref?.()
    this.timers.set(pluginId, timer)
  }

  /** 执行重载回调；上次未结束时顺延重试而不是并发进入 */
  private async run(pluginId: string): Promise<void> {
    if (this.closed) return
    if (this.inflight.has(pluginId)) {
      this.schedule(pluginId, Math.min(2000, this.options.debounceMs ?? 500))
      return
    }
    this.inflight.add(pluginId)
    const task = (async () => {
      try {
        await this.onReload(pluginId)
      } catch (err) {
        this.logger.error({ pluginId, err }, '插件热更新回调执行失败')
      }
    })()
    void task.finally(() => {
      this.inflight.delete(pluginId)
      this.inflightTasks.delete(task)
    })
    this.inflightTasks.add(task)
  }
}
