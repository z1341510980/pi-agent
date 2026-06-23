/**
 * CronScheduler：定时任务调度器
 *
 * 功能：
 * - cron 表达式解析（标准 5 段式：分 时 日 月 周）
 * - 任务调度（每分钟检查到期任务）
 * - 任务执行（通过 EventBus 发射 cron:tick 事件）
 * - 错误处理和超时控制
 * - 持久化到 {dataDir}/cron-jobs.json
 *
 * 支持：添加/删除/更新/启用/禁用/列出任务、手动触发任务
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteSync } from '@repo/shared/utils'
import type { EventBus } from '@repo/shared/events'

/** Cron 任务定义 */
export interface CronJob {
  /** UUID */
  id: string
  /** 任务名称 */
  name: string
  /** 目标 Agent ID */
  agentId: string
  /** Cron 表达式（标准 5 段式） */
  schedule: string
  /** 执行的 prompt */
  prompt: string
  /** 是否启用 */
  enabled: boolean
  /** 上次执行时间（ISO 字符串） */
  lastRunAt: string | null
  /** 上次执行结果 */
  lastResult: 'success' | 'error' | null
  /** 执行超时（毫秒），默认 300000 = 5 分钟 */
  timeoutMs: number
  /** 创建时间（ISO 字符串） */
  createdAt: string
  /** 上次执行错误信息（如有） */
  lastError?: string | null
}

/** 创建任务时的输入 */
export interface CreateCronJobInput {
  name: string
  agentId?: string
  schedule: string
  prompt: string
  enabled?: boolean
  timeoutMs?: number
}

/** 更新任务时的输入 */
export interface UpdateCronJobInput {
  name?: string
  agentId?: string
  schedule?: string
  prompt?: string
  enabled?: boolean
  timeoutMs?: number
}

/** cron:tick 事件载荷 */
export interface CronTickEvent {
  jobId: string
  jobName: string
  agentId: string
  prompt: string
  triggeredAt: string
  source: 'schedule' | 'manual'
}

/** Cron 字段定义 */
interface CronField {
  min: number
  max: number
}

const CRON_FIELDS: CronField[] = [
  { min: 0, max: 59 }, // 分钟
  { min: 0, max: 23 }, // 小时
  { min: 1, max: 31 }, // 日
  { min: 1, max: 12 }, // 月
  { min: 0, max: 6 },  // 周（0=周日）
]

/**
 * 解析 cron 表达式中的单个字段
 * @returns 该字段匹配的值集合；无效时抛出错误
 */
function parseField(field: string, fieldDef: CronField, isWeekday: boolean): Set<number> {
  const result = new Set<number>()
  const { min, max } = fieldDef

  // 处理逗号分隔的列表
  for (const part of field.split(',')) {
    // 处理步长（*/N 或 1-10/N）
    const [rangePart, stepPart] = part.split('/')
    const step = stepPart ? parseInt(stepPart, 10) : 1

    if (!Number.isFinite(step) || step < 1) {
      throw new Error(`无效的步长: ${part}`)
    }

    let start: number
    let end: number

    if (rangePart === '*') {
      start = min
      end = max
    } else if (rangePart.includes('-')) {
      const [s, e] = rangePart.split('-')
      start = parseInt(s, 10)
      end = parseInt(e, 10)
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < min || end > max || start > end) {
        throw new Error(`无效的范围: ${part}`)
      }
    } else {
      // 单个值（7 在周字段中表示周日，转换为 0）
      let val = parseInt(rangePart, 10)
      if (isWeekday && val === 7) val = 0
      if (!Number.isFinite(val) || val < min || val > max) {
        throw new Error(`无效的值: ${part}`)
      }
      start = val
      end = val
    }

    for (let i = start; i <= end; i += step) {
      result.add(i)
    }
  }

  return result
}

/**
 * 解析 cron 表达式
 * @returns 5 个字段的值集合数组
 */
export function parseCronExpression(expr: string): Set<number>[] {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`Cron 表达式必须为 5 段式，实际为 ${parts.length} 段`)
  }

  return parts.map((part, i) => parseField(part, CRON_FIELDS[i], i === 4))
}

