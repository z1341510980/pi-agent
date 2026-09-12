/**
 * newapi-video adapter：NewAPI 视频任务协议 + 多参考图协议 + aimanplay 模型档案。
 *
 * 文档口径（docs/new-api/openapi/generated/ai-model/视频（Videos））：
 * - POST {base}/video/generations：{ model, prompt, image?, duration?, width?,
 *   height?, fps?, n?, response_format:'url' } → { task_id, status }（queued）；
 * - GET {base}/video/generations/{task_id}：status queued/in_progress 继续、
 *   completed → url 字段、failed → error.message。
 *
 * 实测 NewAPI 兼容网关（aimanplay 等）的轮询响应不是文档的扁平形状，而是包裹层
 * {code,message,data:{status:'SUCCESS',fail_reason,result_url,progress,data:{results:[{url}]}}}；
 * 视频 URL 经 extractVideoUrls 提取（submit/poll 两条路径共用），失败原因优先取
 * data.fail_reason —— 均通过 ImageJobPollSource 的 extractUrls/failureText 覆盖注入，
 * 不改动 shared.parseImages 的图片语义。
 *
 * 多参考图协议（ComfyUI 类频道）：refImages 存在时提交 POST {base}/v1/videos，
 * 请求体为扁平 ref_image_0..N 字段 + duration/resolution（不带 width/height/fps/
 * n/response_format），轮询端点切换为 GET {base}/v1/videos/{task_id}。
 *
 * aimanplay 四模型档案（api.md §4，resolveAimanplayVideoProfile）：首尾帧模型走
 * first_frame/last_frame、图音参考模型走 ref_image_N + ref_audio_N、纯文生模型
 * 不带媒体字段；duration/resolution 按档案钳制与校验。所有参考素材提交前经
 * OSS 素材桥（../aimanplay-oss）URL 化 —— 接口只收 URL 不收 base64，data URL
 * 会被网关静默丢弃；http(s) 引用原样透传。
 *
 * 异步任务拆分（设计 Task 2）：submitVideoTask（提交即返回 task_id）与
 * pollVideoTask（单次状态查询，归一化 queued/in_progress/success/failed）供
 * 服务端任务队列使用；generateVideo 保留同步实现，内部复用同一 submit/poll
 * 原语（提交响应已有成品 URL 直接返回，否则按图片任务的退避节奏轮询）。
 * 下载回退（设计 Task 3，api.md §5.1/§5.2）：状态响应不含直链（文档口径）时，
 * success 归一化结果附带 content 端点（GET {base}/videos/{id}/content，Bearer
 * 字节流）作为 download 字段，由 worker/refresh 带鉴权头下载并本地化。
 */

import type {
  MediaModalityContext,
  MediaProviderAdapter,
  VideoGenerationInput,
  VideoTaskPollInput,
  VideoTaskPollResult,
  VideoTaskProtocol,
  VideoTaskSubmission
} from '../adapter.js'
import { mediaDiag } from '../../../../core/config/media-diag.js'
import { uploadToAimanplayOss, type AimanplayOssRuntime } from '../aimanplay-oss.js'
import {
  IMAGE_POLL_INITIAL_DELAY_MS,
  VIDEO_JOB_TIMEOUT_MS,
  delay,
  errorText,
  imageErrorMessage,
  imageJob,
  imageJobFailure,
  isCompletedStatus,
  isFailedStatus,
  isRecord,
  nextImagePollDelayMs,
  normalizeImageBaseUrl,
  readImageResponse,
  recordCandidates,
  safeBaseUrl,
  taskStatus,
  withAbortGuard,
  type ImageJobPollSource
} from '../shared.js'

/** Provider 行 model 留空时的文档示例模型（kling-v1）。 */
export const NEWAPI_VIDEO_DEFAULT_MODEL = 'kling-v1'

/** adapter 参数缺省值（formSchema 声明同源）。 */
export const NEWAPI_VIDEO_DEFAULTS = { duration: 5, width: 1280, height: 720, fps: 30 } as const

