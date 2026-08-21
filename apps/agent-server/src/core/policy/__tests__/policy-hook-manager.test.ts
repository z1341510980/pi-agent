/**
 * PolicyHookManager 测试矩阵（P1-4）
 *
 * 覆盖 matcher 语义、事件名守卫、决策合并、超时/取消、输出截断和并发 run。
 * 全部用 process.execPath + argv 驱动 Node，不依赖 shell 内建命令。
 *
 * @module core/policy/__tests__/policy-hook-manager.test
 */

import { describe, expect, it } from 'vitest'
import { PolicyHookManager, type HookDefinition } from '../policy-hook-manager.js'

const NODE = process.execPath

/** 生成一个用 argv 执行的 Node Hook 定义 */
function nodeHook(
  point: HookDefinition['point'],
  script: string,
  extras: Partial<HookDefinition> = {}
): HookDefinition {
  return { point, command: NODE, args: ['-e', script], enabled: true, ...extras }
}

/** 打印一段结构化 hookSpecificOutput 的脚本 */
function emit(payload: Record<string, unknown>): string {
  return `console.log(${JSON.stringify(JSON.stringify(payload))})`
}

const signal = (): AbortSignal => new AbortController().signal

describe('PolicyHookManager matcher', () => {
  // 命中即 deny：决策本身就是"这条 Hook 被选中执行了"的信号
  const denyScript = emit({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
  })

  it('无 matcher 时匹配所有工具', async () => {
    const manager = new PolicyHookManager()
    manager.setHooks([nodeHook('PreToolUse', denyScript)])
    const result = await manager.runPreToolUseHooks('anything', {}, signal())
    expect(result.outcome.decision).toBe('deny')
  })

  it('管道候选集按完整 token 匹配，不误命中前缀', async () => {
    const manager = new PolicyHookManager()
    manager.setHooks([nodeHook('PreToolUse', denyScript, { matcher: 'bash|rm' })])

    expect((await manager.runPreToolUseHooks('bash', {}, signal())).outcome.decision).toBe('deny')
    // bash-extra 不应被 'bash|rm' 命中
    const miss = await manager.runPreToolUseHooks('bash-extra', {}, signal())
    expect(miss.outcome.decision).toBe('none')
    expect(miss.command).toBe('none')
  })

  it('单值 matcher 按正则语义匹配', async () => {
    const manager = new PolicyHookManager()
    manager.setHooks([nodeHook('PreToolUse', denyScript, { matcher: '^write' })])
    expect((await manager.runPreToolUseHooks('write_file', {}, signal())).outcome.decision).toBe(
      'deny'
    )
    expect((await manager.runPreToolUseHooks('overwrite', {}, signal())).outcome.decision).toBe(
      'none'
    )
  })

  it('RegExp matcher 复用时不受 lastIndex 影响', async () => {
    const manager = new PolicyHookManager()
    manager.setHooks([nodeHook('PreToolUse', denyScript, { matcher: /bash/g })])
    expect((await manager.runPreToolUseHooks('bash', {}, signal())).outcome.decision).toBe('deny')
    expect((await manager.runPreToolUseHooks('bash', {}, signal())).outcome.decision).toBe('deny')
  })

  it('enabled: false 的 Hook 不进入执行集合', async () => {
    const manager = new PolicyHookManager()
    manager.setHooks([nodeHook('PreToolUse', denyScript, { enabled: false })])
    const result = await manager.runPreToolUseHooks('bash', {}, signal())
    expect(result.outcome.decision).toBe('none')
  })

  it('不同 Hook 点互不触发', async () => {
    const manager = new PolicyHookManager()
    manager.setHooks([
      nodeHook(
        'PostToolUse',
        emit({
          hookSpecificOutput: { hookEventName: 'PostToolUse', permissionDecision: 'deny' },
        })
      ),
    ])
    expect((await manager.runPreToolUseHooks('bash', {}, signal())).outcome.decision).toBe('none')
    expect((await manager.runPostToolUseHooks('bash', {}, signal())).outcome.decision).toBe('deny')
  })
})