/**
 * 判断 cron 表达式是否在指定时间到期
 */
export function isDue(expr: string, date: Date): boolean {
  const fields = parseCronExpression(expr)
  const minute = date.getMinutes()
  const hour = date.getHours()
  const day = date.getDate()
  const month = date.getMonth() + 1 // JS 月份从 0 开始
  const weekday = date.getDay() // 0=周日

  return (
    fields[0].has(minute) &&
    fields[1].has(hour) &&
    fields[2].has(day) &&
    fields[3].has(month) &&
    fields[4].has(weekday)
  )
}

/** 校验 cron 表达式是否有效 */
export function isValidCronExpression(expr: string): boolean {
  try {
    parseCronExpression(expr)
    return true
  } catch {
    return false
  }
}

/** 默认超时 5 分钟 */
const DEFAULT_TIMEOUT_MS = 300_000

/**
 * Cron 定时任务调度器
 */
export class CronScheduler {
  private readonly filePath: string
  private jobs: CronJob[] = []
  private timer: NodeJS.Timeout | null = null
  private dirty = false
  private readonly eventBus: EventBus | null

  constructor(dataDir: string, eventBus?: EventBus) {
    this.filePath = join(dataDir, 'cron-jobs.json')
    this.eventBus = eventBus ?? null
    this.load()
  }

