/**
 * 示例插件：Hello Plugin
 *
 * 演示如何使用插件 SDK 注册：
 * 1. 工具：hello.greet — 简单问候工具
 * 2. 路由：GET /api/plugins/hello/status — 返回插件状态
 *         POST /api/plugins/hello/greet — 调用问候
 * 3. 事件监听：监听 agent:run:started 事件
 * 4. UI 面板：hello-panel — 前端展示面板
 *
 * 此插件作为内置示例插件，由 PluginManager 直接注册，不需要文件加载
 */

import { success } from '../../../lib/api-response.js'
import type { Plugin } from '../../../core/plugin/plugin-types.js'

/** 创建 Hello 插件实例 */
export function createHelloPlugin(): Plugin {
  // 插件内部状态（封装在工厂闭包中，避免模块级污染）
  let greetCount = 0
  let lastEvent: { type: string; time: number } | null = null

  return {
    manifest: {
      name: 'hello',
      version: '1.0.0',
      description: '示例插件：演示工具、路由、事件监听、UI 面板注册',
      author: 'wenlang-agent',
      builtin: true
    },

    async setup(context) {
      const { logger, registerTool, registerRoute, onEvent, registerPanel, registerSettings } =
        context

      logger.info('Hello 插件启动')

      // 1. 注册工具：hello.greet
      registerTool({
        name: 'hello.greet',
        description: '向指定对象发送问候。可指定语言和重复次数。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '问候对象名称' },
            language: { type: 'string', description: '问候语言：zh / en' },
            times: { type: 'number', description: '重复次数（默认 1，最大 10）' }
          },
          required: ['name']
        },
        async execute(args) {
          const name = String(args.name ?? 'world')
          const language = String(args.language ?? 'zh')
          const times = Math.max(1, Math.min(10, Number(args.times ?? 1)))

          greetCount += times

          const messages: string[] = []
          for (let i = 0; i < times; i++) {
            if (language === 'en') {
              messages.push(`Hello, ${name}!`)
            } else {
              messages.push(`你好，${name}！`)
            }
          }

          logger.info({ name, language, times }, '执行 hello.greet 工具')

          return {
            ok: true,
            data: { messages, greetCount }
          }
        }
      })

      // 2. 注册路由：GET /status（实际路径 /api/plugins/hello/status）
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerRoute({
        method: 'GET',
        path: '/status',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async handler(request: any) {
          return success(
            {
              plugin: 'hello',
              version: '1.0.0',
              status: 'running',
              greetCount,
              lastEvent
            },
            request.traceId
          )
        }
      })

      // 3. 注册路由：POST /greet（实际路径 /api/plugins/hello/greet）
      registerRoute({
        method: 'POST',
        path: '/greet',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async handler(request: any) {
          const { name = 'world', language = 'zh', times = 1 } = request.body ?? {}
          const t = Math.max(1, Math.min(10, Number(times)))
          greetCount += t

          const messages: string[] = []
          for (let i = 0; i < t; i++) {
            if (language === 'en') {
              messages.push(`Hello, ${name}!`)
            } else {
              messages.push(`你好，${name}！`)
            }
          }

          return success({ messages, greetCount }, request.traceId)
        }
      })

      // 4. 监听事件：agent:run:started
      onEvent('agent:run:started', (data) => {
        lastEvent = { type: 'agent:run:started', time: Date.now() }
        logger.info({ data }, '收到 agent:run:started 事件')
      })

      // 5. 注册 UI 面板：挂在插件管理页顶部（不占主界面左侧导航）
      registerPanel({
        id: 'hello-panel',
        title: 'Hello 插件面板',
        component: 'HelloPanel',
        rendererKey: 'builtin.hello-panel',
        slot: 'plugin-page.top',
        scope: 'app',
        priority: 100,
        props: { initialGreetCount: greetCount }
      })

      // 6. 声明式设置：桌面设置中心自动生成"插件设置 → hello"分区，
      //    表单读写走 GET/PATCH /api/plugins/hello/config（写回 plugins.yml）
      registerSettings([
        {
          key: 'greetingName',
          label: '默认问候对象',
          type: 'string',
          default: 'world',
          placeholder: 'world',
          description: '未显式指定 name 时使用的问候对象'
        },
        {
          key: 'greetingLanguage',
          label: '默认问候语言',
          type: 'select',
          default: 'zh',
          options: [
            { value: 'zh', label: '中文' },
            { value: 'en', label: 'English' }
          ],
          description: '未显式指定 language 时使用的语言'
        }
      ])

      logger.info('Hello 插件注册完成')
    },

    async teardown() {
      // 重置内部状态
      greetCount = 0
      lastEvent = null
    }
  }
}

/** 默认导出：插件工厂函数 */
export default createHelloPlugin
