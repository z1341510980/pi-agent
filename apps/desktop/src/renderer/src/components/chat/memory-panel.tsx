import { useCallback, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Zap } from 'lucide-react'
import { getApi, postApi, deleteApi } from '@/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { FactCard, type FactItem } from '@/components/memory/fact-card'

type FactsOverview = {
  facts: FactItem[]
  total: number
}

type CompileStatus =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'success'; message: string }
  | { state: 'error'; message: string }

export interface MemoryPanelProps {
  isOnline: boolean
}

export function MemoryPanel({ isOnline }: MemoryPanelProps) {
  const queryClient = useQueryClient()
  const [compileStatus, setCompileStatus] = useState<CompileStatus>({ state: 'idle' })
  const [selectedTag, setSelectedTag] = useState<string | undefined>()

  // 加载置顶记忆概览（取最近 5 条）
  const overviewQuery = useQuery({
    queryKey: ['memory-overview'],
    queryFn: () => getApi<FactsOverview>('/api/memory/facts?limit=5&offset=0'),
    refetchInterval: 30_000,
  })

  const facts = overviewQuery.data?.facts ?? []
  const total = overviewQuery.data?.total ?? 0

  // 收集所有标签
  const allTags = Array.from(
    new Set(facts.flatMap((f) => f.tags))
  ).sort()

  // 编译按钮：触发记忆编译（暂用 POST /api/memory/facts 模拟）
  const handleCompile = useCallback(async () => {
    setCompileStatus({ state: 'running' })
    try {
      await postApi<FactItem>('/api/memory/facts', {
        content: `[编译触发] ${new Date().toISOString()}`,
        tags: ['compile-trigger'],
        source: 'manual-compile',
        confidence: 0.5,
      })
      setCompileStatus({ state: 'success', message: '记忆编译完成。' })
      await queryClient.invalidateQueries({ queryKey: ['memory-overview'] })
    } catch (error) {
      const message = error instanceof Error ? error.message : '记忆编译失败。'
      setCompileStatus({ state: 'error', message })
    }
  }, [queryClient])

  // 删除事实
  const handleDelete = useCallback(
    async (id: string) => {
      await deleteApi<{ deleted: boolean }>(`/api/memory/facts/${id}`)
      await queryClient.invalidateQueries({ queryKey: ['memory-overview'] })
    },
    [queryClient]
  )

  return (
    <section className="grid gap-3.5 min-h-0 overflow-auto p-4 align-content-start">
      {/* 记忆概览 */}
      <div className="bg-surface-2 border border-border rounded-lg grid gap-2 p-3">
        <div className="flex items-center justify-between">
          <p className="text-subtle text-xs font-[760] m-0">记忆概览</p>
          <span className="text-muted text-xs">{total} 条事实</span>
        </div>
        {overviewQuery.isLoading && (
          <p className="text-muted-foreground text-xs">加载中...</p>
        )}
        {overviewQuery.error && (
          <p className="text-danger text-xs">
            加载失败: {overviewQuery.error instanceof Error ? overviewQuery.error.message : '未知错误'}
          </p>
        )}
        {!overviewQuery.isLoading && facts.length === 0 && (
          <p className="text-muted-foreground text-xs">暂无记忆，发送消息后 Agent 会自动提取</p>
        )}
        <div className="grid gap-2">
          {facts.map((fact) => (
            <FactCard key={fact.id} fact={fact} onDelete={handleDelete} compact />
          ))}
        </div>
      </div>

      {/* 标签快捷筛选 */}
      {allTags.length > 0 && (
        <div className="bg-surface-2 border border-border rounded-lg grid gap-2 p-3">
          <p className="text-subtle text-xs font-[760] m-0">标签</p>
          <div className="flex flex-wrap gap-1.5">
            {allTags.map((tag) => (
              <Badge
                key={tag}
                variant={selectedTag === tag ? 'default' : 'outline'}
                className="cursor-pointer text-[10px] px-1.5 py-0 h-5"
                onClick={() => setSelectedTag((prev) => (prev === tag ? undefined : tag))}
              >
                {tag}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* 立即编译按钮 */}
      <div className="bg-surface-2 border border-border rounded-lg grid gap-2 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-subtle text-xs font-[760] m-0">记忆编译</p>
            <p className="text-muted text-xs leading-relaxed m-0">
              {getCompileStatusText(compileStatus)}
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleCompile()}
            disabled={!isOnline || compileStatus.state === 'running'}
          >
            {compileStatus.state === 'running' ? (
              <>
                <Loader2 className="size-3 animate-spin" />
                编译中
              </>
            ) : (
              <>
                <Zap className="size-3" />
                立即编译
              </>
            )}
          </Button>
        </div>
        {(compileStatus.state === 'success' || compileStatus.state === 'error') && (
          <p
            className={`text-xs leading-relaxed m-0 ${compileStatus.state === 'success' ? 'text-success' : 'text-danger'}`}
            role="status"
          >
            {compileStatus.message}
          </p>
        )}
      </div>
    </section>
  )
}

function getCompileStatusText(status: CompileStatus): string {
  switch (status.state) {
    case 'running':
      return '正在编译记忆，请稍候...'
    case 'success':
      return '最近一次编译已完成。'
    case 'error':
      return '最近一次编译失败，请检查 Agent Server。'
    case 'idle':
      return '手动触发记忆编译，提取当前会话关键信息。'
  }
}
