/**
 * 插件管理页面
 *
 * 显示所有已注册插件的列表，支持启用/禁用、查看详情和授权管理。
 * 对应后端 `/api/plugins` 路由。
 */

import type { ReactElement } from 'react'
import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  PlusIcon,
  RefreshCwIcon,
  PowerIcon,
  PowerOffIcon,
  ShieldIcon,
  Loader2Icon,
  CheckCircle2Icon,
  AlertCircleIcon,
  CircleIcon
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { toast } from '@/hooks/use-toast'
import { SlotRenderer } from '../slot'
import { requestSlotRevalidation } from '../../core'
import type { PluginListItem } from '../../api/plugin-client.js'
import {
  getPlugins,
  enablePlugin,
  disablePlugin,
  reloadPlugin,
  updatePluginGrants,
  getPlugin,
  inspectPlugin
} from '../../api/plugin-client.js'

// 可用的能力列表（用于授权管理）
// 必须与服务端 plugin-types.ts 的 PluginCapability 及 plugin-catalog.ts 的
// ALL_PLUGIN_CAPABILITIES 保持一致：服务端会拒绝未知 capability。
const AVAILABLE_CAPABILITIES = [
  'tools.register',
  'agent.hooks',
  'provider.transform',
  'provider.observe',
  'routes.register',
  'storage.plugin',
  'ui.contribute',
  'network.outbound',
  'process.exec',
  'session.create',
  'agent.orchestrate',
  'confirmation.request'
] as const

/** 授权弹窗里给每个能力配一句人类可读说明，避免用户凭字面猜风险 */
const CAPABILITY_HINTS: Record<string, string> = {
  'tools.register': '向会话注册工具',
  'agent.hooks': '注册 Agent 生命周期钩子',
  'provider.transform': '改写模型请求与响应（高风险）',
  'provider.observe': '只读观察模型请求',
  'routes.register': '注册 HTTP 路由（需重启生效）',
  'storage.plugin': '访问数据库、注册迁移与服务（高风险）',
  'ui.contribute': '贡献桌面 UI 面板',
  'network.outbound': '发起外部网络请求（高风险）',
  'process.exec': '执行子进程（高风险）',
  'session.create': '创建独立会话，会消耗模型额度',
  'agent.orchestrate': '访问子 Agent / 团队管理器',
  'confirmation.request': '发起用户确认请求'
}

type Capability = (typeof AVAILABLE_CAPABILITIES)[number]

/**
 * 插件状态徽章
 *
 * status 是实际状态，desiredEnabled 是配置里的期望状态。两者不一致时必须显式提示：
 * "配置里开着但没跑起来"和"用户自己关掉了"对用户是完全不同的信息。
 */
