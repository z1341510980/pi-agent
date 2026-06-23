/**
 * AgentChannel：Agent 间通信通道
 *
 * 参考 ARCHITECTURE.md §9.1，支持两种通信方式：
 * - 频道（channel）：多 Agent 订阅同一频道，广播消息
 * - 私信（DM）：Agent 间点对点消息
 *
 * 集成 EventBus：
 * - channel:message：频道消息广播时触发
 * - dm:sent：私信发送时触发
 */

import type { EventBus } from '@repo/shared/events'

/** 频道消息 */
export interface ChannelMessage {
  /** 频道名 */
  channel: string
  /** 发送者 Agent ID */
  fromAgentId: string
  /** 消息内容 */
  content: unknown
  /** 时间戳 */
  timestamp: number
  /** 消息 ID */
  id: string
}

/** 私信消息 */
export interface DmMessage {
  /** 发送者 Agent ID */
  fromAgentId: string
  /** 接收者 Agent ID */
  toAgentId: string
  /** 消息内容 */
  content: unknown
  /** 时间戳 */
  timestamp: number
  /** 消息 ID */
  id: string
}

/** 频道信息 */
export interface ChannelInfo {
  /** 频道名 */
  name: string
  /** 订阅者 Agent ID 列表 */
  subscribers: string[]
  /** 消息数 */
  messageCount: number
}

/** 消息监听器 */
type MessageListener = (message: ChannelMessage) => void
/** 私信监听器 */
type DmListener = (message: DmMessage) => void

/**
 * Agent 间通信通道管理器
 *
 * 关键不变量：
 * 1. 频道消息只分发给订阅者（不含发送者自身）
 * 2. 私信只分发给指定接收者
 * 3. 所有消息都通过 EventBus 广播事件，供外部系统监听
 * 4. 消息按时间顺序存储，支持历史查询
 */
export class AgentChannel {
  /** 频道订阅者：channelName -> Set<agentId> */
  private readonly channels = new Map<string, Set<string>>()
  /** 频道消息历史 */
  private readonly channelMessages = new Map<string, ChannelMessage[]>()
  /** 私信消息历史（按 agentId 分组） */
  private readonly dmMessages = new Map<string, DmMessage[]>()
  /** 频道消息监听器：agentId -> listeners */
  private readonly channelListeners = new Map<string, Set<MessageListener>>()
  /** 私信监听器：agentId -> listeners */
  private readonly dmListeners = new Map<string, Set<DmListener>>()
  /** 最大历史消息保留数（每频道/每 Agent） */
  private readonly maxHistory: number

  constructor(
    private readonly eventBus?: EventBus,
    options: { maxHistory?: number } = {},
  ) {
    this.maxHistory = options.maxHistory ?? 1000
  }

  /**
   * 订阅频道
   * @param channel 频道名
   * @param agentId 订阅者 Agent ID
   */
  subscribe(channel: string, agentId: string): void {
    let subscribers = this.channels.get(channel)
    if (!subscribers) {
      subscribers = new Set()
      this.channels.set(channel, subscribers)
    }
    subscribers.add(agentId)
  }

  /**
   * 取消订阅频道
   * @param channel 频道名
   * @param agentId 取消订阅的 Agent ID
   */
  unsubscribe(channel: string, agentId: string): void {
    const subscribers = this.channels.get(channel)
    if (subscribers) {
      subscribers.delete(agentId)
      // 频道无订阅者时清理
      if (subscribers.size === 0) {
        this.channels.delete(channel)
      }
    }
  }

