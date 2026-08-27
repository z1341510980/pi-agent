import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import type { BashOperations } from '@earendil-works/pi-coding-agent'

/** Windows 上可供 Agent bash 工具使用的终端类型。 */
export const TERMINAL_SHELLS = ['git-bash', 'pwsh', 'cmd', 'wsl'] as const
export type TerminalShell = (typeof TERMINAL_SHELLS)[number]

export const DEFAULT_TERMINAL_SHELL: TerminalShell = 'git-bash'

export function isTerminalShell(value: unknown): value is TerminalShell {
  return typeof value === 'string' && (TERMINAL_SHELLS as readonly string[]).includes(value)
}

export interface TerminalInvocation {
  file: string
  args: string[]
}

/**
 * 返回指定终端的进程启动方式。
 *
 * Pi SDK 默认统一追加 `-c`，而 cmd、PowerShell 和 WSL 的参数约定不同，
 * 因此由宿主负责组装 argv，仍复用 SDK 的输出与工具协议。
 */
export function getTerminalInvocation(
  shell: TerminalShell,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  command = '<command>',
  customShellPath?: string,
  cwd?: string
): TerminalInvocation {
  if (platform !== 'win32') {
    switch (shell) {
      case 'pwsh':
        return {
          file: 'pwsh',
          args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
        }
      case 'cmd':
      case 'wsl':
        return { file: 'sh', args: ['-c', command] }
      case 'git-bash':
      default:
        return { file: 'bash', args: ['-c', command] }
    }
  }

  switch (shell) {
    case 'pwsh':
      return {
        file: 'pwsh.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
      }
    case 'cmd':
      return { file: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
    case 'wsl':
      return {
        file: 'wsl.exe',
        args: ['--cd', toWslPath(cwd), '--', 'sh', '-lc', command]
      }
    case 'git-bash':
    default:
      return { file: customShellPath?.trim() || findGitBash(env), args: ['-c', command] }
  }
}

function toWslPath(cwd = process.cwd()): string {
  const windowsPath = /^([A-Za-z]):[\\/](.*)$/.exec(cwd)
  if (!windowsPath) return cwd.replace(/\\/g, '/')
  return `/mnt/${windowsPath[1].toLowerCase()}/${windowsPath[2].replace(/\\/g, '/')}`
}

function findGitBash(env: NodeJS.ProcessEnv): string {
  const configured = env.PI_GIT_BASH_PATH?.trim()
  if (configured) return configured

  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)']]) {
    if (!base) continue
    const candidate = join(base, 'Git', 'bin', 'bash.exe')
    if (existsSync(candidate)) return candidate
  }

  // 允许用户通过 PATH 使用 MSYS2、Cygwin 或自定义 Git Bash。
  return 'bash.exe'
}

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return

  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
      stdio: 'ignore',
      windowsHide: true
    })
    killer.once('error', () => child.kill())
    return
  }

  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode) => resolve(exitCode))
  })
}

/** 将终端选择适配为 Pi SDK bash 工具所需的流式执行接口。 */
export function createTerminalBashOperations(
  shell: TerminalShell,
  customShellPath?: string
): BashOperations {
  return {
    exec: async (command, cwd, options) => {
      if (options.signal?.aborted) throw new Error('aborted')

      const invocation = getTerminalInvocation(
        shell,
        process.platform,
        process.env,
        command,
        customShellPath,
        cwd
      )
      const child = spawn(invocation.file, invocation.args, {
        cwd,
        env: options.env ?? process.env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })

      child.stdout?.on('data', options.onData)
      child.stderr?.on('data', options.onData)

      let timedOut = false
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined
      const onAbort = (): void => killProcessTree(child)

      if (options.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true })
        if (options.signal.aborted) onAbort()
      }
      if (options.timeout !== undefined) {
        timeoutHandle = setTimeout(() => {
          timedOut = true
          killProcessTree(child)
        }, options.timeout * 1000)
      }

      try {
        const exitCode = await waitForChildProcess(child)
        if (options.signal?.aborted) throw new Error('aborted')
        if (timedOut) throw new Error(`timeout:${options.timeout}`)
        return { exitCode }
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle)
        options.signal?.removeEventListener('abort', onAbort)
      }
    }
  }
}

/** 注入到 Agent 系统提示词，确保模型使用当前终端的语法。 */
export function getTerminalPrompt(
  shell: TerminalShell,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== 'win32') {
    return `当前运行在 ${platform === 'darwin' ? 'macOS' : 'Linux'} 系统上，bash 工具使用标准 Unix shell。`
  }

  switch (shell) {
    case 'pwsh':
      return '当前运行在 Windows 系统上。bash 工具使用 PowerShell（pwsh），请使用 PowerShell 语法（如 Get-ChildItem、Get-Content、Select-Object）。'
    case 'cmd':
      return '当前运行在 Windows 系统上。bash 工具使用命令提示符（cmd.exe），请使用 cmd 语法（如 dir、type、findstr）。'
    case 'wsl':
      return '当前运行在 Windows 系统上。bash 工具使用 WSL 中的 Linux shell，请使用 Unix/bash 语法（如 ls、cat、grep）。'
    case 'git-bash':
    default:
      return '当前运行在 Windows 系统上。bash 工具使用 Git Bash，请使用 Unix/bash 语法（如 ls、cat、grep），不要使用 PowerShell 语法。'
  }
}
