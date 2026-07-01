import { useState, type ReactElement } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  HashIcon, MessageSquareIcon, SendIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  getAgentChannels,
  getChannelMessages,
  getDirectMessages,
  sendChannelMessage,
  sendDirectMessage,
  type ChannelMessage,
  type DmMessage,
} from '@/api/http-client'
import { useSessionStore } from '@/stores/session-store'

// ── 频道消息列表 ──

function ChannelMessageList({ messages }: { messages: ChannelMessage[] }): ReactElement {
  if (messages.length === 0) {
    return <p className="text-xs text-muted-foreground text-center py-6 m-0">暂无消息</p>
  }
  return (
    <div className="grid gap-2">
      {messages.map((msg) => (
        <div key={msg.id} className="px-2 py-1.5 rounded-md bg-surface-3 border border-border">
          <div className="flex items-center gap-1.5 mb-0.5">
            <code className="text-[10px] font-mono font-[760] text-accent">{msg.fromAgentId}</code>
            <time className="text-[10px] text-muted-foreground font-mono ml-auto">
              {new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}
            </time>
          </div>
          <p className="text-xs m-0 leading-snug break-words">
            {typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}
          </p>
        </div>
      ))}
    </div>
  )
}

// ── 私信消息列表 ──

function DmMessageList({ messages, currentAgentId }: { messages: DmMessage[]; currentAgentId: string }): ReactElement {
  if (messages.length === 0) {
    return <p className="text-xs text-muted-foreground text-center py-6 m-0">暂无私信</p>
  }
  return (
    <div className="grid gap-2">
      {messages.map((msg) => {
        const isSelf = msg.fromAgentId === currentAgentId
        return (
          <div
            key={msg.id}
            className={`px-2 py-1.5 rounded-md border border-border ${isSelf ? 'bg-accent/5 border-accent/20' : 'bg-surface-3'}`}
          >
            <div className="flex items-center gap-1.5 mb-0.5">
              <code className="text-[10px] font-mono font-[760] text-accent">
                {isSelf ? '→ ' : '← '}{isSelf ? msg.toAgentId : msg.fromAgentId}
              </code>
              <time className="text-[10px] text-muted-foreground font-mono ml-auto">
                {new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}
              </time>
            </div>
            <p className="text-xs m-0 leading-snug break-words">
              {typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}
            </p>
          </div>
        )
      })}
    </div>
  )
}

// ── 频道面板 ──

function ChannelsPanel(): ReactElement {
  const queryClient = useQueryClient()
  const activeAgentId = useSessionStore((s) => s.activeAgentId)
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null)
  const [messageText, setMessageText] = useState('')
  const [sending, setSending] = useState(false)

  // 频道列表
  const channelsQuery = useQuery({
    queryKey: ['agent-channels'],
    queryFn: () => getAgentChannels(),
    refetchInterval: 15_000,
  })

  // 选中频道的消息
  const messagesQuery = useQuery({
    queryKey: ['channel-messages', selectedChannel],
    queryFn: () => selectedChannel ? getChannelMessages(selectedChannel) : Promise.resolve([]),
    enabled: !!selectedChannel,
    refetchInterval: 5_000,
  })

  const channels = channelsQuery.data ?? []
  const messages = messagesQuery.data ?? []

  async function handleSend(): Promise<void> {
    if (!selectedChannel || !messageText.trim()) return
    setSending(true)
    try {
      await sendChannelMessage(activeAgentId, selectedChannel, messageText.trim())
      setMessageText('')
      void queryClient.invalidateQueries({ queryKey: ['channel-messages', selectedChannel] })
    } catch {
      // 忽略发送失败
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="grid grid-rows-[auto_minmax(0,1fr)_auto] gap-2 h-full">
      {/* 频道列表 */}
      <div className="grid gap-1 max-h-[160px] overflow-y-auto">
        {channelsQuery.isLoading ? (
          <p className="text-xs text-muted-foreground m-0 px-1">加载中...</p>
        ) : channels.length === 0 ? (
          <p className="text-xs text-muted-foreground m-0 px-1">暂无频道</p>
        ) : (
          channels.map((ch) => (
            <button
              key={ch.name}
              type="button"
              onClick={() => setSelectedChannel(ch.name)}
              className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                selectedChannel === ch.name
                  ? 'bg-accent/10 text-accent'
                  : 'hover:bg-surface-3'
              }`}
            >
              <HashIcon className="size-3 shrink-0" />
              <span className="truncate font-[760]">{ch.name}</span>
              <Badge variant="secondary" className="ml-auto px-1 py-0 text-[9px] shrink-0 tabular-nums">
                {ch.messageCount}
              </Badge>
            </button>
          ))
        )}
      </div>

      {/* 消息流 */}
      <div className="overflow-y-auto min-h-0">
        {selectedChannel ? (
          <ChannelMessageList messages={messages} />
        ) : (
          <p className="text-xs text-muted-foreground text-center py-6 m-0">选择一个频道查看消息</p>
        )}
      </div>

      {/* 发送消息 */}
      {selectedChannel && (
        <div className="flex items-center gap-1.5">
          <Input
            value={messageText}
            onChange={(e) => setMessageText(e.target.value)}
            placeholder={`发送到 #${selectedChannel}`}
            className="h-7 text-xs"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleSend()
              }
            }}
          />
          <Button
            size="icon-sm"
            disabled={!messageText.trim() || sending}
            onClick={() => void handleSend()}
            aria-label="发送"
          >
            <SendIcon className="size-3" />
          </Button>
        </div>
      )}
    </div>
  )
}

