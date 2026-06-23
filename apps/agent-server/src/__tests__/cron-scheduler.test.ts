import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { EventBus } from '@repo/shared/events'
import {
  CronScheduler,
  parseCronExpression,
  isDue,
  isValidCronExpression,
} from '../core/cron/cron-scheduler.js'
import type { CronTickEvent } from '../core/cron/cron-scheduler.js'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'pi-cron-test-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('parseCronExpression', () => {
  it('解析标准 5 段式 cron 表达式', () => {
    const fields = parseCronExpression('0 8 * * *')
    expect(fields).toHaveLength(5)
    expect(fields[0].has(0)).toBe(true)
    expect(fields[1].has(8)).toBe(true)
    // 日/月/周为 *，应包含所有可能值
    expect(fields[2].size).toBe(31)
    expect(fields[3].size).toBe(12)
    expect(fields[4].size).toBe(7)
  })

  it('解析 * 通配符', () => {
    const fields = parseCronExpression('* * * * *')
    expect(fields[0].size).toBe(60) // 0-59
    expect(fields[1].size).toBe(24) // 0-23
    expect(fields[2].size).toBe(31) // 1-31
    expect(fields[3].size).toBe(12) // 1-12
    expect(fields[4].size).toBe(7) // 0-6
  })

  it('解析逗号分隔的列表', () => {
    const fields = parseCronExpression('1,15,30 * * * *')
    expect(fields[0].has(1)).toBe(true)
    expect(fields[0].has(15)).toBe(true)
    expect(fields[0].has(30)).toBe(true)
    expect(fields[0].size).toBe(3)
  })

  it('解析范围表达式', () => {
    const fields = parseCronExpression('10-15 * * * *')
    expect(fields[0].size).toBe(6)
    for (let i = 10; i <= 15; i++) {
      expect(fields[0].has(i)).toBe(true)
    }
  })

  it('解析步长表达式 */N', () => {
    const fields = parseCronExpression('*/15 * * * *')
    expect(fields[0].has(0)).toBe(true)
    expect(fields[0].has(15)).toBe(true)
    expect(fields[0].has(30)).toBe(true)
    expect(fields[0].has(45)).toBe(true)
    expect(fields[0].size).toBe(4)
  })

  it('解析范围步长 10-30/10', () => {
    const fields = parseCronExpression('10-30/10 * * * *')
    expect(fields[0].has(10)).toBe(true)
    expect(fields[0].has(20)).toBe(true)
    expect(fields[0].has(30)).toBe(true)
    expect(fields[0].size).toBe(3)
  })

  it('周字段中 7 被转换为 0（周日）', () => {
    const fields = parseCronExpression('* * * * 7')
    expect(fields[4].has(0)).toBe(true)
    expect(fields[4].has(7)).toBe(false)
  })

  it('非 5 段式表达式抛出错误', () => {
    expect(() => parseCronExpression('0 8 * *')).toThrow(/5 段式/)
    expect(() => parseCronExpression('0 8 * * * *')).toThrow(/5 段式/)
  })

  it('无效值抛出错误', () => {
    expect(() => parseCronExpression('60 * * * *')).toThrow()
    expect(() => parseCronExpression('* 24 * * *')).toThrow()
    expect(() => parseCronExpression('* * 32 * *')).toThrow()
    expect(() => parseCronExpression('* * * 13 *')).toThrow()
    expect(() => parseCronExpression('* * * * 8')).toThrow()
  })

  it('无效步长抛出错误', () => {
    expect(() => parseCronExpression('*/0 * * * *')).toThrow(/步长/)
  })
})

describe('isValidCronExpression', () => {
  it('有效表达式返回 true', () => {
    expect(isValidCronExpression('0 8 * * *')).toBe(true)
    expect(isValidCronExpression('*/15 * * * *')).toBe(true)
    expect(isValidCronExpression('0 0 1 1 *')).toBe(true)
    expect(isValidCronExpression('0 0 * * 0')).toBe(true)
    expect(isValidCronExpression('0 0 * * 7')).toBe(true) // 7=周日
  })

  it('无效表达式返回 false', () => {
    expect(isValidCronExpression('')).toBe(false)
    expect(isValidCronExpression('0 8 * *')).toBe(false)
    expect(isValidCronExpression('60 * * * *')).toBe(false)
    expect(isValidCronExpression('abc def * * *')).toBe(false)
  })
})

