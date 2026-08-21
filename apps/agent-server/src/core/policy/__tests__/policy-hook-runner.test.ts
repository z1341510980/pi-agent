/**
 * Policy Hook Runner 单元测试
 *
 * 测试覆盖：
 * - parseHookOutput: exit 0 JSON 解析、exit 2 阻断、expectedEventName 守卫
 * - mergeHookOutputs: deny > ask > allow 优先级、continue:false 粘性停止
 * - runHook: 无 shell argv 执行、环境白名单、cwd 校验、输出上限、超时/取消/启动失败区分
 *
 * @module core/policy/__tests__/policy-hook-runner.test
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  runHook,
  parseHookOutput,
  mergeHookOutputs,
  tokenizeCommand,
  buildHookEnv,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_HOOK_MAX_OUTPUT_BYTES,
} from '../policy-hook-runner.js'
import type { HookExecutionContext, HookOutput } from '../hook-types.js'

// ============================================================
// parseHookOutput 测试
// ============================================================

describe('parseHookOutput', () => {
  describe('exit 0 + JSON 结构化输出', () => {
    it('解析 continue:false 和 stopReason', () => {
      const stdout = JSON.stringify({ continue: false, stopReason: '用户取消' })
      const result = parseHookOutput(0, stdout, '')
      expect(result.continue).toBe(false)
      expect(result.stopReason).toBe('用户取消')
    })

    it('解析 systemMessage', () => {
      const stdout = JSON.stringify({ systemMessage: '请谨慎操作' })
      const result = parseHookOutput(0, stdout, '')
      expect(result.systemMessage).toBe('请谨慎操作')
    })

    it('解析 top-level decision: approve/block', () => {
      const stdout = JSON.stringify({ decision: 'block', reason: '危险操作' })
      const result = parseHookOutput(0, stdout, '')
      expect(result.decision).toBe('block')
      expect(result.reason).toBe('危险操作')
    })

    it('解析 hookSpecificOutput.permissionDecision: allow/deny/ask', () => {
      const stdout = JSON.stringify({
        hookSpecificOutput: {
          permissionDecision: 'deny',
          permissionDecisionReason: '权限不足',
          additionalContext: '用户是访客',
        },
      })
      const result = parseHookOutput(0, stdout, '')
      expect(result.decision).toBe('deny')
      expect(result.reason).toBe('权限不足')
      expect(result.additionalContext).toBe('用户是访客')
    })

    it('解析 updatedInput', () => {
      const stdout = JSON.stringify({
        hookSpecificOutput: {
          updatedInput: { query: 'foo', limit: 10 },
        },
      })
      const result = parseHookOutput(0, stdout, '')
      expect(result.updatedInput).toEqual({ query: 'foo', limit: 10 })
    })

    it('记录 hookEventName 判��器', () => {
      const stdout = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      })
      const result = parseHookOutput(0, stdout, '')
      expect(result.hookEventName).toBe('PreToolUse')
      expect(result.decision).toBe('allow')
    })
  })

  describe('expectedEventName 守卫', () => {
    it('匹配时保留事件字段', () => {
      const stdout = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          additionalContext: '拒绝执行',
        },
      })
      const result = parseHookOutput(0, stdout, '', 'PreToolUse')
      expect(result.decision).toBe('deny')
      expect(result.additionalContext).toBe('拒绝执行')
    })

    it('不匹配时丢弃事件字段', () => {
      const stdout = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          permissionDecision: 'deny',
          additionalContext: '应该被丢弃',
        },
      })
      const result = parseHookOutput(0, stdout, '', 'PreToolUse')
      // decision 不应该被设置，additionalContext 不应该存在
      expect(result.decision).toBeUndefined()
      expect(result.additionalContext).toBeUndefined()
      // hookEventName 仍然记录（用于诊断）
      expect(result.hookEventName).toBe('PostToolUse')
    })
  })

  describe('exit 0 + 非 JSON', () => {
    it('保留原文本，无结构化字段', () => {
      const stdout = '这是普通输出'
      const result = parseHookOutput(0, stdout, '')
      expect(result.stdout).toBe('这是普通输出')
      expect(result.continue).toBeUndefined()
      expect(result.decision).toBeUndefined()
    })
  })

  describe('exit 2 阻断', () => {
    it('exit 2 设置 decision: block，stderr 为 reason', () => {
      const result = parseHookOutput(2, '', '操作被拒绝')
      expect(result.decision).toBe('block')
      expect(result.reason).toBe('操作被拒绝')
    })
  })

  describe('其他 exit code', () => {
    it('exit 1 不阻断，仅记录', () => {
      const result = parseHookOutput(1, 'stdout', 'stderr')
      expect(result.exitCode).toBe(1)
      expect(result.decision).toBeUndefined()
      expect(result.stderr).toBe('stderr')
    })
  })

  describe('spawn 失败（exitCode undefined）', () => {
    it('返回 undefined exitCode，不阻断', () => {
      const result = parseHookOutput(undefined, '', 'command not found')
      expect(result.exitCode).toBeUndefined()
      expect(result.decision).toBeUndefined()
      expect(result.stderr).toBe('command not found')
    })
  })
})

// ============================================================
// mergeHookOutputs 测试
// ============================================================

describe('mergeHookOutputs', () => {
  it('空列表返回 neutral 结果', () => {
    const result = mergeHookOutputs([])
    expect(result.decision).toBe('none')
    expect(result.stop).toBe(false)
    expect(result.additionalContext).toEqual([])
    expect(result.systemMessages).toEqual([])
  })

  describe('决策优先级：deny > ask > allow', () => {
    it('deny 覆盖 allow', () => {
      const outputs: HookOutput[] = [
        { exitCode: 0, stdout: '', stderr: '', decision: 'allow' },
        { exitCode: 0, stdout: '', stderr: '', decision: 'deny', reason: '安全策略禁止' },
      ]
      const result = mergeHookOutputs(outputs)
      expect(result.decision).toBe('deny')
      expect(result.reason).toBe('安全策略禁止')
    })

    it('ask 覆盖 allow', () => {
      const outputs: HookOutput[] = [
        { exitCode: 0, stdout: '', stderr: '', decision: 'allow' },
        { exitCode: 0, stdout: '', stderr: '', decision: 'ask', reason: '需要确认' },
      ]
      const result = mergeHookOutputs(outputs)
      expect(result.decision).toBe('ask')
      expect(result.reason).toBe('需要确认')
    })

    it('deny 覆盖 ask', () => {
      const outputs: HookOutput[] = [
        { exitCode: 0, stdout: '', stderr: '', decision: 'ask', reason: '需要确认' },
        { exitCode: 0, stdout: '', stderr: '', decision: 'deny', reason: '安全策略禁止' },
      ]
      const result = mergeHookOutputs(outputs)
      expect(result.decision).toBe('deny')
      expect(result.reason).toBe('安全策略禁止')
    })

    it('多个 deny 合并 reason', () => {
      const outputs: HookOutput[] = [
        { exitCode: 0, stdout: '', stderr: '', decision: 'deny', reason: '原因1' },
        { exitCode: 0, stdout: '', stderr: '', decision: 'deny', reason: '原因2' },
      ]
      const result = mergeHookOutputs(outputs)
      expect(result.decision).toBe('deny')
      expect(result.reason).toBe('原因1\n\n原因2')
    })

    it('block 归一化为 deny', () => {
      const outputs: HookOutput[] = [
        { exitCode: 0, stdout: '', stderr: '', decision: 'block', reason: '被阻断' },
      ]
      const result = mergeHookOutputs(outputs)
      expect(result.decision).toBe('deny')
      expect(result.reason).toBe('被阻断')
    })

    it('approve 归一化为 allow', () => {
      const outputs: HookOutput[] = [
        { exitCode: 0, stdout: '', stderr: '', decision: 'approve' },
      ]
      const result = mergeHookOutputs(outputs)
      expect(result.decision).toBe('allow')
    })
  })

  describe('粘性停止：continue:false', () => {
    it('第一处 continue:false 生效', () => {
      const outputs: HookOutput[] = [
        { exitCode: 0, stdout: '', stderr: '', continue: false, stopReason: '停止1' },
        { exitCode: 0, stdout: '', stderr: '', continue: false, stopReason: '停止2' },
      ]
      const result = mergeHookOutputs(outputs)
      expect(result.stop).toBe(true)
      expect(result.stopReason).toBe('停止1')
    })

    it('没有 continue:false 时 stop 为 false', () => {
      const outputs: HookOutput[] = [
        { exitCode: 0, stdout: '', stderr: '', continue: true },
        { exitCode: 0, stdout: '', stderr: '' },
      ]
      const result = mergeHookOutputs(outputs)
      expect(result.stop).toBe(false)
      expect(result.stopReason).toBeUndefined()
    })
  })

  describe('上下文累积', () => {
    it('按顺序累积 additionalContext', () => {
      const outputs: HookOutput[] = [
        { exitCode: 0, stdout: '', stderr: '', additionalContext: '上下文1' },
        { exitCode: 0, stdout: '', stderr: '', additionalContext: '上下文2' },
      ]
      const result = mergeHookOutputs(outputs)
      expect(result.additionalContext).toEqual(['上下文1', '上下文2'])
    })

    it('按顺序累积 systemMessages', () => {
      const outputs: HookOutput[] = [
        { exitCode: 0, stdout: '', stderr: '', systemMessage: '系统消息1' },
        { exitCode: 0, stdout: '', stderr: '', systemMessage: '系统消息2' },
      ]
      const result = mergeHookOutputs(outputs)
      expect(result.systemMessages).toEqual(['系统消息1', '系统消息2'])
    })
  })

  describe('复杂场景：决策 + 停止 + 上下文', () => {
    it('完整合并场景', () => {
      const outputs: HookOutput[] = [
        {
          exitCode: 0,
          stdout: '',
          stderr: '',
          decision: 'allow',
          additionalContext: '前置上下文',
        },
        {
          exitCode: 0,
          stdout: '',
          stderr: '',
          decision: 'deny',
          reason: '高危操作',
          continue: false,
          stopReason: '被安全策略拦截',
          systemMessage: '请使用安全模式',
        },
        {
          exitCode: 0,
          stdout: '',
          stderr: '',
          additionalContext: '后置上下文',
        },
      ]
      const result = mergeHookOutputs(outputs)
      expect(result.decision).toBe('deny')
      expect(result.reason).toBe('高危操作')
      expect(result.stop).toBe(true)
      expect(result.stopReason).toBe('被安全策略拦截')
      expect(result.additionalContext).toEqual(['前置上下文', '后置上下文'])
      expect(result.systemMessages).toEqual(['请使用安全模式'])
    })
  })
})

// ============================================================
// runHook 测试（需要实际执行命令）
//
// 默认契约是「无 shell + 环境白名单 + 输出上限」，因此这里统一用
// process.execPath + argv 驱动 Node，不依赖任何 shell 内建命令。
// ============================================================

const NODE = process.execPath

describe('tokenizeCommand', () => {
  it('按空白切分并保留引号内的空格', () => {
    expect(tokenizeCommand('node -e "console.log(1)"')).toEqual(['node', '-e', 'console.log(1)'])
    expect(tokenizeCommand("cmd 'a b' c")).toEqual(['cmd', 'a b', 'c'])
  })

  it('保留空字符串参数', () => {
    expect(tokenizeCommand('cmd "" x')).toEqual(['cmd', '', 'x'])
  })

  it('引号未闭合时抛错，不把半截命令交给子进程', () => {
    expect(() => tokenizeCommand('cmd "unclosed')).toThrow('引号未闭合')
  })
})

describe('buildHookEnv', () => {
  const secretName = 'PI_HOOK_TEST_SECRET'

  beforeEach(() => {
    process.env[secretName] = 'super-secret'
  })

  afterEach(() => {
    delete process.env[secretName]
  })

  it('非受信配置只继承白名单，不泄漏其他变量', () => {
    const env = buildHookEnv({
      eventName: 'test',
      payload: {},
      signal: new AbortController().signal,
    })
    expect(env[secretName]).toBeUndefined()
    expect(env.PATH ?? env.Path).toBeDefined()
  })

  it('受信配置继承完整 process.env', () => {
    const env = buildHookEnv({
      eventName: 'test',
      payload: {},
      signal: new AbortController().signal,
      trusted: true,
    })
    expect(env[secretName]).toBe('super-secret')
  })

  it('调用方显式提供的 env 始终合并', () => {
    const env = buildHookEnv({
      eventName: 'test',
      payload: {},
      signal: new AbortController().signal,
      env: { PI_HOOK_EXPLICIT: 'yes' },
    })
    expect(env.PI_HOOK_EXPLICIT).toBe('yes')
  })
})

describe('runHook', () => {
  let abortController: AbortController

  beforeEach(() => {
    abortController = new AbortController()
  })

  afterEach(() => {
    abortController.abort()
  })

  const baseContext = (
    overrides: Partial<Omit<HookExecutionContext, 'signal'>> = {}
  ): HookExecutionContext => ({
    eventName: 'test',
    payload: {},
    signal: abortController.signal,
    ...overrides,
  })

  it('以 argv 执行命令并返回 stdout', async () => {
    const result = await runHook(
      { command: NODE, args: ['-e', 'console.log("hello")'] },
      baseContext()
    )
    expect(result.output.exitCode).toBe(0)
    expect(result.output.stdout).toBe('hello')
    expect(result.output.terminationReason).toBe('exit')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('未提供 args 时对命令做引号感知分词', async () => {
    const result = await runHook(
      { command: `"${NODE}" -e "console.log(42)"` },
      baseContext()
    )
    expect(result.output.exitCode).toBe(0)
    expect(result.output.stdout).toBe('42')
  })

  it('通过 stdin 传递 JSON payload', async () => {
    const result = await runHook(
      {
        command: NODE,
        args: ['-e', 'process.stdout.write(require("fs").readFileSync(0, "utf-8").trim())'],
      },
      baseContext({ payload: { foo: 'bar', num: 42 } })
    )
    expect(result.output.exitCode).toBe(0)
    expect(JSON.parse(result.output.stdout)).toEqual({ foo: 'bar', num: 42 })
  })

  it('exit 2 被解析为阻断决策', async () => {
    const result = await runHook(
      { command: NODE, args: ['-e', 'console.error("被策略拒绝"); process.exit(2)'] },
      baseContext()
    )
    expect(result.output.exitCode).toBe(2)
    expect(result.output.decision).toBe('block')
    expect(result.output.reason).toBe('被策略拒绝')
  })

  it('非 0/2 退出码不阻断，但保留诊断', async () => {
    const result = await runHook(
      { command: NODE, args: ['-e', 'process.exit(1)'] },
      baseContext()
    )
    expect(result.output.exitCode).toBe(1)
    expect(result.output.decision).toBeUndefined()
    expect(result.output.stderr).toContain('exited with code 1')
  })

  it('超时终止时如实标记 timeout', async () => {
    const start = Date.now()
    const result = await runHook(
      { command: NODE, args: ['-e', 'setTimeout(() => {}, 10000)'] },
      baseContext({ timeoutMs: 150 })
    )
    expect(Date.now() - start).toBeLessThan(3000)
    expect(result.output.exitCode).toBeUndefined()
    expect(result.output.terminationReason).toBe('timeout')
    // 宿主杀掉的进程，stderr 不代表 Hook 自身诊断
    expect(result.output.stderr).toBe('')
  })

  it('外部取消信号终止时标记 cancelled', async () => {
    setTimeout(() => abortController.abort(), 50)
    const result = await runHook(
      { command: NODE, args: ['-e', 'setTimeout(() => {}, 10000)'] },
      baseContext()
    )
    expect(result.output.exitCode).toBeUndefined()
    expect(result.output.terminationReason).toBe('cancelled')
  })

  it('信号已中止时不启动子进程', async () => {
    abortController.abort()
    const result = await runHook({ command: NODE, args: ['-e', 'console.log(1)'] }, baseContext())
    expect(result.output.terminationReason).toBe('cancelled')
    expect(result.output.stdout).toBe('')
  })

  it('命令不存在时标记 spawn-failed 且 stderr 非空', async () => {
    const result = await runHook(
      { command: 'pi-hook-command-does-not-exist' },
      baseContext()
    )
    expect(result.output.exitCode).toBeUndefined()
    expect(result.output.terminationReason).toBe('spawn-failed')
    expect(result.output.stderr.length).toBeGreaterThan(0)
  })

  it('空命令直接失败，不启动子进程', async () => {
    const result = await runHook({ command: '   ' }, baseContext())
    expect(result.output.terminationReason).toBe('spawn-failed')
    expect(result.output.stderr).toContain('command')
  })

  it('cwd 不存在时明确失败，不回落到宿主 cwd', async () => {
    const result = await runHook(
      { command: NODE, args: ['-e', 'console.log(process.cwd())'] },
      baseContext({ cwd: join(process.cwd(), 'pi-hook-missing-dir-xyz') })
    )
    expect(result.output.terminationReason).toBe('spawn-failed')
    expect(result.output.stderr).toContain('cwd')
  })

  it('cwd 存在时子进程在该目录执行', async () => {
    const result = await runHook(
      { command: NODE, args: ['-e', 'console.log(process.cwd())'] },
      baseContext({ cwd: tmpdir() })
    )
    expect(result.output.exitCode).toBe(0)
    expect(realpathSync(result.output.stdout.trim())).toBe(realpathSync(tmpdir()))
  })

  describe('shell 求值只在受信配置下开放', () => {
    // `exit` 在 Windows 和 Unix 都只是 shell 内建命令，没有同名可执行文件，
    // 因此它能干净地区分"走了 shell"和"按 argv 执行"。
    it('非受信配置忽略 shell: true，按 argv 执行并失败', async () => {
      const result = await runHook({ command: 'exit 2', shell: true }, baseContext())
      expect(result.output.terminationReason).toBe('spawn-failed')
      expect(result.output.exitCode).toBeUndefined()
    })

    it('受信配置 + shell: true 才做 shell 求值', async () => {
      const result = await runHook(
        { command: 'exit 2', shell: true },
        baseContext({ trusted: true })
      )
      expect(result.output.exitCode).toBe(2)
      expect(result.output.decision).toBe('block')
    })
  })

  it('环境变量默认按白名单继承', async () => {
    process.env.PI_HOOK_RUN_SECRET = 'leaked'
    try {
      const script = 'console.log(String(process.env.PI_HOOK_RUN_SECRET))'
      const guarded = await runHook({ command: NODE, args: ['-e', script] }, baseContext())
      expect(guarded.output.stdout).toBe('undefined')

      const trusted = await runHook(
        { command: NODE, args: ['-e', script] },
        baseContext({ trusted: true })
      )
      expect(trusted.output.stdout).toBe('leaked')
    } finally {
      delete process.env.PI_HOOK_RUN_SECRET
    }
  })

  it('输出超过上限时截断并标记 truncated', async () => {
    const result = await runHook(
      { command: NODE, args: ['-e', 'process.stdout.write("x".repeat(5000))'] },
      baseContext({ maxOutputBytes: 512 })
    )
    expect(result.output.exitCode).toBe(0)
    expect(result.output.truncated).toBe(true)
    expect(result.output.stdout.length).toBe(512)
  })

  it('输出未超限时不标记 truncated', async () => {
    const result = await runHook(
      { command: NODE, args: ['-e', 'process.stdout.write("short")'] },
      baseContext({ maxOutputBytes: 512 })
    )
    expect(result.output.truncated).toBeUndefined()
    expect(result.output.stdout).toBe('short')
  })

  it('并发执行互不串扰', async () => {
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        runHook(
          { command: NODE, args: ['-e', `console.log(${n} * 10)`] },
          baseContext({ payload: { n } })
        )
      )
    )
    expect(results.map((item) => item.output.stdout)).toEqual(['10', '20', '30', '40'])
  })

  it('子进程不读 stdin 也不会让宿主抛错', async () => {
    const result = await runHook(
      { command: NODE, args: ['-e', 'console.log("ignored stdin")'] },
      baseContext({ payload: { big: 'x'.repeat(100_000) } })
    )
    expect(result.output.exitCode).toBe(0)
    expect(result.output.stdout).toBe('ignored stdin')
  })

  it('DEFAULT_HOOK_TIMEOUT_MS 与 DSH 保持 10 分钟', () => {
    expect(DEFAULT_HOOK_TIMEOUT_MS).toBe(600_000)
    expect(DEFAULT_HOOK_MAX_OUTPUT_BYTES).toBe(256 * 1024)
  })
})