describe('PolicyHookManager 事件名守卫', () => {
  it('hookEventName 不匹配时丢弃决策与上下文', async () => {
    const manager = new PolicyHookManager()
    manager.setHooks([
      nodeHook(
        'PreToolUse',
        emit({
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            permissionDecision: 'deny',
            additionalContext: '应被丢弃',
          },
        })
      ),
    ])
    const result = await manager.runPreToolUseHooks('bash', {}, signal())
    expect(result.outcome.decision).toBe('none')
    expect(result.outcome.additionalContext).toEqual([])
  })

  it('hookEventName 匹配时保留决策与上下文', async () => {
    const manager = new PolicyHookManager()
    manager.setHooks([
      nodeHook(
        'PreToolUse',
        emit({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: '需要确认',
            additionalContext: '来自 Hook',
          },
        })
      ),
    ])
    const result = await manager.runPreToolUseHooks('bash', {}, signal())
    expect(result.outcome.decision).toBe('ask')
    expect(result.outcome.reason).toBe('需要确认')
    expect(result.outcome.additionalContext).toEqual(['来自 Hook'])
  })

  it('payload 携带 hookEventName，供 Hook 自身判别', async () => {
    const manager = new PolicyHookManager()
    manager.setHooks([
      nodeHook(
        'SessionStart',
        'const input = JSON.parse(require("fs").readFileSync(0, "utf-8"));' +
          'console.log(JSON.stringify({ systemMessage: input.hookEventName }))'
      ),
    ])
    const result = await manager.runSessionStartHooks(signal())
    expect(result.outcome.systemMessages).toEqual(['SessionStart'])
  })
})

describe('PolicyHookManager 决策与阻断', () => {
  it('exit 2 归一化为 deny，stderr 作为原因', async () => {
    const manager = new PolicyHookManager()
    manager.setHooks([
      nodeHook('PreToolUse', 'console.error("危险命令"); process.exit(2)'),
    ])
    const result = await manager.runPreToolUseHooks('bash', {}, signal())
    expect(result.outcome.decision).toBe('deny')
    expect(result.outcome.reason).toBe('危险命令')
  })

  it('多个 Hook 按 deny > ask > allow 合并，并累积上下文', async () => {
    const manager = new PolicyHookManager()
    manager.setHooks([
      nodeHook(
        'PreToolUse',
        emit({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            additionalContext: 'ctx-1',
          },
        })
      ),
      nodeHook(
        'PreToolUse',
        emit({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: '确认',
            additionalContext: 'ctx-2',
          },
        })
      ),
      nodeHook(
        'PreToolUse',
        emit({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: '禁止',
          },
          systemMessage: 'sys-1',
        })
      ),
    ])
    const result = await manager.runPreToolUseHooks('bash', {}, signal())
    expect(result.outcome.decision).toBe('deny')
    expect(result.outcome.reason).toBe('禁止')
    expect(result.outcome.additionalContext).toEqual(['ctx-1', 'ctx-2'])
    expect(result.outcome.systemMessages).toEqual(['sys-1'])
    expect(result.rawOutputs).toHaveLength(3)
  })

  it('updatedInput 逐个合并，供调用方二次校验', async () => {
    const manager = new PolicyHookManager()
    manager.setHooks([
      nodeHook(
        'PreToolUse',
        emit({
          hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { a: 1, b: 1 } },
        })
      ),
      nodeHook(
        'PreToolUse',
        emit({
          hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { b: 2 } },
        })
      ),
    ])
    const result = await manager.runPreToolUseHooks('bash', {}, signal())
    expect(result.outcome.updatedInput).toEqual({ a: 1, b: 2 })
  })

  it('Hook 执行失败不阻断，但在原始输出里留下诊断', async () => {
    const manager = new PolicyHookManager()
    manager.setHooks([
      { point: 'PreToolUse', command: 'pi-hook-missing-binary', enabled: true },
    ])
    const result = await manager.runPreToolUseHooks('bash', {}, signal())
    expect(result.outcome.decision).toBe('none')
    expect(result.rawOutputs?.[0].output.terminationReason).toBe('spawn-failed')
  })
})

describe('PolicyHookManager 超时与取消', () => {
  it('timeoutSec 生效并如实标记 timeout', async () => {
    const manager = new PolicyHookManager()
    manager.setHooks([
      nodeHook('Stop', 'setTimeout(() => {}, 10000)', { timeoutSec: 0.2 }),
    ])
    const result = await manager.runStopHooks(signal())
    expect(result.outcome.decision).toBe('none')
    expect(result.rawOutputs?.[0].output.terminationReason).toBe('timeout')
  })

  it('外部 abort 终止 Hook 并标记 cancelled', async () => {
    const manager = new PolicyHookManager()
    manager.setHooks([nodeHook('Stop', 'setTimeout(() => {}, 10000)')])
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const result = await manager.runStopHooks(controller.signal)
    expect(result.rawOutputs?.[0].output.terminationReason).toBe('cancelled')
  })
})

