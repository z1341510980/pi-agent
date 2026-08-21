/**
 * SimilarityMergeDialog：LLM 相似度扫描结果多选合并对话框
 *
 * 从 novel-workspace 拆出（P2-3a）：workspace 只保留状态与回调，
 * 这里是纯展示组件 —— 勾选组 → 确认合并，未勾选的跳过。
 */
import type { ReactElement } from 'react'
import { Sparkle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { SimilarityEntityKind, SimilarityScanReport } from '@/api/novel-client'

// ── 相似度扫描实体类型中文标签（含 world_element）──
const SIMILARITY_KIND_LABEL: Record<SimilarityEntityKind, string> = {
  character: '角色',
  conflict: '冲突',
  foreshadow: '伏笔',
  faction: '势力',
  location: '地点',
  world_element: '世界要素',
  hook: '钩子',
  character_arc: '角色弧光',
}

/** 实体类型 → 中文标签（workspace 的合并成功 toast 也复用） */
export function similarityKindLabel(kind: SimilarityEntityKind): string {
  return SIMILARITY_KIND_LABEL[kind] ?? kind
}

export interface SimilarityMergeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  report: SimilarityScanReport | null
  /** 合并请求执行中（禁止关闭与重复提交） */
  isMerging: boolean
  selectedGroupIndices: Set<number>
  onToggleGroup: (idx: number) => void
  onToggleAll: (selectAll: boolean) => void
  onMerge: () => void
  /** 取消：关闭并重置本次扫描状态 */
  onCancel: () => void
}

export function SimilarityMergeDialog({
  open,
  onOpenChange,
  report,
  isMerging,
  selectedGroupIndices,
  onToggleGroup,
  onToggleAll,
  onMerge,
  onCancel,
}: SimilarityMergeDialogProps): ReactElement {
  const groups = report?.groups ?? []
  const allSelected = report != null && groups.length > 0 && selectedGroupIndices.size === groups.length

  return (
    <Dialog open={open} onOpenChange={(next) => {
      // 合并执行中不允许通过点击遮罩/ESC 关闭，避免中断
      if (!isMerging) onOpenChange(next)
    }}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] p-0 gap-0">
        <DialogHeader className="px-4 py-3 border-b border-border">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Sparkle className="size-4 text-primary" />
            AI 相似度整理
          </DialogTitle>
          <DialogDescription className="text-xs text-pretty">
            勾选需要合并的组，未勾选的将跳过。合并后删除项的关联数据会迁移到保留项
          </DialogDescription>
        </DialogHeader>
        <div className="overflow-y-auto p-4 max-h-[60vh]">
          {report == null ? (
            <div className="text-xs text-muted-foreground py-8 text-center">等待扫描结果...</div>
          ) : groups.length === 0 ? (
            <div className="text-xs text-muted-foreground py-8 text-center">
              未发现相似实体，所有条目均唯一
            </div>
          ) : (
            <div className="space-y-3">
              {/* 全选 / 取消全选 + 统计 */}
              <div className="flex items-center justify-between gap-2 pb-2 border-b border-border">
                <label className="flex items-center gap-2 cursor-pointer text-xs text-text select-none">
                  <input
                    type="checkbox"
                    className="size-3.5 rounded border-border accent-primary cursor-pointer"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) {
                        el.indeterminate = selectedGroupIndices.size > 0 && !allSelected
                      }
                    }}
                    onChange={(e) => onToggleAll(e.target.checked)}
                  />
                  <span className="font-medium">
                    {allSelected ? '取消全选' : '全选'}
                  </span>
                </label>
                <div className="text-xs text-muted-foreground">
                  已选 <span className="text-text font-medium tabular-nums">{selectedGroupIndices.size}</span>
                  {' / '}
                  <span className="tabular-nums">{groups.length}</span> 组
                </div>
              </div>

              {groups.map((g, idx) => {
                const checked = selectedGroupIndices.has(idx)
                return (
                  <label
                    key={`${g.kind}-${g.keptId}-${idx}`}
                    className={`block rounded-md border p-3 cursor-pointer transition-colors select-none ${checked ? 'border-primary/40 bg-primary/5' : 'border-border bg-surface-2/50 hover:bg-surface-2'}`}
                  >
                    <div className="flex items-start gap-2.5">
                      <input
                        type="checkbox"
                        className="mt-0.5 size-3.5 rounded border-border accent-primary cursor-pointer shrink-0"
                        checked={checked}
                        onChange={() => onToggleGroup(idx)}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                          <span className="text-nano px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">
                            {similarityKindLabel(g.kind)}
                          </span>
                          <span className="text-nano px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 font-medium tabular-nums">
                            相似度 {Math.round(g.similarity * 100)}%
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground mb-2 italic leading-relaxed">
                          {g.reason}
                        </div>
                        <div className="text-xs space-y-1">
                          <div className="text-emerald-700">
                            保留：<span className="font-mono text-micro">{g.keptId.slice(0, 8)}</span>
                          </div>
                          <div className="text-amber-600">
                            删除：{g.removed.map((r) => (
                              <span key={r.id} className="inline-block mr-1">
                                {r.name}
                                <span className="text-muted-foreground ml-0.5 text-nano">({r.id.slice(0, 8)})</span>
                              </span>
                            ))}
                            <span className="text-muted-foreground ml-1">（共 {g.removed.length} 个）</span>
                          </div>
                          {g.fieldMerges && g.fieldMerges.length > 0 && (
                            <div className="mt-2 pt-2 border-t border-border/60">
                              <div className="text-micro text-muted-foreground mb-1">字段级合并建议：</div>
                              <div className="space-y-1">
                                {g.fieldMerges.map((fm, fidx) => (
                                  <div key={fidx} className="text-micro text-muted-foreground leading-relaxed pl-2 border-l border-border">
                                    <span className="text-text font-medium">{fm.field}</span>
                                    <span className="mx-1">←</span>
                                    <span className="text-text">{fm.fromName}</span>
                                    <span className="text-muted-foreground ml-1 text-nano">({fm.fromId.slice(0, 8)})</span>
                                    <div className="text-nano italic">{fm.reason}</div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </label>
                )
              })}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-border bg-surface-1/50">
          <div className="text-xs text-muted-foreground">
            {selectedGroupIndices.size > 0 && (
              <>将合并 <span className="text-amber-500 font-medium tabular-nums">{selectedGroupIndices.size}</span> 组</>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onCancel} disabled={isMerging}>
              取消
            </Button>
            <Button
              size="sm"
              variant="default"
              onClick={onMerge}
              disabled={isMerging || selectedGroupIndices.size === 0}
            >
              {isMerging ? '合并中...' : `确认合并${selectedGroupIndices.size > 0 ? `（${selectedGroupIndices.size} 组）` : ''}`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
