/**
 * 嵌入式 Agent Server
 *
 * 通过 spawn() 使用系统 Node.js 在子进程中启动 agent-server，
 * 避免继承 Electron 的 Node.js 运行时导致原生模块 ABI 不兼容。
 * 后端崩溃不会影响 Electron 主进程，且可自动重启。
 */

import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { app } from 'electron'

/** agent-server 子进程 */
let serverProcess: ChildProcess | null = null

/** 端口解析 Promise 的 resolve 函数 */
let portResolve: ((port: number) => void) | null = null

/**
 * 启动嵌入式后端服务，返回实际监听端口。
 *
 * 使用 spawn() + 系统 Node.js 启动 agent-server 子进程：
 * - 开发模式：用 tsx 运行源码
 * - 生产模式：运行编译后的 JS
 */
export async function startEmbeddedServer(): Promise<number> {
  const portPromise = new Promise<number>((resolve) => {
    portResolve = resolve
  })

  const isDev = !app.isPackaged

  if (isDev) {
    // 开发模式：用系统 Node.js + tsx 运行 TypeScript 源码
    const serverSrc = join(__dirname, '../../../agent-server/src/index.ts')
    const serverDir = join(__dirname, '../../../agent-server')
    serverProcess = spawn('node', ['--import', 'tsx', serverSrc], {
      cwd: serverDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PI_HOST: '127.0.0.1',
        PI_PORT: '0',
        PI_CWD: process.env.PI_CWD ?? process.cwd(),
      },
    })
  } else {
    // 生产模式：用系统 Node.js 运行编译后的 JS
    const serverDist = join(__dirname, '../../../agent-server/dist/index.js')
    const serverDir = join(__dirname, '../../../agent-server')
    serverProcess = spawn('node', [serverDist], {
      cwd: serverDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PI_HOST: '127.0.0.1',
        PI_PORT: '0',
        PI_CWD: process.env.PI_CWD ?? process.cwd(),
      },
    })
  }

  // 监听子进程 stdout，解析端口号
  serverProcess.stdout?.on('data', (data: Buffer) => {
    const output = data.toString()
    // Fastify 默认日志格式：{"level":30,"...","msg":"Server listening at http://127.0.0.1:xxxxx"}
    const portMatch = output.match(/listening at http:\/\/[\d.]+:(\d+)/)
    if (portMatch) {
      const port = parseInt(portMatch[1], 10)
      portResolve?.(port)
    }
    // 转发日志到主进程控制台
    console.log('[agent-server]', output.trim())
  })

  serverProcess.stderr?.on('data', (data: Buffer) => {
    console.error('[agent-server]', data.toString().trim())
  })

  // 子进程崩溃时自动重启
  serverProcess.on('exit', (code, signal) => {
    console.error(`[agent-server] 进程退出: code=${code}, signal=${signal}`)
    serverProcess = null
    // 3 秒后自动重启
    setTimeout(() => {
      if (!serverProcess) {
        console.log('[agent-server] 自动重启...')
        void startEmbeddedServer()
      }
    }, 3000)
  })

  // 等待端口解析，超时 15 秒
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('等待 agent-server 启动超时')), 15_000)
  })

  return Promise.race([portPromise, timeout])
}

/**
 * 停止嵌入式后端服务
 */
export function stopEmbeddedServer(): void {
  if (serverProcess) {
    serverProcess.kill('SIGTERM')
    serverProcess = null
  }
}