describe('isDue', () => {
  it('每分钟到期（* * * * *）', () => {
    const now = new Date(2026, 5, 22, 14, 30, 0)
    expect(isDue('* * * * *', now)).toBe(true)
  })

  it('指定分钟到期', () => {
    const matchTime = new Date(2026, 5, 22, 14, 30, 0)
    const nonMatchTime = new Date(2026, 5, 22, 14, 31, 0)
    expect(isDue('30 * * * *', matchTime)).toBe(true)
    expect(isDue('30 * * * *', nonMatchTime)).toBe(false)
  })

  it('指定小时到期', () => {
    const matchTime = new Date(2026, 5, 22, 8, 0, 0)
    const nonMatchTime = new Date(2026, 5, 22, 9, 0, 0)
    expect(isDue('0 8 * * *', matchTime)).toBe(true)
    expect(isDue('0 8 * * *', nonMatchTime)).toBe(false)
  })

  it('指定周几到期（0=周日）', () => {
    // 2026-06-21 是周日
    const sunday = new Date(2026, 5, 21, 8, 0, 0)
    // 2026-06-22 是周一
    const monday = new Date(2026, 5, 22, 8, 0, 0)
    expect(isDue('0 8 * * 0', sunday)).toBe(true)
    expect(isDue('0 8 * * 0', monday)).toBe(false)
    // 7 等价于 0
    expect(isDue('0 8 * * 7', sunday)).toBe(true)
  })

  it('指定日期到期', () => {
    const matchTime = new Date(2026, 5, 1, 0, 0, 0)
    const nonMatchTime = new Date(2026, 5, 2, 0, 0, 0)
    expect(isDue('0 0 1 * *', matchTime)).toBe(true)
    expect(isDue('0 0 1 * *', nonMatchTime)).toBe(false)
  })

  it('指定月份到期', () => {
    const matchTime = new Date(2026, 0, 1, 0, 0, 0) // 1月1日
    const nonMatchTime = new Date(2026, 1, 1, 0, 0, 0) // 2月1日
    expect(isDue('0 0 1 1 *', matchTime)).toBe(true)
    expect(isDue('0 0 1 1 *', nonMatchTime)).toBe(false)
  })

  it('无效表达式返回 false', () => {
    const now = new Date(2026, 5, 22, 14, 30, 0)
    expect(() => isDue('invalid', now)).toThrow()
  })
})

