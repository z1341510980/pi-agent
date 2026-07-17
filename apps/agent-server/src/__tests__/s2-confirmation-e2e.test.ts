import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { createBeforeToolCall } from '../core/tool/confirmation-tools.js'
import type { ConfirmationRequest } from '../core/tool/confirmation-manager.js'

type WebSocketMessage = {
  toString(): string
}

interface TestSocket {
  once: (event: string, cb: (data: WebSocketMessage) => void) => void
  send: (data: string) => void
  close: () => void
}

interface ServerMessage {
  type: string
  payload?: unknown
}

/** 等待下一条消息 */
function nextMessage(socket: TestSocket): Promise<ServerMessage> {
  return new Promise((resolve) => {
    socket.once('message', (data: WebSocketMessage) => {
      try {
        resolve(JSON.parse(data.toString()) as ServerMessage)
      } catch {
        resolve({ type: 'invalid' })
      }
    })
  })
}

/** 等待指定类型的消息，跳过其他消息（带超时） */
async function waitForType(socket: TestSocket, type: string, timeoutMs = 2000): Promise<ServerMessage> {
  const deadline = Date.now() + timeoutMs
  let msg = await Promise.race([
    nextMessage(socket),
    new Promise<ServerMessage>((resolve) =>
      setTimeout(() => resolve({ type: '__timeout__' }), deadline - Date.now()),
    ),
  ])
  while (msg.type !== type && msg.type !== '__timeout__') {
    msg = await Promise.race([
      nextMessage(socket),
      new Promise<ServerMessage>((resolve) =>
        setTimeout(() => resolve({ type: '__timeout__' }), deadline - Date.now()),
      ),
    ])
  }
  if (msg.type === '__timeout__') {
    throw new Error(`等待消息类型 '${type}' 超时`)
  }
  return msg
}

/**
 * S2 端到端验证：危险工具调用 → 确认往返
 *
 * 场景：
 * 1. Agent 调用危险工具（bash）
 * 2. beforeToolCall 钩子触发 ConfirmationManager.requestConfirmation
 * 3. WebSocket 推送 confirmation_request 到桌面客户端
 * 4. 客户端（模拟）通过 WebSocket 回复 confirmation_response（批准/拒绝）
 * 5. 服务端推送 confirmation_resolved
 * 6. beforeToolCall 返回，Agent 继续或阻止
 */