/**
 * ref_image_N 多参考协议的参考图上限（路由层入参校验与此同源）；
 * aimanplay 图音参考模型的文档上限即 9 张（api.md §4）。
 */
export const NEWAPI_VIDEO_MAX_REF_IMAGES = 9

/** ref_audio_N 参考音频上限（aimanplay 图音参考模型，路由层入参校验与此同源）。 */
export const NEWAPI_VIDEO_MAX_REF_AUDIOS = 3

/**
 * aimanplay 四模型档案（api.md §4 模型参数表，模型 id 精确匹配）：
 * 首尾帧/图音参考/纯文生三类，duration 范围+默认、resolution 枚举+默认
 * （竖屏优先 480p竖）。未知模型不进档案，保留既有通用行为。
 */
export interface AimanplayVideoProfile {
  kind: 'first-last' | 'ref-media' | 'text-only'
  durationRange: [number, number]
  defaultDuration: number
  resolutions: string[]
  defaultResolution: string
}

/** 首尾帧/纯文生档位（480p 竖→横、768p 竖→横，再加 1:1 方形）。 */
const AIMANPLAY_RESOLUTIONS_LIGHTX2V = [
  '480p竖',
  '480p横',
  '768p竖',
  '768p横',
  '480p(1:1)',
  '768p(1:1)'
]

/** 图音参考基础档位（v2_15s 不支持 1:1）。 */
const AIMANPLAY_RESOLUTIONS_REF_MEDIA = ['480p竖', '768p竖', '480p横', '768p横']

export const AIMANPLAY_MODEL_PROFILES: Record<string, AimanplayVideoProfile> = {
  minimax_h3_lightx2v: {
    kind: 'first-last',
    durationRange: [1, 10],
    defaultDuration: 5,
    resolutions: AIMANPLAY_RESOLUTIONS_LIGHTX2V,
    defaultResolution: '480p竖'
  },
  minimax_h3_image_audio_to_video_v2_15s: {
    kind: 'ref-media',
    durationRange: [1, 15],
    defaultDuration: 15,
    resolutions: AIMANPLAY_RESOLUTIONS_REF_MEDIA,
    defaultResolution: '480p竖'
  },
  minimax_h3_zm_u24: {
    kind: 'ref-media',
    durationRange: [1, 15],
    defaultDuration: 5,
    resolutions: [...AIMANPLAY_RESOLUTIONS_REF_MEDIA, '480p(1:1)', '768p(1:1)'],
    defaultResolution: '480p竖'
  },
  minimax_h3_lightx2v_no_pic: {
    kind: 'text-only',
    durationRange: [1, 10],
    defaultDuration: 5,
    resolutions: AIMANPLAY_RESOLUTIONS_LIGHTX2V,
    defaultResolution: '480p竖'
  }
}

/** 模型 id → 档案；未知/空模型返回 null（调用方回落通用行为）。 */
export function resolveAimanplayVideoProfile(model: string): AimanplayVideoProfile | null {
  return AIMANPLAY_MODEL_PROFILES[model.trim()] ?? null
}

/** 上游「排队中」状态词（其余非终态一律按 in_progress 继续轮询）。 */
const VIDEO_POLL_QUEUED_STATUSES = new Set(['queued', 'pending', 'created', 'waiting'])

/**
 * NewAPI 兼容网关的视频 URL 提取。实测包裹链是 data → data.data → data.data.data
 * （results 数组最深一层），优先级回落：result_url → results[].url → 任意层的 url
 * （文档扁平形状的顶层 url 兜底）。同一产物的多路编码（result_url 与嵌套 results
 * 并存）只取首个命中源，避免重复输出。submit/poll 两条路径共用。
 */
export function extractVideoUrls(body: unknown): string[] {
  if (!isRecord(body)) return []
  const layers = recordCandidates(body)
  for (const layer of layers) {
    if (typeof layer.result_url === 'string' && layer.result_url.length > 0) {
      return [layer.result_url]
    }
  }
  for (const layer of layers) {
    if (!Array.isArray(layer.results)) continue
    const urls: string[] = []
    for (const item of layer.results) {
      const url = isRecord(item) ? item.url : undefined
      if (typeof url === 'string' && url.length > 0 && !urls.includes(url)) urls.push(url)
    }
    if (urls.length) return urls
  }
  for (const layer of layers) {
    if (typeof layer.url === 'string' && layer.url.length > 0) return [layer.url]
  }
  return []
}

