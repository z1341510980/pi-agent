/**
 * 嵌入式 Agent Server
 *
 * 通过 spawn() 启动 agent-server 子进程：
 * - 开发模式：用系统 Node.js + tsx 运行 TypeScript 源码
 * - 生产模式：用 ELECTRON_RUN_AS_NODE 复用 Electron 内置 Node.js，
 *   运行 bytenode 编译的 .jsc 字节码（防反编译）
 *
 * 生产模式不依赖系统 Node.js，且 better-sqlite3 经 electron-rebuild
 * 后与 Electron ABI 一致，无 Module version mismatch 问题。
 * 后端崩溃不会影响 Electron 主进程，且可自动重启。
 */

import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { app } from 'electron'

/** agent-server 子进程 */
let serverProcess: ChildProcess | null = null

/** 端口解析 Promise 的 resolve 函数 */
let portResolve: ((port: number) => void) | null = null

/** 自动重启定时器 */
let restartTimer: NodeJS.Timeout | null = null

/** 是否已主动停止（避免主动停止后触发自动重启） */
let stopped = false

/**
 * 启动嵌入式后端服务，返回实际监听端口。
 *
 * 使用 spawn() 启动 agent-server 子进程：
 * - 开发模式：用系统 Node.js + tsx 运行 TypeScript 源码
 * - 生产模式：用 ELECTRON_RUN_AS_NODE 复用 Electron 内置 Node.js 运行 bytenode 字节码
 */
export async function startEmbeddedServer(): Promise<number> {
  stopped = false
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
    // 生产模式：复用 Electron 内置 Node.js（ELECTRON_RUN_AS_NODE=1）
    // 运行 bytenode 字节码 loader，源码不落盘
    const serverDir = join(process.resourcesPath, 'server')
    const loaderPath = join(serverDir, 'loader.cjs')
    // process.execPath 是 Electron exe，设置 ELECTRON_RUN_AS_NODE 后作为 Node.js 运行
    serverProcess = spawn(process.execPath, [loaderPath], {
      cwd: serverDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // 关键：让 Electron 进程以纯 Node.js 模式运行
        ELECTRON_RUN_AS_NODE: '1',
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
    if (stopped) return
    // 3 秒后自动重启
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = setTimeout(() => {
      if (!serverProcess && !stopped) {
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
  stopped = true
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  if (serverProcess) {
    serverProcess.kill('SIGTERM')
    serverProcess = null
  }
}
