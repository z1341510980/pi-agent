/**
 * session-store 的 v0 → v1 持久化迁移
 *
 * v0 的 partialize 里有 `sessionMessages`，而当时的 `ChatMessage` 是旧模型
 * （旁挂 toolCalls，没有 segments）。partialize 只管写不管读，所以新代码即使
 * 不再写入，rehydrate 依然会把旧快照 merge 回 state —— 于是 ChatWorkspace 的
 * `associatedFiles` useMemo 首次计算就在 `collectToolCalls` 里撞上
 * `message.segments is not iterable`，整页白屏。
 *
 * 迁移写错的代价是用户的会话列表/草稿被静默清空（zustand 在版本不一致且
 * migrate 缺失/返回残缺时会丢字段），故单独覆盖。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { migrateSessionPersisted, SESSION_STORE_PERSIST_VERSION } from '../session-store'

const KEY = 'wenlang-agent-session'

/** 写入旧版本（v0）的持久化快照，消息为无 segments 的旧模型 */
function seedV0Snapshot(): void {
  localStorage.setItem(
    KEY,
    JSON.stringify({
      version: 0,
      state: {
        sessions: [{ id: 't1', title: '旧会话', preview: 'p', createdAt: 1, updatedAt: 1 }],
        activeThreadId: 't1',
        sessionMessages: {
          t1: {
            messages: [
              { id: 'old-1', role: 'assistant', content: 'hi', toolCalls: [], status: 'complete' },
            ],
            activeRunId: null,
            streamError: null,
          },
        },
        drafts: { t1: '草稿保留' },
        selectedModel: { provider: 'openai', modelId: 'gpt-4' },
        compactionCount: 3,
        activeAgentId: 'agent-x',
      },
    }),
  )
}

beforeEach(() => {
  localStorage.clear()
})