describe('PolicyHookManager 安全策略投影', () => {
  it('默认非受信：shell: true 被忽略，按 argv 执行', async () => {
    const manager = new PolicyHookManager()
    manager.setHooks([
      { point: 'Stop', command: 'exit 2', enabled: true, shell: true },
    ])
    const result = await manager.runStopHooks(signal())
    // 未走 shell，'exit 2' 不是可执行文件
    expect(result.rawOutputs?.[0].output.terminationReason).toBe('spawn-failed')
    expect(result.outcome.decision).toBe('none')
  })

  it('受信策略下 shell: true 才做 shell 求值', async () => {
    const manager = new PolicyHookManager({ trusted: true })
    manager.setHooks([
      { point: 'Stop', command: 'exit 2', enabled: true, shell: true },
    ])
    const result = await manager.runStopHooks(signal())
    expect(result.rawOutputs?.[0].output.exitCode).toBe(2)
    expect(result.outcome.decision).toBe('deny')
  })

  it('非受信策略不把宿主环境变量传给 Hook', async () => {
    process.env.PI_HOOK_MANAGER_SECRET = 'leaked'
    try {
      const manager = new PolicyHookManager()
      manager.setHooks([
        nodeHook(
          'Stop',
          'console.log(JSON.stringify({ systemMessage: String(process.env.PI_HOOK_MANAGER_SECRET) }))'
        ),
      ])
      const guarded = await manager.runStopHooks(signal())
      expect(guarded.outcome.systemMessages).toEqual(['undefined'])

      manager.setSecurity({ trusted: true })
      const trusted = await manager.runStopHooks(signal())
      expect(trusted.outcome.systemMessages).toEqual(['leaked'])
    } finally {
      delete process.env.PI_HOOK_MANAGER_SECRET
    }
  })

  it('输出上限生效并标记 truncated', async () => {
    const manager = new PolicyHookManager({ maxOutputBytes: 256 })
    manager.setHooks([nodeHook('Stop', 'process.stdout.write("x".repeat(4000))')])
    const result = await manager.runStopHooks(signal())
    expect(result.rawOutputs?.[0].output.truncated).toBe(true)
    expect(result.rawOutputs?.[0].output.stdout.length).toBe(256)
  })

  it('未配置 cwd 时不向子进程指定工作目录', async () => {
    const manager = new PolicyHookManager()
    manager.setHooks([
      nodeHook(
        'Stop',
        'console.log(JSON.stringify({ systemMessage: process.cwd() }))'
      ),
    ])
    const result = await manager.runStopHooks(signal())
    expect(result.outcome.systemMessages).toEqual([process.cwd()])
  })

  it('getSecurity 投影当前策略', () => {
    const manager = new PolicyHookManager({ trusted: true, maxOutputBytes: 128 })
    expect(manager.getSecurity()).toMatchObject({ trusted: true, maxOutputBytes: 128 })
  })
})

describe('PolicyHookManager 并发 run', () => {
  it('并发的不同工具各自得到自己的决策', async () => {
    const manager = new PolicyHookManager()
    manager.setHooks([
      nodeHook(
        'PreToolUse',
        'const input = JSON.parse(require("fs").readFileSync(0, "utf-8"));' +
          'console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse",' +
          ' permissionDecision: input.toolName === "bash" ? "deny" : "allow",' +
          ' permissionDecisionReason: input.toolName } }))'
      ),
    ])

    const [bash, read, write] = await Promise.all([
      manager.runPreToolUseHooks('bash', {}, signal()),
      manager.runPreToolUseHooks('read', {}, signal()),
      manager.runPreToolUseHooks('write', {}, signal()),
    ])
    expect(bash.outcome.decision).toBe('deny')
    expect(bash.outcome.reason).toBe('bash')
    expect(read.outcome.decision).toBe('allow')
    expect(write.outcome.decision).toBe('allow')
  })

  it('一路 run 被取消不影响并发的另一路', async () => {
    const manager = new PolicyHookManager()
    manager.setHooks([
      nodeHook('PostToolUse', 'setTimeout(() => console.log("slow"), 5000)', {
        matcher: 'slow',
      }),
      nodeHook(
        'PostToolUse',
        emit({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'fast-ok' },
        }),
        { matcher: 'fast' }
      ),
    ])

    const cancelled = new AbortController()
    setTimeout(() => cancelled.abort(), 50)
    const [slow, fast] = await Promise.all([
      manager.runPostToolUseHooks('slow', {}, cancelled.signal),
      manager.runPostToolUseHooks('fast', {}, signal()),
    ])
    expect(slow.rawOutputs?.[0].output.terminationReason).toBe('cancelled')
    expect(fast.outcome.additionalContext).toEqual(['fast-ok'])
  })
})
