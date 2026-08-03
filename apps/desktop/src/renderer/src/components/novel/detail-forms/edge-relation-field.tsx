import { useCallback, useMemo, useState, type ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useNovelDataStore } from '@/stores/novel-data-store'
import {
  createEdge,
  deleteEdge,
  type NovelEdgeType,
  type NovelNodeTypeName,
} from '@/api/novel-client'
import { EntityPicker, type EntityOption } from './entity-picker'

/**
 * EdgeRelationField —— 由 edges 表承载的关联字段。
 *
 * ## 为什么需要
 *
 * 一批关联数据（角色↔冲突、伏笔↔信息差、伏笔↔线索）已从实体字段迁到 `edges` 表，
 * 但表单侧从未跟上：`info-layer-form` 写死 `linkedForeshadowIds = []`，
 * `character-form` / `foreshadow-form` 直接删掉了整个分区并留注释说
 * 「需要时应通过 edges 查询实现」。结果是这些关联**只能在画布上连线建立**，
 * 详情面板里既看不到也改不了。
 *
 * 这个组件把 edges 的增删封装成一个多选字段：读取时按 `edgeType` + 端点过滤
 * store 里的 edges，写入时直接调 `createEdge` / `deleteEdge`。
 *
 * ## 保存契约：immediate
 *
 * 与同表单其他字段（explicit，需点保存）不同 —— edges 是独立资源，
 * 没有"草稿"概念，勾选即建立关联。这与画布连线的行为一致：
 * 在画布上拉一条线也是立即入库。
 *
 * 契约不同必须让用户看见，所以字段上标注「即时生效」。
 */

export interface EdgeRelationFieldProps {
  /** 当前实体 ID */
  entityId: string
  /** 当前实体类型 */
  entityType: NovelNodeTypeName
  /** 关联的目标实体类型 */
  targetType: NovelNodeTypeName
  /** 边类型 */
  edgeType: NovelEdgeType
  /** 候选目标 */
  options: EntityOption[]
  placeholder?: string
  searchPlaceholder?: string
  emptyHint?: string
  /**
   * 当前实体在边中的位置。
   *
   * edges 是有向的，但「关联」在语义上常是双向的（角色参与冲突 =
   * 冲突包含角色）。调用方声明自己是 source 还是 target，
   * 组件据此决定读取时匹配哪一端、写入时把自己放哪一端。
   */
  side?: 'source' | 'target'
}

export function EdgeRelationField({
  entityId,
  entityType,
  targetType,
  edgeType,
  options,
  placeholder,
  searchPlaceholder,
  emptyHint,
  side = 'source',
}: EdgeRelationFieldProps): ReactElement {
  const currentProjectId = useNovelDataStore((s) => s.currentProjectId)
  const edges = useNovelDataStore((s) => s.edges)
  const addEdgeToStore = useNovelDataStore((s) => s.addEdge)
  const removeEdgeFromStore = useNovelDataStore((s) => s.removeEdge)
  const queryClient = useQueryClient()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** 与本字段相关的边：类型匹配 + 本实体在声明的那一端 */
  const relatedEdges = useMemo(
    () =>
      edges.filter((e) => {
        if (e.edgeType !== edgeType) return false
        return side === 'source'
          ? e.sourceId === entityId && e.targetType === targetType
          : e.targetId === entityId && e.sourceType === targetType
      }),
    [edges, edgeType, entityId, targetType, side],
  )

  const value = useMemo(
    () => relatedEdges.map((e) => (side === 'source' ? e.targetId : e.sourceId)),
    [relatedEdges, side],
  )

  const handleChange = useCallback(
    async (next: string[]) => {
      if (!currentProjectId) return
      const added = next.filter((id) => !value.includes(id))
      const removed = value.filter((id) => !next.includes(id))
      if (added.length === 0 && removed.length === 0) return

      setPending(true)
      setError(null)
      try {
        for (const id of added) {
          const edge = await createEdge(currentProjectId, {
            sourceId: side === 'source' ? entityId : id,
            sourceType: side === 'source' ? entityType : targetType,
            targetId: side === 'source' ? id : entityId,
            targetType: side === 'source' ? targetType : entityType,
            edgeType,
            label: '',
            // 运行时创建的边一律 auto:false。`auto:true` 目前只由迁移 074
            // （把旧的关联字段搬进 edges 表）写入，没有任何运行时路径会产生它。
            auto: false,
          })
          addEdgeToStore(edge)
        }
        for (const id of removed) {
          const target = relatedEdges.find(
            (e) => (side === 'source' ? e.targetId : e.sourceId) === id,
          )
          if (!target) continue
          await deleteEdge(target.id)
          removeEdgeFromStore(target.id)
        }
        // 画布与矩阵都从同一份 query 读边，需失效以同步
        void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
      } catch (err) {
        setError(err instanceof Error ? err.message : '关联更新失败')
      } finally {
        setPending(false)
      }
    },
    [
      currentProjectId, value, relatedEdges, side, entityId, entityType,
      targetType, edgeType, addEdgeToStore, removeEdgeFromStore, queryClient,
    ],
  )

  return (
    <div className="space-y-1">
      <EntityPicker
        options={options}
        value={value}
        onChange={(next) => void handleChange(next)}
        placeholder={placeholder}
        searchPlaceholder={searchPlaceholder}
        emptyHint={emptyHint}
        disabled={pending || !currentProjectId}
      />
      {pending && (
        <p className="flex items-center gap-1 text-nano text-muted-foreground">
          <Loader2 className="size-2.5 animate-spin" />
          正在更新关联…
        </p>
      )}
      {error && <p className="text-nano text-destructive">{error}</p>}
    </div>
  )
}