/** 视频任务失败文本：data.fail_reason 非空即失败（包裹层字段，status 可能只写 FAIL）。 */
export function videoFailureText(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.data)) return undefined
  const reason = body.data.fail_reason
  return typeof reason === 'string' && reason.trim() ? reason.trim() : undefined
}

/** 轮询响应里的进度文本（如 '42%'）：取包裹链任意层的 progress 字符串。 */
export function videoProgress(body: unknown): string | undefined {
  for (const candidate of recordCandidates(body)) {
    const progress = candidate.progress
    if (typeof progress === 'string' && progress.trim()) return progress.trim()
  }
  return undefined
}

interface VideoRuntime {
  providerId: string
  baseUrl: string
  apiKey: string
  model: string
  headers: Record<string, string>
}

function createRuntime(ctx: MediaModalityContext): VideoRuntime {
  return {
    providerId: ctx.providerId,
    baseUrl: normalizeImageBaseUrl(ctx.baseUrl),
    apiKey: ctx.apiKey,
    model: ctx.model || NEWAPI_VIDEO_DEFAULT_MODEL,
    headers: ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}
  }
}

function providerLabel(rt: VideoRuntime): string {
  return rt.providerId || safeBaseUrl(rt.baseUrl)
}

function pollSource(rt: VideoRuntime, useRefProtocol: boolean): ImageJobPollSource {
  return {
    providerId: rt.providerId,
    baseUrl: rt.baseUrl,
    headers: rt.headers,
    buildEndpoint: (jobId) =>
      useRefProtocol
        ? `${rt.baseUrl}/videos/${encodeURIComponent(jobId)}`
        : `${rt.baseUrl}/video/generations/${encodeURIComponent(jobId)}`,
    endpointLabel: useRefProtocol ? '/v1/videos/{task_id}' : '/video/generations/{task_id}',
    extractUrls: extractVideoUrls,
    failureText: videoFailureText
  }
}

/** 多参考协议载荷：refImages 按发送顺序展开成扁平 ref_image_0..N 字段。 */
function refImageFields(refImages: string[]): Record<string, string> {
  const fields: Record<string, string> = {}
  refImages.forEach((value, index) => {
    fields[`ref_image_${index}`] = value
  })
  return fields
}

/** 参考音频载荷：refAudios 按发送顺序展开成扁平 ref_audio_0..N 字段。 */
function refAudioFields(refAudios: string[]): Record<string, string> {
  const fields: Record<string, string> = {}
  refAudios.forEach((value, index) => {
    fields[`ref_audio_${index}`] = value
  })
  return fields
}

function countNonEmpty(values: string[] | undefined): number {
  return values?.filter((value) => value.length > 0).length ?? 0
}

interface MaterializedReferences {
  values: string[]
  /** 实际执行了 OSS 上传（非 http(s) 直传）的素材数，诊断用。 */
  uploadedCount: number
}

/**
 * 参考素材 URL 化：data URL/本地资产路径 → OSS 公开 URL（aimanplay 接口只收
 * URL），http(s) 原样透传。串行上传（设计文档口径：提交期串行上传兜底 STS 限流）。
 */
async function materializeReferences(
  rt: VideoRuntime,
  sources: string[] | undefined,
  kind: 'image' | 'audio',
  cap: number
): Promise<MaterializedReferences> {
  const list = (sources ?? []).filter((value) => value.length > 0).slice(0, cap)
  if (!list.length) return { values: [], uploadedCount: 0 }
  const ossRuntime: AimanplayOssRuntime = {
    providerId: rt.providerId,
    baseUrl: rt.baseUrl,
    apiKey: rt.apiKey
  }
  const values: string[] = []
  let uploadedCount = 0
  for (const source of list) {
    const isPublicUrl = /^https?:\/\//i.test(source.trim())
    const url = await uploadToAimanplayOss(ossRuntime, source, kind)
    if (!isPublicUrl) uploadedCount++
    values.push(url)
  }
  return { values, uploadedCount }
}

