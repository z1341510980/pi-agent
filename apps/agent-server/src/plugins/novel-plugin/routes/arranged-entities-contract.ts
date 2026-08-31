/**
 * ArrangedEntity（本章矩阵编排实体）的**唯一**传输层契约。
 *
 * ## 为什么要单独一个文件
 *
 * 这份契约此前有三副本，且各自漂移：
 *   1. `ArrangedEntity` 类型（packages/shared，8 个字段）
 *   2. 路由的 zod schema（手抄，只有 6 个字段）
 *   3. 路由里的字段映射字面量（手抄两遍：create-flow / create-discussion）
 *   4. 前端 collectArrangedEntities（又一份，6 个字段）
 *
 * 结果：`itemIds` 与 `characterFunctions` 在类型里存在、下游 prompt-builder
 * 也已实现消费逻辑，但传输层静默丢弃，两条死分支长期没人发现 ——
 * 因为单测直接调 builder，绕过了路由。
 *
 * 本文件把 2/3 收敬为一处，并用编译期断言保证 schema 覆盖类型的每一个键：
 * 往 `ArrangedEntity` 加字段而忘了改 schema 会**编译失败**，不再是运行时静默丢失。
 */
import { z } from 'zod'
import type { ArrangedEntity, PlotFunction } from '../core/types.js'
import type { NovelStore } from '../core/novel-store.js'
import { modelSelectionSchema } from './model-selection-contract.js'

/** PlotFunction 七值枚举；与 shared 类型同源，缺一个会被下面的断言抓到 */
const PLOT_FUNCTIONS = [
  'provide_resource',
  'create_obstacle',
  'amplify_conflict',
  'open_phase',
  'change_judgment',
  'advance_relationship',
  'reveal_world_rule',
] as const satisfies readonly PlotFunction[]

const idList = z.array(z.string()).max(200).optional().default([])

/** 编排实体校验 schema（create-flow / create-discussion / 未来其他入口共用） */
export const arrangedEntitiesSchema = z.object({
  characterIds: idList,
  conflictIds: idList,
  foreshadowIds: idList,
  clueIds: idList,
  factionIds: idList,
  locationIds: idList,
  itemIds: idList,
  narrativeIds: idList,
  characterFunctions: z.array(z.object({
    characterId: z.string(),
    function: z.enum(PLOT_FUNCTIONS),
    note: z.string().max(400).optional(),
  })).max(50).optional().default([]),
})

export type ArrangedEntitiesInput = z.infer<typeof arrangedEntitiesSchema>

// ── 编译期完备性断言 ──
// ArrangedEntity 新增字段但 schema 没跟上时，这里报错。
type MissingInSchema = Exclude<keyof ArrangedEntity, keyof ArrangedEntitiesInput>
type ExtraInSchema = Exclude<keyof ArrangedEntitiesInput, keyof ArrangedEntity>
const _schemaCoversType: MissingInSchema extends never
  ? true
  : ['❌ arrangedEntitiesSchema 缺少字段', MissingInSchema] = true
const _schemaHasNoExtras: ExtraInSchema extends never
  ? true
  : ['❌ arrangedEntitiesSchema 多出字段', ExtraInSchema] = true
void _schemaCoversType
void _schemaHasNoExtras

/** 请求体 schema（两条创作链路共用） */
export const creationFlowBodySchema = z.object({
  arrangedEntities: arrangedEntitiesSchema.optional(),
  /** per-call 模型覆盖（输入框旁选择器传入，本次创作临时切换模型） */
  modelId: modelSelectionSchema.optional(),
  styleExpertIds: z.array(z.string().min(1).max(80)).max(8).optional(),
  /** P9: 参考模板配置（方案 §9 章节生成集成） */
  referenceTemplate: z.object({
    enabled: z.boolean(),
    templateId: z.string().uuid().optional(),
    templateVersionId: z.string().uuid().optional(),
    chapterClassification: z.string().max(100).optional(),
  }).optional(),
}).optional().default({})

/**
 * 把校验后的请求体转成 ArrangedEntity。
 *
 * 用展开而不是逐字段手抄：手抄是上一轮字段丢失的直接原因。
 * schema 的 `.default([])` 已保证每个键都存在，此处不会带出 undefined。
 */
export function parseArrangedEntities(
  input: { arrangedEntities?: ArrangedEntitiesInput } | undefined,
): ArrangedEntity | undefined {
  if (!input?.arrangedEntities) return undefined
  return { ...input.arrangedEntities }
}

/**
 * 校验编排实体全部属于当前项目。
 *
 * 返回不合法的 `类型:id` 列表；空数组表示通过。
 * 两条创作链路此前各自有一份完全相同的循环，且 itemIds 这类新字段只补了一处。
 */
export function findForeignArrangedEntities(
  store: NovelStore,
  projectId: string,
  arranged: ArrangedEntity,
): string[] {
  const invalid: string[] = []
  const check = (
    label: string,
    ids: string[] | undefined,
    lookup: (id: string) => { projectId: string } | undefined,
  ): void => {
    for (const id of ids ?? []) {
      if (lookup(id)?.projectId !== projectId) invalid.push(`${label}:${id}`)
    }
  }

  check('character', arranged.characterIds, (id) => store.getCharacter(id))
  check('conflict', arranged.conflictIds, (id) => store.getConflict(id))
  check('foreshadow', arranged.foreshadowIds, (id) => store.getForeshadow(id))
  check('clue', arranged.clueIds, (id) => store.getClue(id))
  check('faction', arranged.factionIds, (id) => store.getFaction(id))
  check('location', arranged.locationIds, (id) => store.getLocation(id))
  check('item', arranged.itemIds, (id) => store.getItem(id))
  check('narrative', arranged.narrativeIds, (id) => store.getNarrative(id))
  check(
    'characterFunction',
    arranged.characterFunctions?.map((entry) => entry.characterId),
    (id) => store.getCharacter(id),
  )

  return invalid
}