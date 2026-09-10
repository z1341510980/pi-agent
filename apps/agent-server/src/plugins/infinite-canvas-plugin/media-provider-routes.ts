/**
 * 媒体生成 Provider 配置 API 路由（spec §3/§5/§6）
 *
 * 归属 infinite-canvas 插件：经 registerRoute 注册后实际路径为
 * /api/plugins/infinite-canvas 前缀 + 下方相对路径（plugin-loader :526-530）。
 *
 * 端点：
 * - GET    /media-providers?modality=   — 列出媒体 Provider（Key 脱敏）+ adapters 元数据
 * - POST   /media-providers             — 创建（每模态首条自动设为默认）
 * - PATCH  /media-providers/:id         — 部分更新（空 apiKey 保留旧值）
 * - DELETE /media-providers/:id         — 删除（默认行删除后模态默认空缺，可接受）
 * - POST   /media-providers/:id/default — 设为模态默认（同模态唯一）
 * - GET    /media-prefs                 — 读取媒体偏好（analyzeModel：反推提示词模型）
 * - PUT    /media-prefs                 — 写入偏好（null/空串清除；非空须 'provider:model'）
 *
 * adapters 元数据（id/label/capabilities/formSchema）驱动设置页动态表单；
 * text 模态复用 LLM Provider 体系（spec §4），本表不落 text 行。
 */