function numberParam(
  value: number | undefined,
  param: string | undefined,
  fallback: number
): number {
  if (value !== undefined && Number.isFinite(value) && value > 0) return value
  const parsed = Number(param)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return fallback
}

interface VideoSubmitPlan {
  body: Record<string, unknown>
  submitEndpoint: string
  protocol: VideoTaskProtocol
  /** 诊断元信息：命中的 aimanplay 模型档案类别（未知模型缺省）。 */
  modelProfile?: AimanplayVideoProfile['kind']
  /** 本次提交实际上传 OSS 的素材数（http(s) 直传不计）。 */
  uploadedToOss: number
  /** 进入提交体的参考音频数。 */
  refAudioCount: number
}

/** 档案 duration：入参非法（缺省/非正数）→ 模型默认；再钳入模型范围。 */
function profileDuration(profile: AimanplayVideoProfile, duration: number | undefined): number {
  const value =
    duration !== undefined && Number.isFinite(duration) && duration > 0
      ? duration
      : profile.defaultDuration
  const [min, max] = profile.durationRange
  return Math.min(max, Math.max(min, value))
}

/**
 * 档案 resolution：input → provider params → 模型默认三级回落；
 * 枚举外的值直接报可读错误（列出可选档位），绝不静默透传。
 */
function profileResolution(
  profile: AimanplayVideoProfile,
  model: string,
  input: VideoGenerationInput,
  ctx: MediaModalityContext
): string {
  const value =
    input.resolution?.trim() || ctx.params.resolution?.trim() || profile.defaultResolution
  if (!profile.resolutions.includes(value)) {
    throw new Error(
      `分辨率「${value}」不是模型 ${model} 支持的档位，可选：${profile.resolutions.join('、')}`
    )
  }
  return value
}

/** aimanplay 档案模型的提交载荷：素材先 URL 化，duration/resolution 先校验（失败不发起上传）。 */
async function buildProfileSubmitPlan(
  rt: VideoRuntime,
  ctx: MediaModalityContext,
  input: VideoGenerationInput,
  model: string,
  profile: AimanplayVideoProfile
): Promise<VideoSubmitPlan> {
  const submitEndpoint = `${rt.baseUrl}/videos`
  const duration = profileDuration(profile, input.duration)
  const resolution = profileResolution(profile, model, input, ctx)
  if (profile.kind === 'text-only') {
    const refImageCount = countNonEmpty(input.refImages)
    const refAudioCount = countNonEmpty(input.refAudios)
    if (refImageCount || refAudioCount) {
      mediaDiag.event('video-references-ignored', { model, refImageCount, refAudioCount })
    }
    return {
      body: { model, prompt: input.prompt, duration, resolution },
      submitEndpoint,
      protocol: 'videos',
      modelProfile: profile.kind,
      uploadedToOss: 0,
      refAudioCount: 0
    }
  }
  if (profile.kind === 'first-last') {
    const refs = (input.refImages ?? []).filter((value) => value.length > 0)
    if (refs.length < 2) {
      throw new Error(`首尾帧模型 ${model} 需要 2 张参考图（首帧与尾帧）`)
    }
    const materialized = await materializeReferences(rt, refs, 'image', 2)
    return {
      body: {
        model,
        prompt: input.prompt,
        first_frame: materialized.values[0]!,
        last_frame: materialized.values[1]!,
        duration,
        resolution
      },
      submitEndpoint,
      protocol: 'videos',
      modelProfile: profile.kind,
      uploadedToOss: materialized.uploadedCount,
      refAudioCount: 0
    }
  }
  const images = await materializeReferences(
    rt,
    input.refImages,
    'image',
    NEWAPI_VIDEO_MAX_REF_IMAGES
  )
  const audios = await materializeReferences(
    rt,
    input.refAudios,
    'audio',
    NEWAPI_VIDEO_MAX_REF_AUDIOS
  )
  return {
    body: {
      model,
      prompt: input.prompt,
      ...refImageFields(images.values),
      ...refAudioFields(audios.values),
      duration,
      resolution
    },
    submitEndpoint,
    protocol: 'videos',
    modelProfile: profile.kind,
    uploadedToOss: images.uploadedCount + audios.uploadedCount,
    refAudioCount: audios.values.length
  }
}

