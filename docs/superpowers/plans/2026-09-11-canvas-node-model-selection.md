# 无限画布 节点级模型选择 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在画布生成节点面板上按节点类型（image/video/audio）选择本次生成使用的模型（写入节点 metadata），服务端对显式选择的失效情况报错阻止生成。

**Architecture:** 端到端的 `providerId`/`model` 透传链路已存在（metadata → 载荷 → 路由 → generator → adapter），本计划只补两端：面板 ModelPicker 写入 `metadata.providerId`/`metadata.model`；generator 入口对显式 providerId 做无回退校验（registry 新增只读 `findEnabledRow`），失效即抛可读错误（502 码失败通道 → 节点 errorDetails）。

**Tech Stack:** React 19、TypeScript、Vitest + Testing Library、Fastify 插件既有测试栈（in-memory sqlite + fetch stub）。

---

## 文件边界

- Modify: `apps/agent-server/src/plugins/infinite-canvas-plugin/media/registry.ts` — 新增 `findEnabledRow`
- Modify: `apps/agent-server/src/plugins/infinite-canvas-plugin/media/generator.ts` — 新增 `providerCandidateModels` + `assertProviderSelection`，四个生成入口接入
- Modify: `apps/agent-server/src/plugins/infinite-canvas-plugin/media/__tests__/generator.test.ts` — 增补校验用例
- Modify: `apps/desktop/src/renderer/src/components/infinite-canvas/canvas-node-panel.tsx` — ModelPicker
- Modify: `apps/desktop/src/renderer/src/components/infinite-canvas/canvas-node.tsx` — config 卡片模型小字
- Modify: `apps/desktop/src/renderer/src/components/infinite-canvas/__tests__/canvas-node-panel.test.tsx` — 增补用例

### Task 1: 服务端显式选择校验

- [ ] **Step 1: 写失败测试**（在 `generator.test.ts` 既有套件内，复用现有 registry/store fixture 与 `vi.stubGlobal('fetch')` 手法）：

新增 describe「节点显式模型选择校验」：
1. `generateImage` 带**未知** `providerId` → rejects，消息含「已被删除或停用」，且 fetch 未被调用。
2. `providerId` 指向**已停用**（enabled=0）行 → 同上 rejects。
3. `providerId` 命中但 `model` 不在该行 `model`+`params.models` 候选中 → rejects，消息含「已从 Provider」。
4. `providerId` 命中且 `model` 来自 `params.models` → 放行，fetch 载荷 `model` 等于该值。
5. `generateAudio`/`generateVideo` 各一条同样的未知 providerId 拒绝用例。
6. 对照组：不带 `providerId` 的既有默认回退行为用例保持通过（不改既有断言）。

- [ ] **Step 2: 跑测试确认失败**：`pnpm --filter agent-server exec vitest run src/plugins/infinite-canvas-plugin/media/__tests__/generator.test.ts --environment node` → FAIL（findEnabledRow 不存在）。

- [ ] **Step 3: 实现**

`registry.ts`（`findRow` 之后加公有方法）：

```ts
  /** 显式选择的只读查询：仅当 providerId 存在、模态匹配且启用时返回行（不回退默认）。 */
  findEnabledRow(
    modality: Exclude<MediaModality, 'text'>,
    providerId: string
  ): MediaProviderRow | null {
    const row = this.store.get(providerId)
    if (row && row.modality === modality && row.enabled) return row
    return null
  }
```

`generator.ts`（`splitTextModel` 前后合适位置；import 处补 `MediaProviderRow` 类型）：

```ts
const GENERATION_MODALITY_LABELS: Record<'image' | 'audio' | 'video', string> = {
  image: '图片',
  audio: '音频',
  video: '视频'
}

/** Provider 候选模型：行默认 model + params.models（换行分隔），去重去空。 */
export function providerCandidateModels(row: MediaProviderRow): string[] {
  const extra = typeof row.params?.models === 'string' ? row.params.models.split(/\r?\n/) : []
  return [...new Set([row.model, ...extra].map((model) => model.trim()).filter(Boolean))]
}

/**
 * 节点显式选择校验：providerId 存在时必须命中可用 Provider（不回退默认），
 * 所选 model 必须仍在该 Provider 候选列表内 —— 失效即报错，阻止发起上游请求。
 */
async function assertProviderSelection(
  registry: MediaProviderRegistry,
  modality: 'image' | 'audio' | 'video',
  providerId: string | undefined,
  model: string | undefined
): Promise<void> {
  if (!providerId) return
  const row = registry.findEnabledRow(modality, providerId)
  if (!row) {
    throw new Error(
      `所选「${GENERATION_MODALITY_LABELS[modality]}」模型的 Provider 已被删除或停用，请在节点面板重新选择`
    )
  }
  if (model && !providerCandidateModels(row).includes(model)) {
    throw new Error(`所选模型 ${model} 已从 Provider「${row.name}」移除，请在节点面板重新选择`)
  }
}
```

四个入口各加一行（resolve 之前）：`generateImage`/`editImage` → `await assertProviderSelection(registry, 'image', providerId, model)`；`generateAudio` → `('audio', input.providerId, input.model)`；`generateVideo` → `('video', input.providerId, input.model)`。

- [ ] **Step 4: 跑测试 + typecheck + eslint，提交** `git commit -m "feat: validate explicit node model selection server-side"`

### Task 2: 面板 ModelPicker 与卡片小字

