import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest'
import Fastify from 'fastify'
import { piSdkPlugin } from '../plugins/pi-sdk.plugin.js'
import { eventBusPlugin } from '../plugins/event-bus.plugin.js'
import { databasePlugin } from '../plugins/database.plugin.js'

const originalPiApiKey = process.env.PI_API_KEY
const originalDeepSeekApiKey = process.env.PI_API_KEY_DEEPSEEK

describe('Pi SDK 插件', () => {
  let app: Fastify.FastifyInstance

  beforeAll(async () => {
    app = Fastify()
    await app.register(eventBusPlugin)
    await app.register(databasePlugin)
    await app.register(piSdkPlugin)
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    restoreEnv()
  })

  afterEach(() => {
    restoreEnv()
  })

  it('TC-01: 注册 eventBus 到 Fastify 实例', () => {
    expect(app.eventBus).toBeDefined()
  })

  it('TC-02: 注册 authStorage 到 Fastify 实例', () => {
    expect(app.authStorage).toBeDefined()
  })

  it('TC-03: 注册 modelRegistry 到 Fastify 实例', () => {
    expect(app.modelRegistry).toBeDefined()
  })

  it('TC-04: 注册 sessionManager 到 Fastify 实例', () => {
    expect(app.sessionManager).toBeDefined()
  })

  it('TC-05: 注册 getApiKey 回调到 Fastify 实例', () => {
    expect(typeof app.getApiKey).toBe('function')
  })

  it('TC-06: 不因通用 PI_API_KEY 自动注册 DeepSeek Provider', async () => {
    process.env.PI_API_KEY = 'sk-generic-key'
    delete process.env.PI_API_KEY_DEEPSEEK

    const genericKeyApp = Fastify()
    await genericKeyApp.register(eventBusPlugin)
    await genericKeyApp.register(databasePlugin)
    await genericKeyApp.register(piSdkPlugin)
    await genericKeyApp.ready()

    expect(genericKeyApp.modelRegistry.find('deepseek', 'deepseek-chat')).toBeUndefined()

    await genericKeyApp.close()
  })
})

function restoreEnv(): void {
  restoreEnvValue('PI_API_KEY', originalPiApiKey)
  restoreEnvValue('PI_API_KEY_DEEPSEEK', originalDeepSeekApiKey)
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
    return
  }

  process.env[key] = value
}