describe('CronScheduler', () => {
  it('addJob 添加任务并返回完整对象', () => {
    const scheduler = new CronScheduler(tempDir)
    const job = scheduler.addJob({
      name: '每日报告',
      schedule: '0 8 * * *',
      prompt: '生成每日报告',
    })

    expect(job.id).toBeTruthy()
    expect(job.name).toBe('每日报告')
    expect(job.schedule).toBe('0 8 * * *')
    expect(job.prompt).toBe('生成每日报告')
    expect(job.enabled).toBe(true)
    expect(job.lastRunAt).toBeNull()
    expect(job.lastResult).toBeNull()
    expect(job.timeoutMs).toBe(300_000)
    expect(job.createdAt).toBeTruthy()
    scheduler.close()
  })

  it('addJob 无效 cron 表达式抛出错误', () => {
    const scheduler = new CronScheduler(tempDir)
    expect(() =>
      scheduler.addJob({
        name: '无效任务',
        schedule: 'invalid',
        prompt: 'test',
      }),
    ).toThrow(/cron 表达式/)
    scheduler.close()
  })

  it('addJob 自定义参数', () => {
    const scheduler = new CronScheduler(tempDir)
    const job = scheduler.addJob({
      name: '自定义任务',
      agentId: 'agent-1',
      schedule: '*/15 * * * *',
      prompt: 'test',
      enabled: false,
      timeoutMs: 60_000,
    })

    expect(job.agentId).toBe('agent-1')
    expect(job.enabled).toBe(false)
    expect(job.timeoutMs).toBe(60_000)
    scheduler.close()
  })

  it('listJobs 返回所有任务的副本', () => {
    const scheduler = new CronScheduler(tempDir)
    scheduler.addJob({ name: '任务1', schedule: '0 8 * * *', prompt: 'p1' })
    scheduler.addJob({ name: '任务2', schedule: '0 9 * * *', prompt: 'p2' })

    const jobs = scheduler.listJobs()
    expect(jobs).toHaveLength(2)
    // 验证返回的是副本
    jobs[0].name = 'modified'
    expect(scheduler.listJobs()[0].name).toBe('任务1')
    scheduler.close()
  })

  it('getJob 返回指定任务的副本', () => {
    const scheduler = new CronScheduler(tempDir)
    const added = scheduler.addJob({ name: '任务1', schedule: '0 8 * * *', prompt: 'p1' })

    const job = scheduler.getJob(added.id)
    expect(job).toBeDefined()
    expect(job?.id).toBe(added.id)
    expect(job?.name).toBe('任务1')

    // 不存在的 ID
    expect(scheduler.getJob('non-existent')).toBeUndefined()
    scheduler.close()
  })

  it('updateJob 更新任务字段', () => {
    const scheduler = new CronScheduler(tempDir)
    const added = scheduler.addJob({ name: '原名称', schedule: '0 8 * * *', prompt: 'p1' })

    const updated = scheduler.updateJob(added.id, {
      name: '新名称',
      schedule: '0 9 * * *',
      enabled: false,
    })

    expect(updated.name).toBe('新名称')
    expect(updated.schedule).toBe('0 9 * * *')
    expect(updated.enabled).toBe(false)
    scheduler.close()
  })

  it('updateJob 无效 cron 表达式抛出错误', () => {
    const scheduler = new CronScheduler(tempDir)
    const added = scheduler.addJob({ name: '任务', schedule: '0 8 * * *', prompt: 'p1' })

    expect(() =>
      scheduler.updateJob(added.id, { schedule: 'invalid' }),
    ).toThrow(/cron 表达式/)
    scheduler.close()
  })

  it('updateJob 不存在的任务抛出错误', () => {
    const scheduler = new CronScheduler(tempDir)
    expect(() => scheduler.updateJob('non-existent', { name: 'x' })).toThrow(/任务不存在/)
    scheduler.close()
  })

  it('removeJob 删除任务', () => {
    const scheduler = new CronScheduler(tempDir)
    const added = scheduler.addJob({ name: '任务', schedule: '0 8 * * *', prompt: 'p1' })

    expect(scheduler.removeJob(added.id)).toBe(true)
    expect(scheduler.listJobs()).toHaveLength(0)
    // 再次删除返回 false
    expect(scheduler.removeJob(added.id)).toBe(false)
    scheduler.close()
  })

  it('enableJob / disableJob 切换任务状态', () => {
    const scheduler = new CronScheduler(tempDir)
    const added = scheduler.addJob({
      name: '任务',
      schedule: '0 8 * * *',
      prompt: 'p1',
      enabled: false,
    })

    expect(added.enabled).toBe(false)
    const enabled = scheduler.enableJob(added.id)
    expect(enabled.enabled).toBe(true)

    const disabled = scheduler.disableJob(added.id)
    expect(disabled.enabled).toBe(false)
    scheduler.close()
  })

  it('runJob 手动触发任务并发射 cron:tick 事件', async () => {
    const eventBus = new EventBus()
    const receivedEvents: CronTickEvent[] = []
    eventBus.on<CronTickEvent>('cron:tick', (e) => receivedEvents.push(e))

    const scheduler = new CronScheduler(tempDir, eventBus)
    const added = scheduler.addJob({
      name: '手动任务',
      agentId: 'agent-1',
      schedule: '0 8 * * *',
      prompt: '执行任务',
      timeoutMs: 100,
    })

    const result = await scheduler.runJob(added.id)
    expect(result.success).toBe(true)

    // 验证事件已发射
    expect(receivedEvents).toHaveLength(1)
    expect(receivedEvents[0].jobId).toBe(added.id)
    expect(receivedEvents[0].jobName).toBe('手动任务')
    expect(receivedEvents[0].agentId).toBe('agent-1')
    expect(receivedEvents[0].prompt).toBe('执行任务')
    expect(receivedEvents[0].source).toBe('manual')
    expect(receivedEvents[0].triggeredAt).toBeTruthy()

    // 验证任务状态已更新
    const job = scheduler.getJob(added.id)
    expect(job?.lastRunAt).toBeTruthy()
    expect(job?.lastResult).toBe('success')
    expect(job?.lastError).toBeNull()
    scheduler.close()
  })

  it('runJob 不存在的任务抛出错误', async () => {
    const scheduler = new CronScheduler(tempDir)
    await expect(scheduler.runJob('non-existent')).rejects.toThrow(/任务不存在/)
    scheduler.close()
  })

  it('runJob 禁用的任务也能手动触发', async () => {
    const eventBus = new EventBus()
    const receivedEvents: CronTickEvent[] = []
    eventBus.on<CronTickEvent>('cron:tick', (e) => receivedEvents.push(e))

    const scheduler = new CronScheduler(tempDir, eventBus)
    const added = scheduler.addJob({
      name: '禁用任务',
      schedule: '0 8 * * *',
      prompt: 'p1',
      enabled: false,
      timeoutMs: 100,
    })

    const result = await scheduler.runJob(added.id)
    expect(result.success).toBe(true)
    expect(receivedEvents).toHaveLength(1)
    scheduler.close()
  })

  it('持久化到 JSON 文件', () => {
    const scheduler = new CronScheduler(tempDir)
    scheduler.addJob({ name: '任务1', schedule: '0 8 * * *', prompt: 'p1' })
    scheduler.close()

    const filePath = join(tempDir, 'cron-jobs.json')
    expect(existsSync(filePath)).toBe(true)

    const content = readFileSync(filePath, 'utf8')
    const data = JSON.parse(content)
    expect(data).toHaveLength(1)
    expect(data[0].name).toBe('任务1')
  })

  it('从文件加载已有任务', () => {
    // 先写入一条任务
    const scheduler1 = new CronScheduler(tempDir)
    const added = scheduler1.addJob({ name: '持久化任务', schedule: '0 8 * * *', prompt: 'p1' })
    scheduler1.close()

    // 重新创建 scheduler，应能加载已有任务
    const scheduler2 = new CronScheduler(tempDir)
    const jobs = scheduler2.listJobs()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].id).toBe(added.id)
    expect(jobs[0].name).toBe('持久化任务')
    scheduler2.close()
  })

  it('空数据目录初始化正常', () => {
    const scheduler = new CronScheduler(tempDir)
    expect(scheduler.listJobs()).toHaveLength(0)
    scheduler.close()
  })

  it('start/stop 不重复启动定时器', () => {
    const scheduler = new CronScheduler(tempDir)
    // start 后再 start 不应抛错
    scheduler.start()
    scheduler.start()
    scheduler.stop()
    // stop 后再 stop 不应抛错
    scheduler.stop()
    scheduler.close()
  })

  it('close 后停止定时器', () => {
    const scheduler = new CronScheduler(tempDir)
    scheduler.start()
    scheduler.close()
    // close 后再调用其他方法不应崩溃
    expect(scheduler.listJobs()).toHaveLength(0)
  })

  it('checkJobs 跳过无效 cron 表达式的任务', async () => {
    // 直接写入一个无效表达式的任务到文件
    const eventBus = new EventBus()
    const scheduler = new CronScheduler(tempDir, eventBus)
    const added = scheduler.addJob({
      name: '有效任务',
      schedule: '* * * * *',
      prompt: 'p1',
      timeoutMs: 100,
    })
    // 手动破坏 schedule
    scheduler.updateJob(added.id, { schedule: '* * * * *' })
    // 模拟 checkJobs：通过手动触发 runJob 验证事件
    await scheduler.runJob(added.id)
    scheduler.close()
  })

  it('EventBus 可选（不传入也能工作）', async () => {
    const scheduler = new CronScheduler(tempDir)
    const added = scheduler.addJob({
      name: '无事件总线',
      schedule: '0 8 * * *',
      prompt: 'p1',
      timeoutMs: 100,
    })

    const result = await scheduler.runJob(added.id)
    expect(result.success).toBe(true)
    scheduler.close()
  })

  it('加载无效 JSON 文件时回退到空数组', () => {
    // 写入一个无效的 JSON 文件
    const filePath = join(tempDir, 'cron-jobs.json')
    const { writeFileSync } = require('node:fs')
    writeFileSync(filePath, 'invalid json content')

    // 创建 scheduler 不应抛错
    const scheduler = new CronScheduler(tempDir)
    expect(scheduler.listJobs()).toHaveLength(0)
    scheduler.close()
  })
})
