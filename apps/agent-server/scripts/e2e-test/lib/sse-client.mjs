/**
 * SSE 流式响应客户端
 *
 * 用于消费 novel-plugin 的 ai-arrange / create-flow 端点返回的 text/event-stream。
 * 不依赖任何第三方包，仅用 Node.js 内置 fetch + ReadableStream。
 *
 * 使用方式：
 *   const sse = new SseClient(url, init)
 *   const stop = sse.start({
 *     onEvent: (event) => { ... },     // 每个 SSE 事件回调
 *     onError: (err) => { ... },      // 网络错误
 *     onClose: () => { ... },         // 流结束
 *   })
 *   // 主动停止：await stop()
 *
 * 解析规则：
 *   - 按 \n\n 分隔事件块
 *   - 行首 "data: " 提取数据部分，JSON.parse
 *   - 行首 ":" 是注释（如 keepalive 心跳），忽略
 *   - 空行分隔事件
 */

export class SseClient {
  constructor(url, init = {}) {
    this.url = url
    this.init = init
    this.controller = null
    this.reader = null
    this.buffer = ''
    this.stopped = false
  }

  /**
   * 启动 SSE 流消费
   * @param {{onEvent: (event: any) => void, onError?: (err: Error) => void, onClose?: () => void}} handlers
   * @returns {Promise<void>} 流结束时 resolve
   */
  start(handlers) {
    this.stopped = false
    this._promise = (async () => {
      this.controller = new AbortController()
      try {
        const response = await fetch(this.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            ...(this.init.headers || {}),
          },
          body: JSON.stringify(this.init.body || {}),
          signal: this.controller.signal,
        })

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${await response.text()}`)
        }
        if (!response.body) {
          throw new Error('响应没有 body 流')
        }

        this.reader = response.body.getReader()
        const decoder = new TextDecoder('utf-8')

        while (!this.stopped) {
          const { done, value } = await this.reader.read()
          if (done) break
          this.buffer += decoder.decode(value, { stream: true })
          this._processBuffer(handlers)
        }
      } catch (err) {
        if (err.name === 'AbortError' || this.stopped) {
          // 主动停止不算错误
        } else if (handlers.onError) {
          // 附加上下文信息帮助诊断
          err.detailedInfo = {
            url: this.url,
            stopped: this.stopped,
            errName: err.name,
            errCode: err.code,
            cause: err.cause?.message || err.cause?.code,
          }
          handlers.onError(err)
        } else {
          throw err
        }
      } finally {
        if (handlers.onClose) handlers.onClose()
      }
    })()
    return this._promise
  }

  /** 主动停止 SSE 流 */
  async stop() {
    this.stopped = true
    if (this.controller) this.controller.abort()
    if (this.reader) {
      try {
        await this.reader.cancel()
      } catch {
        /* 忽略 */
      }
    }
    if (this._promise) await this._promise
  }

  _processBuffer(handlers) {
    // 按 \n\n 分隔事件块（SSE 规范）
    let idx
    while ((idx = this.buffer.indexOf('\n\n')) >= 0) {
      const chunk = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 2)
      this._dispatchEvent(chunk, handlers)
    }
  }

  _dispatchEvent(chunk, handlers) {
    const lines = chunk.split('\n')
    const dataLines = []
    for (const line of lines) {
      if (!line) continue
      if (line.startsWith(':')) continue // 注释/心跳
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart())
      }
      // 其他字段（event:/id:/retry:）暂不处理
    }
    if (dataLines.length === 0) return
    const raw = dataLines.join('\n')
    try {
      const event = JSON.parse(raw)
      handlers.onEvent(event)
    } catch {
      // 非 JSON 数据，原样推送
      handlers.onEvent({ _raw: raw })
    }
  }
}
