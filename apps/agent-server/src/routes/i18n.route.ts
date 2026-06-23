/**
 * i18n API 路由
 *
 * 端点：
 * - GET /api/i18n/locales — 列出可用语言
 * - GET /api/i18n/translations/:locale — 获取指定语言的翻译字典
 * - GET /api/i18n/locale — 获取当前语言
 * - PUT /api/i18n/locale — 设置当前语言
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { success } from '../lib/api-response.js'
import { validateBody } from '../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import {
  listLocales,
  getTranslations,
  setLocale,
  getLocale,
  isSupportedLocale,
  SUPPORTED_LOCALES,
} from '../core/i18n/i18n.js'

const setLocaleSchema = z.object({
  locale: z.enum(SUPPORTED_LOCALES),
})

export const i18nRoute: FastifyPluginAsync = async (app) => {
  // GET /api/i18n/locales — 列出可用语言
  app.get('/api/i18n/locales', async (request) => {
    return success(
      {
        locales: listLocales(),
        current: getLocale(),
      },
      request.traceId,
    )
  })

  // GET /api/i18n/locale — 获取当前语言
  app.get('/api/i18n/locale', async (request) => {
    return success({ locale: getLocale() }, request.traceId)
  })

  // GET /api/i18n/translations/:locale — 获取指定语言的翻译字典
  app.get('/api/i18n/translations/:locale', async (request) => {
    const { locale } = request.params as { locale: string }

    if (!isSupportedLocale(locale)) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `不支持的语言: ${locale}`,
        400,
        `不支持的语言: ${locale}`,
      )
    }

    return success(
      { locale, translations: getTranslations(locale) },
      request.traceId,
    )
  })

  // PUT /api/i18n/locale — 设置当前语言
  app.put('/api/i18n/locale', async (request, reply) => {
    const input = validateBody(setLocaleSchema, request, reply)
    if (!input) return

    setLocale(input.locale)
    app.log.info({ traceId: request.traceId, locale: input.locale }, '已切换语言')

    return success({ locale: getLocale() }, request.traceId)
  })
}