function StatusBadge({
  status,
  restartRequired,
  desiredEnabled,
  dependencyDiagnostics,
  effectiveAfterRestart
}: {
  status: PluginListItem['status']
  restartRequired?: boolean
  desiredEnabled?: boolean
  dependencyDiagnostics?: string[]
  effectiveAfterRestart?: boolean
}): ReactElement {
  const config: Record<
    string,
    {
      label: string
      variant: 'default' | 'secondary' | 'destructive' | 'outline'
      icon: React.ElementType
    }
  > = {
    enabled: { label: '已启用', variant: 'default', icon: CheckCircle2Icon },
    disabled: { label: '已禁用', variant: 'secondary', icon: CircleIcon },
    loaded: { label: '已加载', variant: 'outline', icon: CircleIcon },
    error: { label: '错误', variant: 'destructive', icon: AlertCircleIcon }
  }

  const { label, variant, icon: Icon } = config[status] ?? config.loaded
  // 期望启用但实际没跑起来：不能只显示"已禁用"，那会让用户以为是自己关的
  const desiredMismatch = desiredEnabled === true && status !== 'enabled'

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={variant}>
        <Icon className="mr-1 size-3" />
        {label}
      </Badge>
      {desiredMismatch && (
        <Badge
          variant="outline"
          className="border-amber-400 text-amber-600 dark:border-amber-500 dark:text-amber-400"
        >
          配置期望启用
        </Badge>
      )}
      {restartRequired && (
        <Badge
          variant="outline"
          className="border-amber-400 text-amber-600 dark:border-amber-500 dark:text-amber-400"
        >
          需重启
        </Badge>
      )}
      {effectiveAfterRestart && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                variant="outline"
                className="border-amber-400 text-amber-600 dark:border-amber-500 dark:text-amber-400"
              >
                路由待重启生效
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              插件已完成初始化，但它注册的 HTTP 路由和服务只在启动期挂载，需重启服务后才可访问。
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {dependencyDiagnostics && dependencyDiagnostics.length > 0 && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="destructive">依赖不满足</Badge>
            </TooltipTrigger>
            <TooltipContent>
              <div className="flex max-w-xs flex-col gap-1">
                {dependencyDiagnostics.map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  )
}

/**
 * 插件来源徽章
 */
function SourceBadge({ source }: { source: PluginListItem['source'] }): ReactElement {
  const labels: Record<PluginListItem['source'], string> = {
    builtin: '内置',
    local: '本地',
    npm: 'NPM'
  }
  return <Badge variant="outline">{labels[source] ?? source}</Badge>
}

/**
 * 完整性徽章。
 *
 * unverified 必须在列表里看得见 —— 用户有权知道哪些插件的代码没经过校验就被加载了。
 * builtin 随应用构建，不适用包级锁，不显示徽章以免制造噪声。
 */
function IntegrityBadge({
  status
}: {
  status: PluginListItem['integrityStatus']
}): ReactElement | null {
  if (status === 'not-applicable') return null
  if (status === 'verified') {
    return (
      <Badge variant="outline" title="包摘要与 plugins.yml 的锁一致">
        已校验
      </Badge>
    )
  }
  return (
    <Badge variant="destructive" title="plugins.yml 缺少 integrity/resolvedVersion，代码未经校验">
      未校验
    </Badge>
  )
}

/**
 * 插件管理主页面
 */
export function PluginPage(): ReactElement {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [selectedPlugin, setSelectedPlugin] = useState<string | null>(null)
  const [showGrantDialog, setShowGrantDialog] = useState(false)
  const [editingGrants, setEditingGrants] = useState<Set<Capability>>(new Set())
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof getPlugin>> | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [inspectOpen, setInspectOpen] = useState(false)
  const [inspectPluginId, setInspectPluginId] = useState<string | null>(null)

  // 查询插件列表
  const {
    data: plugins,
    isLoading,
    error,
    refetch
  } = useQuery({
    queryKey: ['plugins'],
    queryFn: getPlugins,
    staleTime: 5_000
  })

  const inspectQuery = useQuery({
    queryKey: ['plugin-inspect', inspectPluginId],
    queryFn: () => inspectPlugin(inspectPluginId!),
    enabled: inspectOpen && inspectPluginId !== null,
    staleTime: 2_000
  })

  // 启用插件
  const enableMutation = useMutation({
    mutationFn: (pluginId: string) => enablePlugin(pluginId),
    onSuccess: (result) => {
      toast({
        title: '插件已启用',
        description: result.restartRequired ? '需要重启服务才能完全生效' : ''
      })
      queryClient.invalidateQueries({ queryKey: ['plugins'] })
      // 插件集合变了：让 Slot registry 重新对齐贡献，被禁用的贡献要立刻从 UI 撤下
      requestSlotRevalidation()
    },
    onError: (error: Error) => {
      toast({
        title: '启用失败',
        description: error.message,
        variant: 'destructive'
      })
    }
  })

  // 禁用插件
  const disableMutation = useMutation({
    mutationFn: (pluginId: string) => disablePlugin(pluginId),
    onSuccess: (result) => {
      toast({
        title: '插件已禁用',
        description: result.restartRequired ? '需要重启服务才能完全卸载' : ''
      })
      queryClient.invalidateQueries({ queryKey: ['plugins'] })
      // 插件集合变了：让 Slot registry 重新对齐贡献，被禁用的贡献要立刻从 UI 撤下
      requestSlotRevalidation()
    },
    onError: (error: Error) => {
      toast({
        title: '禁用失败',
        description: error.message,
        variant: 'destructive'
      })
    }
  })

  // 重载插件
  const reloadMutation = useMutation({
    mutationFn: (pluginId: string) => reloadPlugin(pluginId),
    onSuccess: () => {
      toast({ title: '插件已重载' })
      queryClient.invalidateQueries({ queryKey: ['plugins'] })
      // 插件集合变了：让 Slot registry 重新对齐贡献，被禁用的贡献要立刻从 UI 撤下
      requestSlotRevalidation()
    },
    onError: (error: Error) => {
      toast({
        title: '重载失败',
        description: error.message,
        variant: 'destructive'
      })
    }
  })

  // 更新授权
  const grantMutation = useMutation({
    mutationFn: ({ pluginId, grants }: { pluginId: string; grants: string[] }) =>
      updatePluginGrants(pluginId, grants),
    onSuccess: () => {
      toast({ title: '授权已更新' })
      setShowGrantDialog(false)
      queryClient.invalidateQueries({ queryKey: ['plugins'] })
      // 插件集合变了：让 Slot registry 重新对齐贡献，被禁用的贡献要立刻从 UI 撤下
      requestSlotRevalidation()
    },
    onError: (error: Error) => {
      toast({
        title: '更新授权失败',
        description: error.message,
        variant: 'destructive'
      })
    }
  })

  // 过滤插件
  const filteredPlugins = useMemo(() => {
    if (!plugins) return []
    const query = search.toLowerCase().trim()
    if (!query) return plugins
    return plugins.filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        p.description?.toLowerCase().includes(query) ||
        p.author?.toLowerCase().includes(query)
    )
  }, [plugins, search])

  // 处理启用/禁用切换
  const handleToggle = (plugin: PluginListItem) => {
    if (plugin.status === 'enabled') {
      disableMutation.mutate(plugin.name)
    } else if (plugin.status === 'disabled' || plugin.status === 'loaded') {
      enableMutation.mutate(plugin.name)
    }
  }

  // 处理授权更新
  const handleGrantUpdate = () => {
    if (!selectedPlugin) return
    grantMutation.mutate({
      pluginId: selectedPlugin,
      grants: Array.from(editingGrants)
    })
  }

  // 打开授权对话框
  const handleOpenGrantDialog = async (pluginId: string) => {
    setSelectedPlugin(pluginId)
    setShowGrantDialog(true)
    setDetailLoading(true)
    try {
      const nextDetail = await getPlugin(pluginId)
      setDetail(nextDetail)
      setEditingGrants(
        new Set(
          nextDetail.grants.filter((grant): grant is Capability =>
            (AVAILABLE_CAPABILITIES as readonly string[]).includes(grant)
          )
        )
      )
    } catch (error) {
      setShowGrantDialog(false)
      toast({
        title: '加载插件授权失败',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive'
      })
    } finally {
      setDetailLoading(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2Icon className="size-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <AlertCircleIcon className="size-12 text-destructive" />
        <p className="text-sm text-muted-foreground">加载插件列表失败: {error.message}</p>
        <Button variant="outline" onClick={() => refetch()}>
          重试
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4 p-6">
      {/* 标题栏 */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold">插件管理</h2>
          <p className="text-sm text-muted-foreground">管理已安装的插件，启用/禁用或调整授权</p>
          {plugins?.some((plugin) => plugin.restartRequired) && (
            <p className="mt-1 text-xs text-amber-600">
              部分变更已记录，路由/服务将在重启后完全卸载或生效。
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCwIcon className="mr-1 size-4" />
            刷新
          </Button>
          <Button size="sm">
            <PlusIcon className="mr-1 size-4" />
            安装插件
          </Button>
        </div>
      </div>

      {/* Slot: 插件管理页面顶部贡献区 */}
      <SlotRenderer name="plugin-page.top" fallback={null} />

      {/* 搜索框 */}
      <div className="flex items-center gap-4">
        <Input
          placeholder="搜索插件名称、描述或作者..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
        <span className="text-sm text-muted-foreground">共 {filteredPlugins.length} 个插件</span>
      </div>

      {/* 插件列表 */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>版本</TableHead>
                <TableHead>来源</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>工具</TableHead>
                <TableHead>路由</TableHead>
                <TableHead>面板</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredPlugins.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                    {search ? '没有匹配的插件' : '没有已加载的插件'}
                  </TableCell>
                </TableRow>
              ) : (
                filteredPlugins.map((plugin) => (
                  <TableRow key={plugin.name}>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium">{plugin.name}</span>
                        {plugin.description && (
                          <span className="text-xs text-muted-foreground">
                            {plugin.description}
                          </span>
                        )}
                        {plugin.author && (
                          <span className="text-xs text-muted-foreground/70">
                            作者: {plugin.author}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-sm">{plugin.version}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <SourceBadge source={plugin.source} />
                        <IntegrityBadge status={plugin.integrityStatus} />
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        status={plugin.status}
                        restartRequired={plugin.restartRequired}
                        desiredEnabled={plugin.desiredEnabled}
                        dependencyDiagnostics={plugin.dependencyDiagnostics}
                        effectiveAfterRestart={plugin.effectiveAfterRestart}
                      />
                    </TableCell>
                    <TableCell>{plugin.toolCount}</TableCell>
                    <TableCell>{plugin.routeCount}</TableCell>
                    <TableCell>{plugin.panelCount}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {/* 启用/禁用切换 */}
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-8"
                                onClick={() => handleToggle(plugin)}
                                disabled={enableMutation.isPending || disableMutation.isPending}
                              >
                                {plugin.status === 'enabled' ? (
                                  <PowerOffIcon className="size-4 text-muted-foreground" />
                                ) : (
                                  <PowerIcon className="size-4 text-green-600" />
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              {plugin.status === 'enabled' ? '禁用插件' : '启用插件'}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>

                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          aria-label="查看插件诊断"
                          onClick={() => {
                            setInspectPluginId(plugin.name)
                            setInspectOpen(true)
                          }}
                        >
                          <AlertCircleIcon className="size-4" />
                        </Button>

                        {/* 授权管理 */}
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-8"
                                onClick={() => handleOpenGrantDialog(plugin.name)}
                              >
                                <ShieldIcon className="size-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>管理授权</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>

                        {/* 重载（仅对 local/npm 插件） */}
                        {plugin.source !== 'builtin' && (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-8"
                                  onClick={() => reloadMutation.mutate(plugin.name)}
                                  disabled={reloadMutation.isPending}
                                >
                                  <RefreshCwIcon className="size-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>重载插件</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={inspectOpen} onOpenChange={setInspectOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>插件运行诊断</DialogTitle>
            <DialogDescription>
              {inspectQuery.data?.plugin.pluginId ?? inspectPluginId ?? '未选择插件'} · generation{' '}
              {inspectQuery.data?.plugin.activationGeneration ?? '-'}
            </DialogDescription>
          </DialogHeader>
          {inspectQuery.isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2Icon className="size-6 animate-spin" />
            </div>
          ) : inspectQuery.error ? (
            <p className="text-sm text-destructive">加载诊断失败：{inspectQuery.error.message}</p>
          ) : inspectQuery.data ? (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <span>状态：{inspectQuery.data.plugin.lifecycle}</span>
                <span>版本：{inspectQuery.data.plugin.version}</span>
                <span>effect：{inspectQuery.data.effects.length}</span>
                <span>Slot：{inspectQuery.data.slots.length}</span>
              </div>
              {inspectQuery.data.plugin.restartRequired && (
                <p className="text-amber-600">存在需重启才能完全卸载的 route/service。</p>
              )}
              {inspectQuery.data.diagnostics.length > 0 && (
                <div className="rounded border border-destructive/30 bg-destructive/5 p-3 text-destructive">
                  {inspectQuery.data.diagnostics.map((item) => (
                    <p key={item}>{item}</p>
                  ))}
                </div>
              )}
              <div>
                <p className="mb-2 font-medium">Slot occupants</p>
                {inspectQuery.data.slots.length === 0 ? (
                  <p className="text-muted-foreground">无 UI contribution</p>
                ) : (
                  inspectQuery.data.slots.map((slot) => (
                    <div key={slot.contributionId} className="flex justify-between border-b py-1">
                      <span>
                        {slot.slot} · {slot.contributionId}
                      </span>
                      <span className="font-mono text-xs">
                        {slot.rendererKey} / {slot.state}
                      </span>
                    </div>
                  ))
                )}
              </div>
              {inspectQuery.data.plugin.lastStop && (
                <div className="rounded border p-3">
                  最后停止：{inspectQuery.data.plugin.lastStop.outcome}，残留 effect{' '}
                  {inspectQuery.data.plugin.lastStop.residualEffectCount}
                </div>
              )}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* 授权管理对话框 */}
      <Dialog open={showGrantDialog} onOpenChange={setShowGrantDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>管理授权</DialogTitle>
            <DialogDescription>
              {detailLoading
                ? '正在读取当前实际授权...'
                : `请求能力：${detail?.permissions.join(', ') || '无'}；当前授权：${detail?.grants.join(', ') || '无'}`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <p className="text-sm text-muted-foreground">选择要授予该插件的能力（全量替换）：</p>
            <div className="grid grid-cols-2 gap-2">
              {AVAILABLE_CAPABILITIES.map((cap) => (
                <div key={cap} className="flex items-center space-x-2">
                  <Switch
                    id={`cap-${cap}`}
                    checked={editingGrants.has(cap)}
                    onCheckedChange={(checked) => {
                      const next = new Set(editingGrants)
                      if (checked) {
                        next.add(cap)
                      } else {
                        next.delete(cap)
                      }
                      setEditingGrants(next)
                    }}
                  />
                  <Label htmlFor={`cap-${cap}`} className="text-sm">
                    <span className="block">{cap}</span>
                    <span className="block text-xs text-muted-foreground">
                      {CAPABILITY_HINTS[cap] ?? ''}
                    </span>
                  </Label>
                </div>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowGrantDialog(false)}>
              取消
            </Button>
            <Button
              onClick={handleGrantUpdate}
              disabled={grantMutation.isPending || detailLoading || !detail}
            >
              {grantMutation.isPending ? (
                <>
                  <Loader2Icon className="mr-2 size-4 animate-spin" />
                  保存中...
                </>
              ) : (
                '保存'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
