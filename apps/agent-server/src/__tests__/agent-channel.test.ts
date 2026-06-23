import { describe, expect, it, vi } from 'vitest'
import { EventBus } from '@repo/shared/events'
import { AgentChannel } from '../core/agent/agent-channel.js'

describe('AgentChannel', () => {
  it('subscribe/unsubscribe 管理频道订阅者', () => {
    const channel = new AgentChannel()
    channel.subscribe('general', 'agent-1')
    channel.subscribe('general', 'agent-2')

    expect(channel.getChannelSubscribers('general')).toEqual(
      expect.arrayContaining(['agent-1', 'agent-2']),
    )

    channel.unsubscribe('general', 'agent-1')
    expect(channel.getChannelSubscribers('general')).toEqual(['agent-2'])
  })

  it('频道无订阅者时自动清理', () => {
    const channel = new AgentChannel()
    channel.subscribe('general', 'agent-1')
    channel.unsubscribe('general', 'agent-1')

    expect(channel.listChannels()).toHaveLength(0)
  })

  it('broadcast 分发给所有订阅者（不含发送者）', () => {
    const channel = new AgentChannel()
    channel.subscribe('general', 'agent-1')
    channel.subscribe('general', 'agent-2')
    channel.subscribe('general', 'agent-3')

    const received: string[] = []
    channel.onChannelMessage('agent-2', (msg) => {
      received.push(`agent-2:${msg.content as string}`)
    })
    channel.onChannelMessage('agent-3', (msg) => {
      received.push(`agent-3:${msg.content as string}`)
    })
    // agent-1 是发送者，不应收到自己的消息
    channel.onChannelMessage('agent-1', () => {
      received.push('agent-1:should-not-receive')
    })

    const deliveredTo = channel.broadcast('general', 'agent-1', 'hello')

    expect(deliveredTo).toEqual(expect.arrayContaining(['agent-2', 'agent-3']))
    expect(deliveredTo).not.toContain('agent-1')
    expect(received).toEqual(
      expect.arrayContaining(['agent-2:hello', 'agent-3:hello']),
    )
    expect(received).not.toContain('agent-1:should-not-receive')
  })

  it('broadcast 存储消息历史', () => {
    const channel = new AgentChannel()
    channel.subscribe('general', 'agent-1')
    channel.subscribe('general', 'agent-2')

    channel.broadcast('general', 'agent-1', 'msg1')
    channel.broadcast('general', 'agent-2', 'msg2')

    const messages = channel.getChannelMessages('general')
    expect(messages).toHaveLength(2)
    expect(messages[0].content).toBe('msg1')
    expect(messages[1].content).toBe('msg2')
  })

  it('sendDm 发送私信给指定 Agent', () => {
    const channel = new AgentChannel()
    const received: string[] = []

    channel.onDm('agent-2', (msg) => {
      received.push(`${msg.fromAgentId}->${msg.toAgentId}:${msg.content as string}`)
    })
    // agent-1 不应收到发给 agent-2 的私信
    channel.onDm('agent-1', () => {
      received.push('agent-1:should-not-receive')
    })

    channel.sendDm('agent-1', 'agent-2', 'private message')

    expect(received).toEqual(['agent-1->agent-2:private message'])
    expect(received).not.toContain('agent-1:should-not-receive')
  })

  it('sendDm 存储到双方私信历史', () => {
    const channel = new AgentChannel()

    channel.sendDm('agent-1', 'agent-2', 'hello')
    channel.sendDm('agent-2', 'agent-1', 'hi back')

    const agent1Msgs = channel.getDmMessages('agent-1')
    const agent2Msgs = channel.getDmMessages('agent-2')

    expect(agent1Msgs).toHaveLength(2)
    expect(agent2Msgs).toHaveLength(2)

    // 第一条：agent-1 发给 agent-2
    expect(agent1Msgs[0].fromAgentId).toBe('agent-1')
    expect(agent1Msgs[0].toAgentId).toBe('agent-2')
    // 第二条：agent-2 发给 agent-1
    expect(agent1Msgs[1].fromAgentId).toBe('agent-2')
    expect(agent1Msgs[1].toAgentId).toBe('agent-1')
  })

  it('listChannels 返回所有频道信息', () => {
    const channel = new AgentChannel()
    channel.subscribe('general', 'agent-1')
    channel.subscribe('general', 'agent-2')
    channel.subscribe('dev', 'agent-1')

    channel.broadcast('general', 'agent-1', 'msg1')
    channel.broadcast('dev', 'agent-1', 'msg2')

    const channels = channel.listChannels()
    expect(channels).toHaveLength(2)

    const general = channels.find((c) => c.name === 'general')
    expect(general).toBeDefined()
    expect(general!.subscribers).toEqual(expect.arrayContaining(['agent-1', 'agent-2']))
    expect(general!.messageCount).toBe(1)

    const dev = channels.find((c) => c.name === 'dev')
    expect(dev).toBeDefined()
    expect(dev!.subscribers).toEqual(['agent-1'])
    expect(dev!.messageCount).toBe(1)
  })

  it('onChannelMessage 返回取消监听函数', () => {
    const channel = new AgentChannel()
    channel.subscribe('general', 'agent-1')
    channel.subscribe('general', 'agent-2')

    const received: string[] = []
    const unsubscribe = channel.onChannelMessage('agent-2', (msg) => {
      received.push(msg.content as string)
    })

    channel.broadcast('general', 'agent-1', 'msg1')
    expect(received).toEqual(['msg1'])

    unsubscribe()

    channel.broadcast('general', 'agent-1', 'msg2')
    expect(received).toEqual(['msg1']) // 取消后不再收到
  })

  it('onDm 返回取消监听函数', () => {
    const channel = new AgentChannel()
    const received: string[] = []
    const unsubscribe = channel.onDm('agent-2', (msg) => {
      received.push(msg.content as string)
    })

    channel.sendDm('agent-1', 'agent-2', 'dm1')
    expect(received).toEqual(['dm1'])

    unsubscribe()

    channel.sendDm('agent-1', 'agent-2', 'dm2')
    expect(received).toEqual(['dm1'])
  })

  it('与 EventBus 集成：broadcast 触发 channel:message 事件', () => {
    const eventBus = new EventBus()
    const channel = new AgentChannel(eventBus)

    channel.subscribe('general', 'agent-1')
    channel.subscribe('general', 'agent-2')

    const events: unknown[] = []
    eventBus.on('channel:message', (data) => {
      events.push(data)
    })

    channel.broadcast('general', 'agent-1', { text: 'hello' })

    expect(events).toHaveLength(1)
    const event = events[0] as { channel: string; fromAgentId: string; content: unknown; deliveredTo: string[] }
    expect(event.channel).toBe('general')
    expect(event.fromAgentId).toBe('agent-1')
    expect(event.content).toEqual({ text: 'hello' })
    expect(event.deliveredTo).toEqual(['agent-2'])
  })

  it('与 EventBus 集成：sendDm 触发 dm:sent 事件', () => {
    const eventBus = new EventBus()
    const channel = new AgentChannel(eventBus)

    const events: unknown[] = []
    eventBus.on('dm:sent', (data) => {
      events.push(data)
    })

    channel.sendDm('agent-1', 'agent-2', 'private')

    expect(events).toHaveLength(1)
    const event = events[0] as { fromAgentId: string; toAgentId: string; content: unknown }
    expect(event.fromAgentId).toBe('agent-1')
    expect(event.toAgentId).toBe('agent-2')
    expect(event.content).toBe('private')
  })

  it('监听器异常不影响其他订阅者', () => {
    const channel = new AgentChannel()
    channel.subscribe('general', 'agent-1')
    channel.subscribe('general', 'agent-2')
    channel.subscribe('general', 'agent-3')

    const received: string[] = []

    // 第一个监听器抛错
    channel.onChannelMessage('agent-2', () => {
      throw new Error('listener error')
    })
    // 第二个监听器应正常执行
    channel.onChannelMessage('agent-3', (msg) => {
      received.push(msg.content as string)
    })

    // 不应抛错
    expect(() => channel.broadcast('general', 'agent-1', 'hello')).not.toThrow()
    expect(received).toEqual(['hello'])
  })

  it('clear 清空所有状态', () => {
    const channel = new AgentChannel()
    channel.subscribe('general', 'agent-1')
    channel.subscribe('general', 'agent-2')
    channel.broadcast('general', 'agent-1', 'msg')
    channel.sendDm('agent-1', 'agent-2', 'dm')

    channel.clear()

    expect(channel.listChannels()).toHaveLength(0)
    expect(channel.getChannelMessages('general')).toHaveLength(0)
    expect(channel.getDmMessages('agent-1')).toHaveLength(0)
    expect(channel.getDmMessages('agent-2')).toHaveLength(0)
  })

  it('消息历史超过 maxHistory 时自动裁剪', () => {
    const channel = new AgentChannel(undefined, { maxHistory: 3 })
    channel.subscribe('general', 'agent-1')
    channel.subscribe('general', 'agent-2')

    channel.broadcast('general', 'agent-1', 'msg1')
    channel.broadcast('general', 'agent-1', 'msg2')
    channel.broadcast('general', 'agent-1', 'msg3')
    channel.broadcast('general', 'agent-1', 'msg4')

    const messages = channel.getChannelMessages('general')
    expect(messages).toHaveLength(3)
    // 保留最新的 3 条
    expect(messages[0].content).toBe('msg2')
    expect(messages[2].content).toBe('msg4')
  })

  it('异步消息传递：监听器在消息发送后立即触发', async () => {
    const channel = new AgentChannel()
    channel.subscribe('general', 'agent-1')
    channel.subscribe('general', 'agent-2')

    const received = new Promise<string>((resolve) => {
      channel.onChannelMessage('agent-2', (msg) => {
        resolve(msg.content as string)
      })
    })

    channel.broadcast('general', 'agent-1', 'async-msg')

    // 监听器应同步触发，Promise 立即 resolve
    const result = await Promise.race([
      received,
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 1000),
      ),
    ])
    expect(result).toBe('async-msg')
  })
})
