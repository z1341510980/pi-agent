type EventHandler<T = unknown> = (data: T) => void

/**
 * 进程内事件总线
 * 支持订阅/取消订阅/一次性订阅/异常隔离
 */
export class EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>()

  /** 订阅事件 */
  on<T = unknown>(event: string, handler: EventHandler<T>): void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(handler as EventHandler)
  }

  /** 取消订阅 */
  off<T = unknown>(event: string, handler: EventHandler<T>): void {
    this.handlers.get(event)?.delete(handler as EventHandler)
  }

  /** 一次性订阅 */
  once<T = unknown>(event: string, handler: EventHandler<T>): void {
    const wrapper: EventHandler<T> = (data) => {
      this.off(event, wrapper)
      handler(data)
    }
    this.on(event, wrapper)
  }

  /** 发布事件，处理器异常不影响其他处理器 */
  emit<T = unknown>(event: string, data: T): void {
    const set = this.handlers.get(event)
    if (!set) return
    for (const handler of set) {
      try {
        handler(data)
      } catch {
        // 异常隔离：不中断其他处理器
      }
    }
  }
}