/**
 * 组装提交载荷：aimanplay 四模型按档案分流（素材先 URL 化）；未知模型保留
 * 既有分流（带参考图 → /v1/videos ref_image_N，否则文档协议 /video/generations），
 * 但参考图同样先物化为 OSS 公开 URL —— 修复 base64 data URL 被网关静默丢弃。
 */
async function buildSubmitPlan(
  rt: VideoRuntime,
  ctx: MediaModalityContext,
  input: VideoGenerationInput
): Promise<VideoSubmitPlan> {
  const model = input.model || rt.model
  const profile = resolveAimanplayVideoProfile(model)
  if (profile) {
    return buildProfileSubmitPlan(rt, ctx, input, model, profile)
  }
  const refs = await materializeReferences(
    rt,
    input.refImages,
    'image',
    NEWAPI_VIDEO_MAX_REF_IMAGES
  )
  const refImages = refs.values
  const useRefProtocol = Boolean(refImages.length)
  const resolution = input.resolution?.trim() || ctx.params.resolution?.trim() || ''
  const body = useRefProtocol
    ? {
        model: input.model || rt.model,
        prompt: input.prompt,
        ...refImageFields(refImages),
        duration: numberParam(input.duration, ctx.params.duration, NEWAPI_VIDEO_DEFAULTS.duration),
        ...(resolution ? { resolution } : {})
      }
    : {
        model: input.model || rt.model,
        prompt: input.prompt,
        ...(input.image ? { image: input.image } : {}),
        duration: numberParam(input.duration, ctx.params.duration, NEWAPI_VIDEO_DEFAULTS.duration),
        width: numberParam(input.width, ctx.params.width, NEWAPI_VIDEO_DEFAULTS.width),
        height: numberParam(input.height, ctx.params.height, NEWAPI_VIDEO_DEFAULTS.height),
        fps: numberParam(input.fps, ctx.params.fps, NEWAPI_VIDEO_DEFAULTS.fps),
        ...(input.n !== undefined && Number.isFinite(input.n) ? { n: Math.floor(input.n) } : {}),
        response_format: 'url'
      }
  return {
    body,
    submitEndpoint: useRefProtocol ? `${rt.baseUrl}/videos` : `${rt.baseUrl}/video/generations`,
    protocol: useRefProtocol ? 'videos' : 'generations',
    uploadedToOss: refs.uploadedCount,
    refAudioCount: 0
  }
}

/**
 * 提交视频任务（submitVideoTask 与 generateVideo 共用）：POST 提交端点并解析
 * task_id。语义与同步实现的 resolveImageResponse 逐条对齐 —— 成品 URL 优先、
 * data.fail_reason 次之、再按状态判定 failed/completed，均直接抛错。
 * 同步形状网关（响应带成品 URL 无 task_id）返回 urls + 空串 taskId。
 */
