import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TERMINAL_SHELL,
  getTerminalInvocation,
  getTerminalPrompt,
  isTerminalShell
} from './terminal-shell.js'

describe('terminal shell configuration', () => {
  const command = 'echo hello'

  it('recognizes supported terminal values and falls back to Git Bash by default', () => {
    expect(DEFAULT_TERMINAL_SHELL).toBe('git-bash')
    expect(isTerminalShell('git-bash')).toBe(true)
    expect(isTerminalShell('pwsh')).toBe(true)
    expect(isTerminalShell('cmd')).toBe(true)
    expect(isTerminalShell('wsl')).toBe(true)
    expect(isTerminalShell('powershell')).toBe(false)
  })

  it('builds Windows-specific invocations', () => {
    expect(getTerminalInvocation('git-bash', 'win32', {}, command)).toEqual({
      file: 'bash.exe',
      args: ['-c', command]
    })
    expect(
      getTerminalInvocation('git-bash', 'win32', {}, command, 'C:\\Git\\bin\\bash.exe')
    ).toEqual({
      file: 'C:\\Git\\bin\\bash.exe',
      args: ['-c', command]
    })
    expect(getTerminalInvocation('pwsh', 'win32', {}, command)).toEqual({
      file: 'pwsh.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
    })
    expect(
      getTerminalInvocation('cmd', 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, command)
    ).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', command]
    })
    expect(
      getTerminalInvocation('wsl', 'win32', {}, command, undefined, 'C:\\work\\project')
    ).toEqual({
      file: 'wsl.exe',
      args: ['--cd', '/mnt/c/work/project', '--', 'sh', '-lc', command]
    })
  })

  it('uses the portable Unix fallback outside Windows', () => {
    expect(getTerminalInvocation('git-bash', 'linux', {}, command)).toEqual({
      file: 'bash',
      args: ['-c', command]
    })
    expect(getTerminalInvocation('pwsh', 'linux', {}, command).args).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command
    ])
    expect(getTerminalInvocation('cmd', 'linux', {}, command)).toEqual({
      file: 'sh',
      args: ['-c', command]
    })
  })

  it('describes the selected syntax to the model', () => {
    expect(getTerminalPrompt('pwsh', 'win32')).toContain('PowerShell')
    expect(getTerminalPrompt('cmd', 'win32')).toContain('cmd.exe')
    expect(getTerminalPrompt('wsl', 'win32')).toContain('WSL')
    expect(getTerminalPrompt('git-bash', 'win32')).toContain('Git Bash')
  })
})
