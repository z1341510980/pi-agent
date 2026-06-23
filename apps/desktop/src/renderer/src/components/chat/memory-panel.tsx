import { useCallback, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Zap, Search, X } from 'lucide-react'
import { getApi, postApi, deleteApi } from '@/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
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

const PAGE_SIZE = 5

export function MemoryPanel({ isOnline }: MemoryPanelProps) {
  const queryClient = useQueryClient()
  const [compileStatus, setCompileStatus] = useState<CompileStatus>({ state: 'idle' })
  const [selectedTag, setSelectedTag] = useState<string | undefined>()
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [searchQuery, setSearchQuery] = useState('')

  // 加载记忆概览（按 limit 分页加载）
  const overviewQuery = useQuery({
    queryKey: ['memory-overview', limit],
    queryFn: () =>
      getApi<FactsOverview>(`/api/memory/facts?limit=${limit}&offset=0`),
    refetchInterval: 30_000,
  })

  const allFacts = overviewQuery.data?.facts ?? []
  const total = overviewQuery.data?.total ?? 0

  // 客户端过滤：标签 + 搜索关键词
  const facts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return allFacts.filter((f) => {
      if (selectedTag && !f.tags.includes(selectedTag)) return false
      if (q && !f.content.toLowerCase().includes(q)) return false
      return true
    })
  }, [allFacts, selectedTag, searchQuery])

  // 收集所有标签（基于已加载的事实，保持稳定）
  const allTags = useMemo(
    () => Array.from(new Set(allFacts.flatMap((f) => f.tags))).sort(),
    [allFacts]
  )

  // 编译按钮：通过 EventBus 触发记忆编译
  const handleCompile = useCallback(async () => {
    setCompileStatus({ state: 'running' })
    try {
      await postApi<{ triggered: boolean }>('/api/memory/compile', {
        phase: 'manual',
      })
      setCompileStatus({ state: 'success', message: '记忆编译已触发。' })
      await queryClient.invalidateQueries({ queryKey: ['memory-overview'] })
    } catch (error) {
      const message = error instanceof Error ? error.message : '记忆编译失败。'
      setCompileStatus({ state: 'error', message })
    }
  }, [queryClient])

  // 删除事实
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const handleDelete = useCallback(
    async (id: string) => {
      setDeleteError(null)
      try {
        await deleteApi<{ deleted: boolean }>(`/api/memory/facts/${id}`)
        await queryClient.invalidateQueries({ queryKey: ['memory-overview'] })
      } catch (error) {
        const message = error instanceof Error ? error.message : '删除事实失败。'
        setDeleteError(message)
      }
    },
    [queryClient]
  )

  // 加载更多
  const handleLoadMore = useCallback(() => {
    setLimit((prev) => prev + PAGE_SIZE)
  }, [])

  const hasMore = allFacts.length < total
  const isFiltered = selectedTag !== undefined || searchQuery.trim().length > 0

  return (
    <section className="grid gap-3.5 min-h-0 overflow-auto p-4 align-content-start">
      {/* 搜索框 */}
      <form className="relative" onSubmit={(e) => e.preventDefault()}>
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
        <Input
          type="search"
          placeholder="搜索事实..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-8 pr-8 h-8 text-xs"
        />
        {searchQuery && (
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-text"
            onClick={() => setSearchQuery('')}
            aria-label="清除搜索"
          >
            <X className="size-3.5" />
          </button>
        )}
      </form>

      {/* 记忆概览 */}
      <div className="bg-surface-2 border border-border rounded-lg grid gap-2 p-3">
        <div className="flex items-center justify-between">
          <p className="text-subtle text-xs font-[760] m-0">记忆概览</p>
          <span className="text-muted-foreground text-xs">
            {isFiltered ? `${facts.length}/${total} 条` : `${total} 条事实`}
          </span>
        </div>
        {overviewQuery.isLoading && (
          <p className="text-muted-foreground text-xs">加载中...</p>
        )}
        {overviewQuery.error && (
          <p className="text-danger text-xs">
            加载失败: {overviewQuery.error instanceof Error ? overviewQuery.error.message : '未知错误'}
          </p>
        )}
        {!overviewQuery.isLoading && allFacts.length === 0 && (
          <p className="text-muted-foreground text-xs">暂无记忆，发送消息后 Agent 会自动提取</p>
        )}
        {allFacts.length > 0 && facts.length === 0 && (
          <p className="text-muted-foreground text-xs">未找到匹配的事实</p>
        )}
        <div className="grid gap-2">
          {facts.map((fact) => (
            <FactCard key={fact.id} fact={fact} onDelete={handleDelete} compact />
          ))}
        </div>
        {hasMore && (
          <Button
            variant="ghost"
            size="xs"
            onClick={handleLoadMore}
            disabled={overviewQuery.isFetching}
          >
            {overviewQuery.isFetching ? '加载中...' : '加载更多'}
          </Button>
        )}
      </div>

      {/* 标签快捷筛选 */}
      {allTags.length > 0 && (
        <div className="bg-surface-2 border border-border rounded-lg grid gap-2 p-3">
          <div className="flex items-center justify-between">
            <p className="text-subtle text-xs font-[760] m-0">标签</p>
            {selectedTag && (
              <button
                type="button"
                className="text-muted-foreground text-[10px] hover:text-text"
                onClick={() => setSelectedTag(undefined)}
              >
                清除筛选
              </button>
            )}
          </div>
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
            <p className="text-muted-foreground text-xs leading-relaxed m-0">
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
        {deleteError && (
          <p className="text-xs text-danger m-0" role="alert">
            {deleteError}
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