async function submitVideoRequest(
  rt: VideoRuntime,
  plan: VideoSubmitPlan,
  signal: AbortSignal | undefined
): Promise<VideoTaskSubmission> {
  const guard = withAbortGuard(signal, VIDEO_JOB_TIMEOUT_MS)
  try {
    // 提交侧诊断：只记元信息（数量/字节），不落提示词与图片内容 —— 回答「参考图到底发了吗」
    const refImageEntries = Object.entries(plan.body).filter(([key]) =>
      key.startsWith('ref_image_')
    )
    mediaDiag.event('video-submit', {
      providerId: rt.providerId,
      endpoint: plan.submitEndpoint.replace(rt.baseUrl, ''),
      protocol: plan.protocol,
      model: typeof plan.body.model === 'string' ? plan.body.model : '',
      ...(plan.modelProfile ? { modelProfile: plan.modelProfile } : {}),
      uploadedToOss: plan.uploadedToOss,
      refAudioCount: plan.refAudioCount,
      refImageCount: refImageEntries.length,
      refImageBytes: refImageEntries.reduce(
        (total, [, value]) => total + (typeof value === 'string' ? value.length : 0),
        0
      ),
      singleImageBytes: typeof plan.body.image === 'string' ? plan.body.image.length : 0
    })
    const response = await fetch(plan.submitEndpoint, {
      method: 'POST',
      headers: { ...rt.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(plan.body),
      signal: guard.signal
    })
    const responseBody = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(
        `视频生成失败: ${imageErrorMessage(responseBody) || `HTTP ${response.status}`}`
      )
    }
    const urls = extractVideoUrls(responseBody)
    if (urls.length) {
      // 提交响应已携带成品 URL（提交即完成 / 同步形状网关）：无需任务轮询
      return {
        taskId: imageJob(responseBody)?.id ?? '',
        protocol: plan.protocol,
        status: 'success',
        urls
      }
    }
    const failureText = videoFailureText(responseBody)
    if (failureText) throw new Error(`视频生成失败: ${failureText}`)
    const job = imageJob(responseBody)
    if (!job?.id) throw new Error('视频 Provider 返回中没有视频数据')
    const status = taskStatus(job.status)
    if (isFailedStatus(status)) throw imageJobFailure(responseBody, '视频生成失败')
    if (isCompletedStatus(status)) throw new Error('视频 Provider 返回中没有视频数据')
    return { taskId: job.id, protocol: plan.protocol, status: status || 'queued' }
  } finally {
    guard.dispose()
  }
}

/**
 * 单次任务状态查询（pollVideoTask 与 generateVideo 轮询循环共用）：GET 任务端点
 * 一次，把上游形状归一化成 queued/in_progress/success/failed；HTTP 层错误直接
 * 抛出（worker 记日志后下轮重试，refresh 路由按 502 透出）。每次轮询落一条
 * job-poll 诊断事件（镜像 shared.pollImageJob），live 网关排查不盲。
 */
async function pollVideoTaskOnce(
  rt: VideoRuntime,
  input: VideoTaskPollInput
): Promise<VideoTaskPollResult> {
  const source = pollSource(rt, input.protocol === 'videos')
  const guard = withAbortGuard(input.signal)
  try {
    const response = await fetch(source.buildEndpoint(input.taskId), {
      headers: source.headers,
      signal: guard.signal
    })
    const body = await readImageResponse(response, '视频任务查询失败')
    const progress = videoProgress(body)
    const withProgress = (result: VideoTaskPollResult): VideoTaskPollResult =>
      progress ? { ...result, progress } : result
    const urls = extractVideoUrls(body)
    const failureText = source.failureText?.(body)
    const statusCandidate = recordCandidates(body).find(
      (candidate) => typeof candidate.status === 'string' || typeof candidate.state === 'string'
    )
    const fallbackStatus = statusCandidate?.status ?? statusCandidate?.state
    const job = imageJob(body)
    const rawStatus = job?.status ?? (typeof fallbackStatus === 'string' ? fallbackStatus : '')
    const status = taskStatus(rawStatus)
    mediaDiag.event('job-poll', {
      provider: providerLabel(rt),
      jobId: input.taskId,
      jobStatus: rawStatus
    })
    if (urls.length) return withProgress({ status: 'success', url: urls[0] })
    if (failureText) return withProgress({ status: 'failed', error: failureText })
    if (isFailedStatus(status)) {
      return withProgress({
        status: 'failed',
        error: imageErrorMessage(body) || rawStatus || '视频任务失败'
      })
    }
    if (isCompletedStatus(status)) {
      // 文档口径（api.md §5.1/§5.2）：状态响应不含视频直链，标准下载是
      // GET {base}/videos/{id}/content（Bearer 字节流）。网关兼容层的
      // result_url/嵌套 results 优先（上方 urls 分支），都缺失时回退
      // content 端点，由下载方（worker/refresh）带鉴权头拉流本地化。
      return withProgress({
        status: 'success',
        download: {
          url: `${rt.baseUrl}/videos/${encodeURIComponent(input.taskId)}/content`,
          headers: rt.headers
        }
      })
    }
    if (!job && !status) {
      return withProgress({ status: 'failed', error: '视频 Provider 返回中没有视频数据' })
    }
    return withProgress({
      status: VIDEO_POLL_QUEUED_STATUSES.has(status) ? 'queued' : 'in_progress'
    })
  } finally {
    guard.dispose()
  }
}