describe('S2 端到端：危险工具确认往返', () => {
  let app: Awaited<ReturnType<typeof createApp>>

  beforeAll(async () => {
    app = await createApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('用户批准危险工具：confirmation_request → response(approved=true) → resolved → beforeToolCall 放行', async () => {
    // 确保是 auto 模式（bash 是 dangerous，需要确认）
    app.gate.setMode('auto')

    // 模拟桌面客户端连接 WebSocket
    const socket = (await app.injectWS('/ws?threadId=thread-s2-approve', {
    })) as unknown as TestSocket

    // 创建 beforeToolCall 钩子（与 pi-session.ts 中一致）
    const beforeToolCall = createBeforeToolCall({
      threadId: 'thread-s2-approve',
      gate: app.gate,
      confirmationManager: app.confirmationManager,
    })

    // 模拟 Agent 调用 bash 工具
    const toolCall = { id: 'tool-s2-approve', name: 'bash' }
    const hookPromise = beforeToolCall({ toolCall, args: { command: 'echo hello' } } as never)

    // 1. 客户端应收到 confirmation_request
    const requestMsg = await nextMessage(socket)
    expect(requestMsg.type).toBe('confirmation_request')
    const requestPayload = requestMsg.payload as ConfirmationRequest
    expect(requestPayload.toolName).toBe('bash')
    expect(requestPayload.toolCallId).toBe('tool-s2-approve')
    expect(requestPayload.threadId).toBe('thread-s2-approve')
    expect(requestPayload.reason).toContain('bash')
    expect(requestPayload.id).toBeTruthy()

    // 2. 客户端回复批准
    socket.send(JSON.stringify({
      type: 'confirmation_response',
      payload: { id: requestPayload.id, approved: true },
    }))

    // 3. 客户端应收到 confirmation_resolved（approved=true）
    const resolvedMsg = await waitForType(socket, 'confirmation_resolved')
    expect(resolvedMsg.type).toBe('confirmation_resolved')
    expect((resolvedMsg.payload as { approved: boolean }).approved).toBe(true)

    // 4. beforeToolCall 应返回 undefined（放行）
    const hookResult = await hookPromise
    expect(hookResult).toBeUndefined()

    socket.close()
  })

  it('用户拒绝危险工具：confirmation_request → response(approved=false) → resolved → beforeToolCall 阻止', async () => {
    app.gate.setMode('auto')

    const socket = (await app.injectWS('/ws?threadId=thread-s2-deny', {
    })) as unknown as TestSocket

    const beforeToolCall = createBeforeToolCall({
      threadId: 'thread-s2-deny',
      gate: app.gate,
      confirmationManager: app.confirmationManager,
    })

    const toolCall = { id: 'tool-s2-deny', name: 'bash' }
    const hookPromise = beforeToolCall({ toolCall, args: { command: 'rm -rf /' } } as never)

    // 收到 confirmation_request
    const requestMsg = await nextMessage(socket)
    expect(requestMsg.type).toBe('confirmation_request')
    const requestPayload = requestMsg.payload as ConfirmationRequest
    expect(requestPayload.toolName).toBe('bash')

    // 客户端回复拒绝
    socket.send(JSON.stringify({
      type: 'confirmation_response',
      payload: { id: requestPayload.id, approved: false },
    }))

    // 收到 confirmation_resolved（approved=false）
    const resolvedMsg = await waitForType(socket, 'confirmation_resolved')
    expect((resolvedMsg.payload as { approved: boolean }).approved).toBe(false)

    // beforeToolCall 应返回 { block: true, reason }
    const hookResult = await hookPromise
    expect(hookResult).toEqual({
      block: true,
      reason: expect.stringContaining('拒绝'),
    })

    socket.close()
  })

  it('readonly 模式：危险工具直接禁止，不触发确认流程', async () => {
    app.gate.setMode('readonly')

    const socket = (await app.injectWS('/ws?threadId=thread-s2-readonly', {
    })) as unknown as TestSocket

    const beforeToolCall = createBeforeToolCall({
      threadId: 'thread-s2-readonly',
      gate: app.gate,
      confirmationManager: app.confirmationManager,
    })

    const toolCall = { id: 'tool-s2-readonly', name: 'bash' }
    const hookPromise = beforeToolCall({ toolCall, args: { command: 'ls' } } as never)

    // beforeToolCall 应立即返回 block（不等待确认）
    const hookResult = await hookPromise
    expect(hookResult).toEqual({
      block: true,
      reason: expect.stringContaining('read-only'),
    })

    // 客户端不应收到任何 confirmation_request（带超时验证）
    await expect(
      Promise.race([
        nextMessage(socket),
        new Promise((_, reject) => setTimeout(() => reject(new Error('不应收到消息')), 500)),
      ]),
    ).rejects.toThrow('不应收到消息')

    socket.close()
    app.gate.setMode('auto')
  })

  it('safe 工具（read）在 auto 模式下自动放行，不触发确认', async () => {
    app.gate.setMode('auto')

    const socket = (await app.injectWS('/ws?threadId=thread-s2-safe', {
    })) as unknown as TestSocket

    const beforeToolCall = createBeforeToolCall({
      threadId: 'thread-s2-safe',
      gate: app.gate,
      confirmationManager: app.confirmationManager,
    })

    const toolCall = { id: 'tool-s2-safe', name: 'read' }
    const hookPromise = beforeToolCall({ toolCall, args: { path: 'README.md' } } as never)

    // 应立即放行
    const hookResult = await hookPromise
    expect(hookResult).toBeUndefined()

    // 客户端不应收到 confirmation_request
    await expect(
      Promise.race([
        nextMessage(socket),
        new Promise((_, reject) => setTimeout(() => reject(new Error('不应收到消息')), 500)),
      ]),
    ).rejects.toThrow('不应收到消息')

    socket.close()
  })

  it('权限模式切换：auto → plan，moderate 工具从自动放行变为需要确认', async () => {
    // auto 模式下 write（moderate）自动放行
    app.gate.setMode('auto')
    let result = await app.gate.check('write', { path: 'test.txt' })
    expect(result.allowed).toBe(true)

    // 切换到 plan 模式
    app.gate.setMode('plan')
    result = await app.gate.check('write', { path: 'test.txt' })
    expect(result.allowed).toBe(false)
    expect(result.needsConfirmation).toBe(true)

    // 恢复
    app.gate.setMode('auto')
  })
})