import type { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { success } from '../../lib/api-response.js'
import { validateBody } from '../../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import type { RouteDefinition } from '../../core/plugin/plugin-types.js'
import type { MediaModality, MediaProviderRow } from './media/adapter.js'
import type { MediaProviderRegistry } from './media/registry.js'
import { MEDIA_PREF_ANALYZE_MODEL, MediaPrefsStore } from './media/media-prefs-store.js'
import { STORED_MEDIA_MODALITIES } from './media/media-provider-store.js'
import type { MediaProviderStore, StoredMediaModality } from './media/media-provider-store.js'

const createSchema = z.object({
  name: z.string().trim().min(1),
  modality: z.enum(STORED_MEDIA_MODALITIES),
  adapter: z.string().trim().min(1),
  baseUrl: z.string().trim().optional(),
  apiKey: z.string().optional(),
  model: z.string().trim().optional(),
  params: z.record(z.string(), z.string()).optional()
})

const updateSchema = z.object({
  name: z.string().trim().min(1).optional(),
  modality: z.enum(STORED_MEDIA_MODALITIES).optional(),
  adapter: z.string().trim().min(1).optional(),
  baseUrl: z.string().trim().optional(),
  apiKey: z.string().optional(),
  model: z.string().trim().optional(),
  params: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional()
})

/** PUT /media-prefs：analyzeModel 缺省/null/空串清除，非空由 handler 校验 'provider:model'。 */
const mediaPrefsUpdateSchema = z.object({
  analyzeModel: z.string().nullable().optional()
})

/** 请求查询允许的模态集合（含 text：复用 LLM Provider 体系，恒返回空行）。 */
const QUERY_MODALITIES = ['text', ...STORED_MEDIA_MODALITIES] as const

/** Key 脱敏：首 4…尾 4；空 Key 返回空串（与旧画布 keyHint 口径一致）。 */
function keyHint(apiKey: string): string {
  return apiKey ? `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}` : ''
}

/** 行 → 响应视图：不回传 apiKey，附 keyHint 供列表展示。 */
function toSafeRow(row: MediaProviderRow): Omit<MediaProviderRow, 'apiKey'> & { keyHint: string } {
  return {
    id: row.id,
    name: row.name,
    modality: row.modality,
    adapter: row.adapter,
    baseUrl: row.baseUrl,
    model: row.model,
    params: row.params,
    enabled: row.enabled,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    keyHint: keyHint(row.apiKey)
  }
}

export function createMediaProviderRoutes(
  store: MediaProviderStore,
  registry: MediaProviderRegistry,
  log: FastifyBaseLogger,
  prefs: MediaPrefsStore
): RouteDefinition[] {
  return [
    {
      // GET /media-providers — 列出 Provider（可按模态过滤）+ adapters 元数据
      method: 'GET',
      path: '/media-providers',
      handler: async (request) => {
        const query = (request.query as { modality?: string }).modality?.trim()
        let modality: MediaModality | undefined
        if (query) {
          if (!(QUERY_MODALITIES as readonly string[]).includes(query)) {
            throw new AppError(
              ErrorCode.VALIDATION_ERROR,
              `无效的媒体模态 "${query}"，可选值：${QUERY_MODALITIES.join(' / ')}`,
              400
            )
          }
          modality = query as MediaModality
        }

        // text 不落 media_providers 表（spec §4）：恒为空行
        const rows =
          !modality || modality === 'text'
            ? modality === 'text'
              ? []
              : store.list()
            : store.list(modality)
        // adapters 清单按同一模态过滤（text 无 adapter）；未指定时返回全部模态
        const adapterModalities: MediaModality[] = modality
          ? [modality]
          : [...STORED_MEDIA_MODALITIES]
        const adapters = adapterModalities
          .filter((m): m is StoredMediaModality => m !== 'text')
          .flatMap((m) => registry.listAdapters(m))
          .map((adapter) => ({
            id: adapter.id,
            label: adapter.label,
            modality: adapter.modality,
            capabilities: adapter.capabilities,
            formSchema: adapter.formSchema
          }))

        return success({ rows: rows.map(toSafeRow), adapters }, request.traceId)
      }
    },
    {
      // POST /media-providers — 创建 Provider
      method: 'POST',
      path: '/media-providers',
      handler: async (request, reply) => {
        const input = validateBody(createSchema, request, reply)
        if (!input) return

        // 校验 adapter 属于该模态且已注册
        if (
          !registry.listAdapters(input.modality).some((adapter) => adapter.id === input.adapter)
        ) {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            `适配器 "${input.adapter}" 不属于模态 "${input.modality}" 或未注册`,
            400
          )
        }

        // 决策：每模态第一行自动 isDefault=1，后续默认切换走 POST :id/default
        const isFirst = store.list(input.modality).length === 0
        const created = store.create({
          name: input.name,
          modality: input.modality,
          adapter: input.adapter,
          baseUrl: input.baseUrl ?? '',
          apiKey: input.apiKey ?? '',
          model: input.model ?? '',
          params: input.params ?? {}
        })
        if (isFirst) store.setDefault(created.id)

        const saved = store.get(created.id) ?? created
        log.info(
          {
            providerId: saved.id,
            modality: saved.modality,
            adapter: saved.adapter,
            autoDefault: isFirst
          },
          `媒体 Provider "${saved.name}" 已创建（${input.modality} / ${input.adapter}）`
        )
        return success(toSafeRow(saved), request.traceId)
      }
    },
    {
      // PATCH /media-providers/:id — 部分更新（空 apiKey 保留旧值，store 层处理）
      method: 'PATCH',
      path: '/media-providers/:id',
      handler: async (request, reply) => {
        const { id } = request.params as { id: string }
        if (!id || id.trim().length === 0) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, '媒体 Provider ID 不能为空', 400)
        }
        const input = validateBody(updateSchema, request, reply)
        if (!input) return

        const existing = store.get(id)
        if (!existing) {
          throw new AppError(ErrorCode.NOT_FOUND, `媒体 Provider "${id}" 不存在`, 404)
        }
        // 按（变更后的）modality/adapter 组合校验归属：仅改 modality 而 adapter
        // 沿用旧值时同样可能造出跨模态的永久不可解析行（如 audio + openai-images）
        const targetModality = input.modality ?? existing.modality
        const targetAdapter = input.adapter ?? existing.adapter
        if (
          !registry.listAdapters(targetModality).some((adapter) => adapter.id === targetAdapter)
        ) {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            `适配器 "${targetAdapter}" 不属于模态 "${targetModality}" 或未注册`,
            400
          )
        }

        const updated = store.update(id, input)
        if (!updated) {
          throw new AppError(ErrorCode.NOT_FOUND, `媒体 Provider "${id}" 不存在`, 404)
        }
        log.info({ providerId: id }, `媒体 Provider "${updated.name}" 已更新`)
        return success(toSafeRow(updated), request.traceId)
      }
    },
    {
      // DELETE /media-providers/:id — 删除 Provider
      method: 'DELETE',
      path: '/media-providers/:id',
      handler: async (request) => {
        const { id } = request.params as { id: string }
        if (!id || id.trim().length === 0) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, '媒体 Provider ID 不能为空', 400)
        }
        const existed = store.remove(id)
        if (!existed) {
          throw new AppError(ErrorCode.NOT_FOUND, `媒体 Provider "${id}" 不存在`, 404)
        }
        // 若删除的是模态默认则默认空缺：resolve 报「未配置」引导文案，属可接受状态
        log.info({ providerId: id }, `媒体 Provider "${id}" 已删除`)
        return success({ deleted: true }, request.traceId)
      }
    },
    {
      // POST /media-providers/:id/default — 设为模态默认
      method: 'POST',
      path: '/media-providers/:id/default',
      handler: async (request) => {
        const { id } = request.params as { id: string }
        if (!id || id.trim().length === 0) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, '媒体 Provider ID 不能为空', 400)
        }
        const existing = store.get(id)
        if (!existing) {
          throw new AppError(ErrorCode.NOT_FOUND, `媒体 Provider "${id}" 不存在`, 404)
        }
        store.setDefault(id)
        log.info(
          { providerId: id, modality: existing.modality },
          `媒体 Provider "${existing.name}" 已设为 ${existing.modality} 模态默认`
        )
        return success({ id, modality: existing.modality }, request.traceId)
      }
    },
    {
      // GET /media-prefs — 读取媒体偏好（当前仅 analyzeModel；缺失/空值归一为 null）
      method: 'GET',
      path: '/media-prefs',
      handler: async (request) => {
        const value = prefs.getPref(MEDIA_PREF_ANALYZE_MODEL)
        return success({ analyzeModel: value && value.trim() ? value : null }, request.traceId)
      }
    },
    {
      // PUT /media-prefs — 写入偏好：null/空串清除（跟随默认文字模型），
      // 非空必须为 'provider:model'（冒号拆出两段非空），否则 400。
      method: 'PUT',
      path: '/media-prefs',
      handler: async (request, reply) => {
        const input = validateBody(mediaPrefsUpdateSchema, request, reply)
        if (!input) return
        const raw = input.analyzeModel?.trim() ?? ''
        if (!raw) {
          prefs.removePref(MEDIA_PREF_ANALYZE_MODEL)
          log.info({ key: MEDIA_PREF_ANALYZE_MODEL }, '媒体偏好 analyzeModel 已清除')
          return success({ analyzeModel: null }, request.traceId)
        }
        const separatorIndex = raw.indexOf(':')
        const providerId = separatorIndex > 0 ? raw.slice(0, separatorIndex).trim() : ''
        const modelId = separatorIndex > 0 ? raw.slice(separatorIndex + 1).trim() : ''
        if (!providerId || !modelId) {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            '反推提示词模型偏好格式无效：应为 "provider:model"',
            400
          )
        }
        const value = `${providerId}:${modelId}`
        prefs.setPref(MEDIA_PREF_ANALYZE_MODEL, value)
        log.info(
          { key: MEDIA_PREF_ANALYZE_MODEL, providerId, model: modelId },
          '媒体偏好 analyzeModel 已保存'
        )
        return success({ analyzeModel: value }, request.traceId)
      }
    }
  ]
}