describe('migrateSessionPersisted', () => {
  it('剔除 sessionMessages，原样保留其余字段', () => {
    const next = migrateSessionPersisted(
      {
        sessions: [{ id: 'a' }],
        activeThreadId: 'a',
        sessionMessages: { a: { messages: [{ id: 'm', toolCalls: [] }] } },
        drafts: { a: 'hi' },
        selectedModel: { provider: 'p', modelId: 'm' },
        compactionCount: 2,
      },
      0,
    ) as Record<string, unknown>

    expect('sessionMessages' in next).toBe(false)
    expect(next.sessions).toEqual([{ id: 'a' }])
    expect(next.drafts).toEqual({ a: 'hi' })
    expect(next.selectedModel).toEqual({ provider: 'p', modelId: 'm' })
    expect(next.compactionCount).toBe(2)
  })

  it('已是当前版本的 payload 原样返回（同一引用，不做多余拷贝）', () => {
    const payload = { drafts: {} }
    expect(migrateSessionPersisted(payload, SESSION_STORE_PERSIST_VERSION)).toBe(payload)
  })

  it('payload 损坏（null / 非对象）时不抛错', () => {
    expect(migrateSessionPersisted(null, 0)).toBe(null)
    expect(migrateSessionPersisted('{ not json', 0)).toBe('{ not json')
  })

  // ── 边界：迁移是"只跑一次"的路径，写错就静默清数据，值得把入参空间压满 ──

  it.each([
    ['undefined', undefined],
    ['数字', 42],
    ['布尔', false],
    ['函数', () => {}],
  ])('payload 为 %s 时原样返回', (_label, payload) => {
    expect(migrateSessionPersisted(payload, 0)).toBe(payload)
  })

  it('payload 为数组时原样返回（typeof 是 object，但没有 sessionMessages 可删）', () => {
    const arr = [1, 2]
    const next = migrateSessionPersisted(arr, 0)
    // 走的是浅拷贝分支，内容不该被改动
    expect(next).toEqual({ 0: 1, 1: 2 })
  })

  it.each([
    ['负数', -1],
    ['NaN', Number.NaN],
    ['非数字', 'v0' as unknown as number],
  ])('version 为 %s 时按"低于当前版本"处理，仍执行迁移', (_label, version) => {
    const next = migrateSessionPersisted(
      { sessionMessages: { a: {} }, drafts: { a: 'd' } },
      version as number,
    ) as Record<string, unknown>

    expect('sessionMessages' in next).toBe(false)
    expect(next.drafts).toEqual({ a: 'd' })
  })

  it('version 高于当前版本时不动 payload（未来版本降级运行不该被清）', () => {
    const payload = { sessionMessages: { a: {} } }
    expect(migrateSessionPersisted(payload, 99)).toBe(payload)
  })

  it('本就没有 sessionMessages 时不引入该 key、其余字段不变', () => {
    const next = migrateSessionPersisted({ drafts: { a: 'x' }, compactionCount: 0 }, 0) as Record<
      string,
      unknown
    >

    expect('sessionMessages' in next).toBe(false)
    expect(next).toEqual({ drafts: { a: 'x' }, compactionCount: 0 })
  })

  it('字段值为 undefined / null 时原样保留，不被"顺手补默认值"', () => {
    const next = migrateSessionPersisted(
      { sessions: undefined, drafts: null, selectedModel: undefined, sessionMessages: {} },
      0,
    ) as Record<string, unknown>

    expect('sessions' in next).toBe(true)
    expect(next.sessions).toBeUndefined()
    expect(next.drafts).toBeNull()
    expect('selectedModel' in next).toBe(true)
  })

  it('不修改入参对象（migrate 被重复调用时不能越删越多）', () => {
    const payload = { sessionMessages: { a: {} }, drafts: { a: 'd' } }
    migrateSessionPersisted(payload, 0)

    expect(payload.sessionMessages).toEqual({ a: {} })
  })

  /**
   * 只删 sessionMessages 这一条不变量必须钉住。
   *
   * 反面案例不是假想：zustand 在版本不一致且 migrate 缺失时会丢弃**整份**
   * persisted state，用户的会话列表与草稿一起消失。如果哪天有人"顺手简化"成
   * `return { sessions: persisted.sessions }` 之类，这个用例会先红。
   */
  it('除 sessionMessages 外的所有 key 逐一保留', () => {
    const payload = {
      sessions: [{ id: 'a' }],
      activeThreadId: 'a',
      sessionMessages: { a: {} },
      drafts: { a: 'd' },
      commandQueues: { a: [{ id: 'q1', text: 't', createdAt: 1 }] },
      selectedModel: { provider: 'p', modelId: 'm' },
      compactionCount: 7,
      activeAgentId: 'agent-x',
      // 未来新增的未知字段也不该被吃掉
      futureField: { nested: true },
    }
    const next = migrateSessionPersisted(payload, 0) as Record<string, unknown>

    const expectedKeys = Object.keys(payload).filter((k) => k !== 'sessionMessages')
    expect(Object.keys(next).sort()).toEqual(expectedKeys.sort())
    for (const key of expectedKeys) {
      expect(next[key]).toBe(payload[key as keyof typeof payload])
    }
  })
})

describe('rehydrate 端到端', () => {
  it('v0 快照的旧消息不再回到 store，草稿与偏好完好', async () => {
    seedV0Snapshot()
    const { useSessionStore } = await import('../session-store')
    await useSessionStore.persist.rehydrate()

    const state = useSessionStore.getState()
    expect(state.sessionMessages).toEqual({})
    expect(state.drafts).toEqual({ t1: '草稿保留' })
    expect(state.sessions).toHaveLength(1)
    expect(state.activeThreadId).toBe('t1')
    expect(state.selectedModel).toEqual({ provider: 'openai', modelId: 'gpt-4' })
    expect(state.compactionCount).toBe(3)
    expect(state.activeAgentId).toBe('agent-x')

    // 迁移后立即回写新版本号，下次启动不再重复迁移
    const written = JSON.parse(localStorage.getItem(KEY) as string)
    expect(written.version).toBe(SESSION_STORE_PERSIST_VERSION)
    expect('sessionMessages' in written.state).toBe(false)
  })
})
