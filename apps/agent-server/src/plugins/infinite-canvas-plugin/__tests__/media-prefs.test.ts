/**
 * 媒体偏好（infinite_canvas_media_prefs，迁移 019）测试：
 * - MediaPrefsStore：get 缺失 null / setPref upsert / removePref 清除；
 * - /media-prefs 路由：GET 空态、PUT 设置（归一化）、PUT 清除（null/空串）、
 *   非法格式（缺冒号/空段）400。
 */
import Database from 'better-sqlite3'
import { afterAll, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../../core/db/migrations.js'
import { infiniteCanvasMigrations } from '../migrations.js'
import { MEDIA_PREF_ANALYZE_MODEL, MediaPrefsStore } from '../media/media-prefs-store.js'
import { createMediaProviderRoutes } from '../media-provider-routes.js'
import { createMediaProviderRegistry } from '../media/registry.js'
import { MediaProviderStore } from '../media/media-provider-store.js'

const ROUTE_MIGRATION_IDS = [
  // 媒体 Provider 表（路由构造即预编译查询，必须先建）+ 媒体偏好表
  '018_create_infinite_canvas_media_providers',
  '019_create_infinite_canvas_media_prefs'
]

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY);')
  const migrations = ROUTE_MIGRATION_IDS.map((id) => {
    const migration = infiniteCanvasMigrations.find((item) => item.id === id)
    if (!migration) throw new Error(`插件迁移 ${id} 未定义`)
    return migration
  })
  applyMigrations(db, migrations)
  return db
}

const logStub = { info: () => undefined, warn: () => undefined } as never

interface ReplyLike {
  statusCode: number
  status(code: number): ReplyLike
  send(payload: unknown): unknown
}

function replyMock(): ReplyLike {
  const reply: ReplyLike = {
    statusCode: 200,
    status(code) {
      reply.statusCode = code
      return reply
    },
    send(payload) {
      return payload
    }
  }
  return reply
}

describe('MediaPrefsStore', () => {
  const db = createDb()
  const prefs = new MediaPrefsStore(db)
  afterAll(() => db.close())

  it('getPref 缺失返回 null，setPref 写入后可读', () => {
    expect(prefs.getPref(MEDIA_PREF_ANALYZE_MODEL)).toBeNull()
    prefs.setPref(MEDIA_PREF_ANALYZE_MODEL, 'llm-2:vision-model')
    expect(prefs.getPref(MEDIA_PREF_ANALYZE_MODEL)).toBe('llm-2:vision-model')
  })

  it('setPref 重复写入按 upsert 覆盖，removePref 清除后回到缺失', () => {
    prefs.setPref(MEDIA_PREF_ANALYZE_MODEL, 'llm-2:vision-model')
    prefs.setPref(MEDIA_PREF_ANALYZE_MODEL, 'llm-9:other-model')
    expect(prefs.getPref(MEDIA_PREF_ANALYZE_MODEL)).toBe('llm-9:other-model')
    prefs.removePref(MEDIA_PREF_ANALYZE_MODEL)
    expect(prefs.getPref(MEDIA_PREF_ANALYZE_MODEL)).toBeNull()
    // 幂等：重复清除不抛错
    expect(() => prefs.removePref(MEDIA_PREF_ANALYZE_MODEL)).not.toThrow()
  })
})

describe('/media-prefs 路由', () => {
  function buildRoutes(): {
    db: Database.Database
    prefs: MediaPrefsStore
    routes: ReturnType<typeof createMediaProviderRoutes>
    getRoute: ReturnType<typeof createMediaProviderRoutes>[number]
    putRoute: ReturnType<typeof createMediaProviderRoutes>[number]
  } {
    const db = createDb()
    const prefs = new MediaPrefsStore(db)
    const routes = createMediaProviderRoutes(
      new MediaProviderStore(db),
      createMediaProviderRegistry(new MediaProviderStore(db)),
      logStub,
      prefs
    )
    return {
      db,
      prefs,
      routes,
      getRoute: routes.find((item) => item.method === 'GET' && item.path === '/media-prefs')!,
      putRoute: routes.find((item) => item.method === 'PUT' && item.path === '/media-prefs')!
    }
  }

  it('路由表注册 GET 与 PUT', () => {
    const { db, routes } = buildRoutes()
    try {
      const table = routes.map((route) => `${route.method} ${route.path}`)
      expect(table).toContain('GET /media-prefs')
      expect(table).toContain('PUT /media-prefs')
    } finally {
      db.close()
    }
  })
  it('GET 空态返回 analyzeModel null，PUT 设置后 GET 回显', async () => {
    const { db, prefs, getRoute, putRoute } = buildRoutes()
    try {
      const empty = (await getRoute.handler({ traceId: 't1' }, replyMock())) as {
        data: { analyzeModel: string | null }
      }
      expect(empty.data).toEqual({ analyzeModel: null })

      const saved = (await putRoute.handler(
        { body: { analyzeModel: 'llm-2:vision-model' }, traceId: 't2' },
        replyMock()
      )) as { data: { analyzeModel: string | null } }
      expect(saved.data).toEqual({ analyzeModel: 'llm-2:vision-model' })

      const echoed = (await getRoute.handler({ traceId: 't3' }, replyMock())) as {
        data: { analyzeModel: string | null }
      }
      expect(echoed.data).toEqual({ analyzeModel: 'llm-2:vision-model' })
      expect(prefs.getPref(MEDIA_PREF_ANALYZE_MODEL)).toBe('llm-2:vision-model')
    } finally {
      db.close()
    }
  })

  it('PUT null 与空串清除偏好，GET 回到 null', async () => {
    const { db, prefs, getRoute, putRoute } = buildRoutes()
    try {
      prefs.setPref(MEDIA_PREF_ANALYZE_MODEL, 'llm-2:vision-model')

      const clearedByNull = (await putRoute.handler(
        { body: { analyzeModel: null }, traceId: 't1' },
        replyMock()
      )) as { data: { analyzeModel: string | null } }
      expect(clearedByNull.data).toEqual({ analyzeModel: null })
      expect(prefs.getPref(MEDIA_PREF_ANALYZE_MODEL)).toBeNull()

      prefs.setPref(MEDIA_PREF_ANALYZE_MODEL, 'llm-2:vision-model')
      await putRoute.handler({ body: { analyzeModel: '  ' }, traceId: 't2' }, replyMock())
      expect(prefs.getPref(MEDIA_PREF_ANALYZE_MODEL)).toBeNull()

      const echoed = (await getRoute.handler({ traceId: 't3' }, replyMock())) as {
        data: { analyzeModel: string | null }
      }
      expect(echoed.data).toEqual({ analyzeModel: null })
    } finally {
      db.close()
    }
  })

  it('PUT 非法格式（缺冒号/空段）抛 400 且不落库', async () => {
    const { db, prefs, putRoute } = buildRoutes()
    try {
      for (const invalid of ['bare-model', 'llm-2:', ':vision-model', ':']) {
        await expect(
          putRoute.handler({ body: { analyzeModel: invalid }, traceId: 't1' }, replyMock())
        ).rejects.toMatchObject({ statusCode: 400 })
      }
      expect(prefs.getPref(MEDIA_PREF_ANALYZE_MODEL)).toBeNull()
    } finally {
      db.close()
    }
  })
})
