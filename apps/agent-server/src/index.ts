import 'dotenv/config'
import { createApp } from './app.js'

async function main(): Promise<void> {
  const app = await createApp()

  try {
    const host = process.env.PI_HOST ?? '127.0.0.1'
    const port = parseInt(process.env.PI_PORT ?? '3900', 10)

    await app.listen({ host, port })

    app.log.info(`Agent Server 运行于 http://${host}:${port}`)
    app.log.info(`  AG-UI info:       http://${host}:${port}/ag-ui/info`)
    app.log.info(`  AG-UI run:        http://${host}:${port}/ag-ui/agent/default/run`)
    app.log.info(`  AG-UI steer:      http://${host}:${port}/ag-ui/agent/default/steer`)
    app.log.info(`  AG-UI follow-up:  http://${host}:${port}/ag-ui/agent/default/follow-up`)
    app.log.info(`  AG-UI fork:       http://${host}:${port}/ag-ui/agent/default/fork`)
    app.log.info(`  AG-UI navigate:   http://${host}:${port}/ag-ui/agent/default/navigate`)
    app.log.info(`  AG-UI reload:     http://${host}:${port}/ag-ui/agent/default/reload`)
    app.log.info(`  AG-UI tree:       http://${host}:${port}/ag-ui/agent/default/tree?threadId=...`)
    app.log.info(`  AG-UI models:     http://${host}:${port}/ag-ui/agent/default/models?threadId=...`)
    app.log.info(`  AG-UI tools:      http://${host}:${port}/ag-ui/agent/default/tools?threadId=...`)
    app.log.info(`  Health:           http://${host}:${port}/api/health`)
    app.log.info(`  CopilotKit (弃用): http://${host}:${port}/copilotkit/*`)

    // 全局兜底：防止未捕获的异常导致进程崩溃
    process.on('uncaughtException', (err) => {
      app.log.error({ err }, '未捕获的异常')
    })

    // 优雅关闭
    const shutdown = async (signal: string) => {
      app.log.info(`收到 ${signal}，正在关闭...`)
      await app.close()
      process.exit(0)
    }

    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
  } catch (error) {
    app.log.error(error)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Agent Server 启动失败:', err)
  process.exit(1)
})
