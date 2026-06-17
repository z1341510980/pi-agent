import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import { piSdkPlugin } from '../plugins/pi-sdk.plugin.js'
import { eventBusPlugin } from '../plugins/event-bus.plugin.js'

describe('Pi SDK 插件', () => {
  let app: Fastify.FastifyInstance

  beforeAll(async () => {
    app = Fastify()
    await app.register(eventBusPlugin)
    await app.register(piSdkPlugin)
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('注册 eventBus 到 Fastify 实例', () => {
    expect(app.eventBus).toBeDefined()
  })

  it('注册 authStorage 到 Fastify 实例', () => {
    expect(app.authStorage).toBeDefined()
  })

  it('注册 modelRegistry 到 Fastify 实例', () => {
    expect(app.modelRegistry).toBeDefined()
  })

  it('注册 sessionManager 到 Fastify 实例', () => {
    expect(app.sessionManager).toBeDefined()
  })

  it('注册 getApiKey 回调到 Fastify 实例', () => {
    expect(typeof app.getApiKey).toBe('function')
  })
})