  /**
   * 向频道广播消息
   * @param channel 频道名
   * @param fromAgentId 发送者 Agent ID
   * @param content 消息内容
   * @returns 接收到消息的 Agent ID 列表
   */
  broadcast(channel: string, fromAgentId: string, content: unknown): string[] {
    const message: ChannelMessage = {
      channel,
      fromAgentId,
      content,
      timestamp: Date.now(),
      id: `chmsg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    }

    // 存储消息历史
    let history = this.channelMessages.get(channel)
    if (!history) {
      history = []
      this.channelMessages.set(channel, history)
    }
    history.push(message)
    if (history.length > this.maxHistory) {
      history.splice(0, history.length - this.maxHistory)
    }

    // 分发给订阅者（不含发送者自身）
    const subscribers = this.channels.get(channel)
    const deliveredTo: string[] = []
    if (subscribers) {
      for (const agentId of subscribers) {
        if (agentId === fromAgentId) continue
        deliveredTo.push(agentId)
        // 触发该 Agent 的监听器
        const listeners = this.channelListeners.get(agentId)
        if (listeners) {
          for (const listener of listeners) {
            try {
              listener(message)
            } catch {
              // 监听器异常不影响其他订阅者
            }
          }
        }
      }
    }

    // EventBus 事件广播
    this.eventBus?.emit('channel:message', {
      ...message,
      deliveredTo,
    })

    return deliveredTo
  }

  /**
   * 发送私信
   * @param fromAgentId 发送者 Agent ID
   * @param toAgentId 接收者 Agent ID
   * @param content 消息内容
   */
  sendDm(fromAgentId: string, toAgentId: string, content: unknown): void {
    const message: DmMessage = {
      fromAgentId,
      toAgentId,
      content,
      timestamp: Date.now(),
      id: `dm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    }

    // 存储到双方的私信历史
    for (const agentId of [fromAgentId, toAgentId]) {
      let history = this.dmMessages.get(agentId)
      if (!history) {
        history = []
        this.dmMessages.set(agentId, history)
      }
      history.push(message)
      if (history.length > this.maxHistory) {
        history.splice(0, history.length - this.maxHistory)
      }
    }

    // 触发接收者的监听器
    const listeners = this.dmListeners.get(toAgentId)
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(message)
        } catch {
          // 监听器异常不影响消息存储
        }
      }
    }

    // EventBus 事件广播
    this.eventBus?.emit('dm:sent', message)
  }

  /**
   * 监听指定 Agent 收到的频道消息
   * @returns 取消监听函数
   */
  onChannelMessage(agentId: string, listener: MessageListener): () => void {
    let listeners = this.channelListeners.get(agentId)
    if (!listeners) {
      listeners = new Set()
      this.channelListeners.set(agentId, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners?.delete(listener)
    }
  }

  /**
   * 监听指定 Agent 收到的私信
   * @returns 取消监听函数
   */
  onDm(agentId: string, listener: DmListener): () => void {
    let listeners = this.dmListeners.get(agentId)
    if (!listeners) {
      listeners = new Set()
      this.dmListeners.set(agentId, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners?.delete(listener)
    }
  }

  /** 获取频道消息历史 */
  getChannelMessages(channel: string): ChannelMessage[] {
    return this.channelMessages.get(channel) ?? []
  }

  /** 获取 Agent 的私信历史 */
  getDmMessages(agentId: string): DmMessage[] {
    return this.dmMessages.get(agentId) ?? []
  }

  /** 列出所有频道信息 */
  listChannels(): ChannelInfo[] {
    const result: ChannelInfo[] = []
    for (const [name, subscribers] of this.channels) {
      result.push({
        name,
        subscribers: Array.from(subscribers),
        messageCount: this.channelMessages.get(name)?.length ?? 0,
      })
    }
    return result
  }

  /** 获取频道订阅者列表 */
  getChannelSubscribers(channel: string): string[] {
    const subscribers = this.channels.get(channel)
    return subscribers ? Array.from(subscribers) : []
  }

  /** 清空所有消息和订阅（用于测试或重置） */
  clear(): void {
    this.channels.clear()
    this.channelMessages.clear()
    this.dmMessages.clear()
    this.channelListeners.clear()
    this.dmListeners.clear()
  }
}
