import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Search, X, ChevronLeft, ChevronRight } from 'lucide-react'
import { getApi, deleteApi } from '@/api'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { FactCard, type FactItem } from './fact-card'

type FactListResponse = {
  facts: FactItem[]
  total: number
}

type SearchResponse = {
  facts: Array<{
    id: string
    content: string
    tags: string[]
    confidence: number
    source: string
  }>
  total: number
}

const PAGE_SIZE = 10

export interface FactListProps {
  /** 初始标签筛选（从记忆面板传入） */
  initialTag?: string
}

export function FactList({ initialTag }: FactListProps) {
  const queryClient = useQueryClient()
  const [searchQuery, setSearchQuery] = useState('')
  const [activeTag, setActiveTag] = useState(initialTag ?? '')
  const [page, setPage] = useState(0)

  // 搜索模式：有搜索关键词时使用 /api/memory/search
  const isSearchMode = searchQuery.trim().length > 0

  // 构建查询参数
  const listParams = useMemo(() => {
    const params = new URLSearchParams()
    if (activeTag) params.set('tag', activeTag)
    params.set('limit', String(PAGE_SIZE))
    params.set('offset', String(page * PAGE_SIZE))
    return params.toString()
  }, [activeTag, page])

  const searchParams = useMemo(() => {
    const params = new URLSearchParams()
    params.set('q', searchQuery.trim())
    if (activeTag) params.set('tags', activeTag)
    return params.toString()
  }, [searchQuery, activeTag])

  // 事实列表查询
  const listQuery = useQuery({
    queryKey: ['memory-facts', activeTag, page],
    queryFn: () => getApi<FactListResponse>(`/api/memory/facts?${listParams}`),
    enabled: !isSearchMode,
  })

  // 搜索查询
  const searchQuery_ = useQuery({
    queryKey: ['memory-search', searchQuery, activeTag],
    queryFn: () => getApi<SearchResponse>(`/api/memory/search?${searchParams}`),
    enabled: isSearchMode,
  })

  const currentQuery = isSearchMode ? searchQuery_ : listQuery
  const facts: FactItem[] = isSearchMode
    ? (searchQuery_.data?.facts ?? []).map((f) => ({
        ...f,
        createdAt: 0,
        updatedAt: 0,
        accessCount: 0,
        lastAccessedAt: 0,
      }))
    : listQuery.data?.facts ?? []

  const total = currentQuery.data?.total ?? 0
  const totalPages = isSearchMode ? 1 : Math.ceil(total / PAGE_SIZE)

  // 收集所有已知标签（从当前事实列表中提取）
  const allTags = useMemo(() => {
    const tagSet = new Set<string>()
    for (const fact of facts) {
      for (const tag of fact.tags) {
        tagSet.add(tag)
      }
    }
    return Array.from(tagSet).sort()
  }, [facts])

  // 删除事实
  const handleDelete = useCallback(
    async (id: string) => {
      await deleteApi<{ deleted: boolean }>(`/api/memory/facts/${id}`)
      await queryClient.invalidateQueries({ queryKey: ['memory-facts'] })
      await queryClient.invalidateQueries({ queryKey: ['memory-search'] })
    },
    [queryClient]
  )

  // 清除搜索
  const handleClearSearch = useCallback(() => {
    setSearchQuery('')
    setPage(0)
  }, [])

  // 清除标签筛选
  const handleClearTag = useCallback(() => {
    setActiveTag('')
    setPage(0)
  }, [])

  // 选择标签筛选
  const handleSelectTag = useCallback((tag: string) => {
    setActiveTag((prev) => (prev === tag ? '' : tag))
    setPage(0)
  }, [])

  // 搜索提交
  const handleSearchSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      setPage(0)
    },
    []
  )

  // initialTag 变化时同步
  useEffect(() => {
    if (initialTag) {
      setActiveTag(initialTag)
      setPage(0)
    }
  }, [initialTag])

  return (
    <div className="grid gap-3 min-h-0 overflow-auto p-4 align-content-start">
      {/* 搜索框 */}
      <form onSubmit={handleSearchSubmit} className="relative">
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
            className="absolute right-1.5 top-1/2 -translate-y-1/2 grid size-6 place-items-center rounded text-muted-foreground hover:text-text hover:bg-surface-2"
            onClick={handleClearSearch}
            aria-label="清除搜索"
          >
            <X className="size-3.5" />
          </button>
        )}
      </form>

      {/* 标签筛选 */}
      <div className="flex flex-wrap gap-1.5">
        {activeTag && (
          <Badge
            variant="default"
            className="cursor-pointer text-[10px] px-1.5 py-0 h-5 gap-1"
            onClick={handleClearTag}
          >
            {activeTag}
            <X className="size-2.5" />
          </Badge>
        )}
        {allTags
          .filter((t) => t !== activeTag)
          .map((tag) => (
            <Badge
              key={tag}
              variant="outline"
              className="cursor-pointer text-[10px] px-1.5 py-0 h-5"
              onClick={() => handleSelectTag(tag)}
            >
              {tag}
            </Badge>
          ))}
      </div>

      {/* 事实列表 */}
      <div className="grid gap-2">
        {currentQuery.isLoading && (
          <p className="text-muted-foreground text-xs text-center py-4">加载中...</p>
        )}
        {currentQuery.error && (
          <p className="text-danger text-xs text-center py-4">
            加载失败: {currentQuery.error instanceof Error ? currentQuery.error.message : '未知错误'}
          </p>
        )}
        {!currentQuery.isLoading && !currentQuery.error && facts.length === 0 && (
          <p className="text-muted-foreground text-xs text-center py-4">
            {isSearchMode ? '未找到匹配的事实' : '暂无事实，发送消息后 Agent 会自动提取记忆'}
          </p>
        )}
        {facts.map((fact) => (
          <FactCard key={fact.id} fact={fact} onDelete={handleDelete} />
        ))}
      </div>

      {/* 分页 */}
      {!isSearchMode && totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="tabular-nums">
            共 {total} 条 · 第 {page + 1}/{totalPages} 页
          </span>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="xs"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="size-3" />
              上一页
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
              <ChevronRight className="size-3" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