// ── 私信面板 ──

function DmPanel(): ReactElement {
  const queryClient = useQueryClient()
  const activeAgentId = useSessionStore((s) => s.activeAgentId)
  const [targetAgentId, setTargetAgentId] = useState('')
  const [messageText, setMessageText] = useState('')
  const [sending, setSending] = useState(false)

  // 私信历史
  const dmQuery = useQuery({
    queryKey: ['dm-messages', activeAgentId],
    queryFn: () => getDirectMessages(activeAgentId),
    refetchInterval: 5_000,
  })

  const messages = dmQuery.data ?? []

  async function handleSend(): Promise<void> {
    if (!targetAgentId.trim() || !messageText.trim()) return
    setSending(true)
    try {
      await sendDirectMessage(activeAgentId, targetAgentId.trim(), messageText.trim())
      setMessageText('')
      void queryClient.invalidateQueries({ queryKey: ['dm-messages', activeAgentId] })
    } catch {
      // 忽略发送失败
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="grid grid-rows-[auto_minmax(0,1fr)_auto] gap-2 h-full">
      {/* 发送私信表单 */}
      <div className="grid gap-1.5">
        <Label className="text-[10px] text-muted-foreground">发送私信</Label>
        <div className="flex items-center gap-1.5">
          <Input
            value={targetAgentId}
            onChange={(e) => setTargetAgentId(e.target.value)}
            placeholder="目标 Agent ID"
            className="h-7 text-xs"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Input
            value={messageText}
            onChange={(e) => setMessageText(e.target.value)}
            placeholder="消息内容"
            className="h-7 text-xs"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleSend()
              }
            }}
          />
          <Button
            size="icon-sm"
            disabled={!targetAgentId.trim() || !messageText.trim() || sending}
            onClick={() => void handleSend()}
            aria-label="发送私信"
          >
            <SendIcon className="size-3" />
          </Button>
        </div>
      </div>

      {/* 私信历史 */}
      <div className="overflow-y-auto min-h-0">
        <DmMessageList messages={messages} currentAgentId={activeAgentId} />
      </div>
    </div>
  )
}

// ── 主组件 ──

/**
 * AgentCommunicationPanel：Agent 间通信面板
 *
 * 作为右侧面板的一个 tab（与上下文面板并列）
 * - 频道列表：显示所有已订阅频道
 * - 频道消息流：显示频道中的消息
 * - DM 列表：显示与其他 Agent 的私信
 * - 发送消息功能
 */
export function AgentCommunicationPanel(): ReactElement {
  const [tab, setTab] = useState<'channels' | 'dm'>('channels')

  return (
    <div className="grid grid-rows-[auto_minmax(0,1fr)] gap-2 h-full px-3 py-2">
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'channels' | 'dm')}>
        <TabsList className="w-full grid grid-cols-2 rounded-none border-b border-border bg-transparent h-8 p-0">
          <TabsTrigger
            value="channels"
            className="rounded-none data-[state=active]:bg-surface-2 data-[state=active]:shadow-none text-xs"
          >
            <HashIcon className="size-3 mr-1" />
            频道
          </TabsTrigger>
          <TabsTrigger
            value="dm"
            className="rounded-none data-[state=active]:bg-surface-2 data-[state=active]:shadow-none text-xs"
          >
            <MessageSquareIcon className="size-3 mr-1" />
            私信
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="min-h-0 overflow-hidden">
        {tab === 'channels' ? <ChannelsPanel /> : <DmPanel />}
      </div>
    </div>
  )
}