  /**
   * 启动调度器（每分钟检查一次）
   */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.checkJobs()
    }, 60_000)
    this.timer.unref() // 不阻止进程退出
  }

  /**
   * 停止调度器
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * 列出所有任务
   */
  listJobs(): CronJob[] {
    return this.jobs.map((j) => ({ ...j }))
  }

  /**
   * 获取指定任务
   */
  getJob(id: string): CronJob | undefined {
    const job = this.jobs.find((j) => j.id === id)
    return job ? { ...job } : undefined
  }

  /**
   * 添加任务
   */
  addJob(input: CreateCronJobInput): CronJob {
    if (!isValidCronExpression(input.schedule)) {
      throw new Error(`无效的 cron 表达式: ${input.schedule}`)
    }

    const job: CronJob = {
      id: randomUUID(),
      name: input.name,
      agentId: input.agentId ?? 'default',
      schedule: input.schedule,
      prompt: input.prompt,
      enabled: input.enabled ?? true,
      lastRunAt: null,
      lastResult: null,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      createdAt: new Date().toISOString(),
      lastError: null,
    }

    this.jobs.push(job)
    this.dirty = true
    this.persist()
    return { ...job }
  }

  /**
   * 更新任务
   */
  updateJob(id: string, input: UpdateCronJobInput): CronJob {
    const job = this.jobs.find((j) => j.id === id)
    if (!job) {
      throw new Error(`任务不存在: ${id}`)
    }

    if (input.schedule !== undefined && !isValidCronExpression(input.schedule)) {
      throw new Error(`无效的 cron 表达式: ${input.schedule}`)
    }

    if (input.name !== undefined) job.name = input.name
    if (input.agentId !== undefined) job.agentId = input.agentId
    if (input.schedule !== undefined) job.schedule = input.schedule
    if (input.prompt !== undefined) job.prompt = input.prompt
    if (input.enabled !== undefined) job.enabled = input.enabled
    if (input.timeoutMs !== undefined) job.timeoutMs = input.timeoutMs

    this.dirty = true
    this.persist()
    return { ...job }
  }

  /**
   * 删除任务
   */
  removeJob(id: string): boolean {
    const before = this.jobs.length
    this.jobs = this.jobs.filter((j) => j.id !== id)
    const removed = this.jobs.length < before
    if (removed) {
      this.dirty = true
      this.persist()
    }
    return removed
  }

  /**
   * 启用任务
   */
  enableJob(id: string): CronJob {
    return this.setJobEnabled(id, true)
  }

  /**
   * 禁用任务
   */
  disableJob(id: string): CronJob {
    return this.setJobEnabled(id, false)
  }

  private setJobEnabled(id: string, enabled: boolean): CronJob {
    const job = this.jobs.find((j) => j.id === id)
    if (!job) {
      throw new Error(`任务不存在: ${id}`)
    }
    job.enabled = enabled
    this.dirty = true
    this.persist()
    return { ...job }
  }

  /**
   * 手动触发任务执行
   * 不检查 enabled 状态，立即执行
   */
  async runJob(id: string): Promise<{ success: boolean; error?: string }> {
    const job = this.jobs.find((j) => j.id === id)
    if (!job) {
      throw new Error(`任务不存在: ${id}`)
    }

    return this.executeJob(job, 'manual')
  }

  /**
   * 检查所有启用的任务，执行到期任务
   */
  private async checkJobs(): Promise<void> {
    const now = new Date()
    const enabledJobs = this.jobs.filter((j) => j.enabled)

    for (const job of enabledJobs) {
      let due = false
      try {
        due = isDue(job.schedule, now)
      } catch {
        // cron 表达式无效，跳过
        continue
      }

      if (!due) continue

      try {
        await this.executeJob(job, 'schedule')
      } catch {
        // executeJob 内部已处理错误，这里防止中断其他任务
      }
    }
  }

  /**
   * 执行单个任务（带超时控制）
   */
  private async executeJob(job: CronJob, source: 'schedule' | 'manual'): Promise<{ success: boolean; error?: string }> {
    const now = new Date().toISOString()

    // 发射 cron:tick 事件，由 Agent 系统响应执行
    const tickEvent: CronTickEvent = {
      jobId: job.id,
      jobName: job.name,
      agentId: job.agentId,
      prompt: job.prompt,
      triggeredAt: now,
      source,
    }

    let success = true
    let errorMessage: string | null = null

    try {
      if (this.eventBus) {
        this.eventBus.emit('cron:tick', tickEvent)
      }

      // 等待超时（如果有事件处理器执行实际工作，这里只做超时控制）
      // 实际的 Agent 执行由 cron:tick 事件的监听器异步完成
      // 这里使用 timeoutMs 作为最长等待时间
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.min(job.timeoutMs, 5000)) // 最多等待 5 秒，避免阻塞调度器
        timer.unref()
      })
    } catch (err) {
      success = false
      errorMessage = err instanceof Error ? err.message : String(err)
    }

    // 更新任务状态
    const jobIndex = this.jobs.findIndex((j) => j.id === job.id)
    if (jobIndex >= 0) {
      this.jobs[jobIndex].lastRunAt = now
      this.jobs[jobIndex].lastResult = success ? 'success' : 'error'
      this.jobs[jobIndex].lastError = success ? null : errorMessage
      this.dirty = true
      this.persist()
    }

    return { success, error: errorMessage ?? undefined }
  }

  /**
   * 关闭调度器，持久化脏数据
   */
  close(): void {
    this.stop()
    if (this.dirty) {
      this.persistOrThrow()
    }
  }

  /** 从文件加载任务 */
  private load(): void {
    if (!existsSync(this.filePath)) {
      this.jobs = []
      return
    }
    try {
      const content = readFileSync(this.filePath, 'utf8')
      const data = JSON.parse(content)
      if (!Array.isArray(data)) {
        this.jobs = []
        return
      }
      // 校验记录结构
      this.jobs = data.filter((j: unknown) => {
        if (j && typeof j === 'object' && typeof (j as CronJob).id === 'string' && typeof (j as CronJob).schedule === 'string') return true
        return false
      }) as CronJob[]
    } catch (err) {
      console.error(`[CronScheduler] 加载 ${this.filePath} 失败:`, err)
      this.jobs = []
    }
  }

  /** 持久化到文件（静默失败） */
  private persist(): void {
    try {
      atomicWriteSync(this.filePath, JSON.stringify(this.jobs, null, 2))
      this.dirty = false
    } catch (err) {
      console.error(`[CronScheduler] persist 失败:`, err)
    }
  }

  /** 持久化到文件（失败时抛出异常） */
  private persistOrThrow(): void {
    atomicWriteSync(this.filePath, JSON.stringify(this.jobs, null, 2))
    this.dirty = false
  }
}