export const newapiVideoAdapter: MediaProviderAdapter = {
  id: 'newapi-video',
  label: 'NewAPI 视频任务',
  modality: 'video',
  capabilities: { generate: true },
  formSchema: [
    { key: 'duration', label: '时长（秒）', type: 'number', placeholder: '5' },
    { key: 'width', label: '宽度', type: 'number', placeholder: '1280' },
    { key: 'height', label: '高度', type: 'number', placeholder: '720' },
    { key: 'fps', label: '帧率', type: 'number', placeholder: '30' },
    { key: 'resolution', label: '分辨率', type: 'text', placeholder: '如 768p竖（多参考协议透传）' }
  ],
  async generateVideo(
    ctx: MediaModalityContext,
    input: VideoGenerationInput
  ): Promise<{ outputs: Array<{ url: string; mimeType: string }> }> {
    const rt = createRuntime(ctx)
    const plan = await buildSubmitPlan(rt, ctx, input)
    const guard = withAbortGuard(input.signal, VIDEO_JOB_TIMEOUT_MS)
    try {
      // 提交：拿 task_id 或提交即完成的成品 URL（与队列链路 submitVideoTask 同一实现）
      const submission = await submitVideoRequest(rt, plan, input.signal)
      if (submission.urls?.length) {
        return {
          outputs: submission.urls.map((url) => ({ url, mimeType: 'video/mp4' }))
        }
      }
      // 轮询：与 pollVideoTask 同一单次查询实现，退避节奏与图片任务一致
      // （首个间隔 2s，其后 1.5 倍递增封顶 10s）
      let waitMs = IMAGE_POLL_INITIAL_DELAY_MS
      for (;;) {
        await delay(waitMs, guard.signal)
        const poll = await pollVideoTaskOnce(rt, {
          taskId: submission.taskId,
          protocol: submission.protocol,
          signal: guard.signal
        })
        if (poll.status === 'success') {
          // content 端点回退（api.md §5.2）：无直链时输出鉴权下载地址，
          // 同步链路的本地化失败会保留原始地址兜底
          const outputUrl = poll.url ?? poll.download?.url
          if (!outputUrl) throw new Error('视频 Provider 返回中没有视频数据')
          return { outputs: [{ url: outputUrl, mimeType: 'video/mp4' }] }
        }
        if (poll.status === 'failed') {
          throw new Error(`视频生成失败: ${poll.error ?? '任务失败'}`)
        }
        waitMs = nextImagePollDelayMs(waitMs)
      }
    } catch (error) {
      ctx.logger?.error?.(
        {
          providerId: rt.providerId,
          provider: providerLabel(rt),
          endpoint: plan.protocol === 'videos' ? '/v1/videos' : '/video/generations',
          error: errorText(error)
        },
        '视频请求失败'
      )
      throw error
    } finally {
      guard.dispose()
    }
  },
  async submitVideoTask(
    ctx: MediaModalityContext,
    input: VideoGenerationInput
  ): Promise<VideoTaskSubmission> {
    const rt = createRuntime(ctx)
    return submitVideoRequest(rt, await buildSubmitPlan(rt, ctx, input), input.signal)
  },
  async pollVideoTask(
    ctx: MediaModalityContext,
    input: VideoTaskPollInput
  ): Promise<VideoTaskPollResult> {
    return pollVideoTaskOnce(createRuntime(ctx), input)
  }
}