- [ ] **Step 1: 写失败测试**（`canvas-node-panel.test.tsx`，`vi.mock('@/api/media-provider-client')` 返回 fixture rows：enabled image 行（model `img-a` + params.models `img-b\ncustom-x`）、disabled video 行、enabled audio 行（model `tts-1`）；复用既有 useState metadata 测试架）：
1. image 模式下拉含 `ProviderA / img-a`、`ProviderA / img-b`、`ProviderA / custom-x`，不含 disabled 行模型；首项「跟随全局默认」且为当前值。
2. 选择 `ProviderA / img-b` → `onConfigChange` 收到 `{providerId: 'p-image', model: 'img-b'}`。
3. metadata 已选时 value 回显 `${providerId}:${model}`；改选「跟随全局默认」→ 收到 `{providerId: undefined, model: undefined}`。
4. audio 模式切到 video 模式（无 enabled 行）→ select disabled。

- [ ] **Step 2: 跑测试确认失败**：`pnpm --filter desktop exec vitest run src/renderer/src/components/infinite-canvas/__tests__/canvas-node-panel.test.tsx --environment jsdom` → FAIL。

- [ ] **Step 3: 实现**

`canvas-node-panel.tsx`：import `listMediaProviders` 与 `type MediaProviderRow`（`@/api/media-provider-client`）。文件底部新增（ConfigSettingsRow 同层）：

```tsx
/** 节点级模型选项：一个已启用 Provider 下的一段候选模型。 */
interface ModelOption {
  value: string
  label: string
}

/** 按模态聚合已启用 Provider 的候选模型（行默认 model + params.models）。 */
export function providerModelOptions(rows: MediaProviderRow[], modality: string): ModelOption[] {
  const options: ModelOption[] = []
  for (const row of rows) {
    if (row.modality !== modality || !row.enabled) continue
    const extra = typeof row.params?.models === 'string' ? row.params.models.split(/\r?\n/) : []
    const models = [...new Set([row.model, ...extra].map((model) => model.trim()).filter(Boolean))]
    for (const model of models) {
      options.push({ value: `${row.id}:${model}`, label: `${row.name} / ${model}` })
    }
  }
  return options
}

/** 节点面板模型选择：写 metadata.providerId/model；空 value = 跟随全局默认（清除）。 */
function ModelPicker({
  theme,
  mode,
  providerId,
  model,
  onChange
}: {
  theme: CanvasTheme
  mode: string
  providerId?: string
  model?: string
  onChange: (patch: { providerId?: string; model?: string }) => void
}): ReactElement {
  const [options, setOptions] = useState<ModelOption[] | null>(null)
  useEffect(() => {
    let cancelled = false
    void listMediaProviders()
      .then((result) => {
        if (!cancelled) setOptions(providerModelOptions(result.rows, mode))
      })
      .catch(() => {
        if (!cancelled) setOptions([])
      })
    return () => {
      cancelled = true
    }
  }, [mode])
  const value = providerId && model ? `${providerId}:${model}` : ''
  const unavailable = options !== null && options.length === 0
  return (
    <label className="mt-2 block text-xs">
      模型
      <select
        value={value}
        disabled={options === null || unavailable}
        onChange={(event) => {
          const next = event.target.value
          if (!next) {
            onChange({ providerId: undefined, model: undefined })
            return
          }
          const separator = next.indexOf(':')
          onChange({ providerId: next.slice(0, separator), model: next.slice(separator + 1) })
        }}
        className="mt-1 h-8 w-full rounded-lg border bg-transparent px-2 outline-none"
        style={{ borderColor: theme.toolbar.border, color: theme.node.text }}
      >
        <option value="">跟随全局默认</option>
        {(options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
        {unavailable && (
          <option value="" disabled>
            未配置可用的 Provider
          </option>
        )}
      </select>
    </label>
  )
}
```

插入点：`canvas-node-panel.tsx:667`（非 config ConfigSettingsRow 块的 `)}`）与 `:668`（`mt-2 flex` 行）之间：

```tsx
      {isConfig && mode !== 'text' && onConfigChange && (
        <ModelPicker
          theme={theme}
          mode={mode}
          providerId={node.metadata?.providerId}
          model={node.metadata?.model}
          onChange={(patch) => onConfigChange(node.id, patch)}
        />
      )}
```

`canvas-node.tsx` config 节点卡片（EmptyContent 区域，约 500-507）：当 `node.metadata?.model` 存在时渲染小字 `<div className="truncate text-[10px] opacity-50">{node.metadata.model}</div>`（沿用现有 EmptyContent 容器类名，置于其内末尾）。

- [ ] **Step 4: 跑测试 + typecheck:web + eslint，提交** `git commit -m "feat: add per-node model picker to canvas generation panel"`

### Task 3: 全量回归（controller 执行）

- [ ] 画布套件 + agent-server 插件套件 + 双端 tsc + 触碰文件 eslint + git 状态核对。

## Plan Self-Review

- Spec coverage：面板下拉（Task 2）、按类型聚合/排除停用（Task 2 测试 1/4）、写入与清除（测试 2/3）、卡片小字（Task 2）、失效报错不回退（Task 1 测试 1/2/3/5）、无显式选择行为不变（Task 1 对照组）。
- Placeholder scan：无 TBD；测试用例给出精确断言语义，实现细节复用各测试文件既有 fixture（计划明确允许该适配）。
- Type consistency：`findEnabledRow` / `providerCandidateModels` / `providerModelOptions` / ModelPicker onChange patch 与 metadata `providerId?`/`model?` 一致。
- Scope：无新路由、无迁移、不改文字模式与反推链路。
