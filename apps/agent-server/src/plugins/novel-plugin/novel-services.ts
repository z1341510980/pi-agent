/**
 * 小说创作系统服务初始化
 *
 * 集中创建小说系统的所有核心组件，供 novel-plugin 的 setup 调用：
 * - NovelStore：统一存储（SQLite CRUD）
 * - NovelMemoryStore：长期记忆分层存储（事件 + 快照 + 因果链）
 * - PromptManager：提示词模板管理器（三级覆盖）
 * - NovelPromptBuilder：缓存优化的提示词构建器
 * - NovelEngine：核心引擎（流程编排）
 * - NovelOrchestrator：多 Agent 编排引擎（Director → Writer → Reviewer → Reviser → Memory）
 * - NovelCharacterGenerator：AI 角色生成器
 * - tools：Pi Session 自定义工具集
 *
 * 依赖关系：
 * - NovelStore 依赖 db
 * - NovelMemoryStore 依赖 db
 * - PromptManager 依赖 db + cwd
 * - NovelPromptBuilder 依赖 PromptManager + NovelStore + NovelMemoryStore + RelationshipGraph + ConsistencyAuditor
 * - NovelEngine 依赖 NovelStore
 * - NovelOrchestrator 依赖 NovelStore + NovelMemoryStore + tools + NovelPromptBuilder + NovelEngine + PluginContext + NovelMemoryGenerator
 * - NovelCharacterGenerator 依赖 NovelPromptBuilder + PromptManager + PluginContext
 * - createNovelTools 依赖 NovelStore
 */

import { NovelStore } from './core/novel-store.js'
import { PromptManager } from './core/prompting/prompt-manager.js'
import { NovelPromptBuilder } from './core/prompt-builder.js'
import { NovelEngine } from './core/novel-engine.js'
import { createNovelTools } from './core/novel-tools.js'
import { NovelOrchestrator } from './core/novel-orchestrator.js'
import { NovelCharacterGenerator } from './core/generation/novel-character-generator.js'
import { NovelEntityGenerator } from './core/generation/novel-entity-generator.js'
import { NovelMemoryGenerator } from './core/generation/novel-memory-generator.js'
import { NovelSimilarityScanner } from './core/entities/novel-similarity-scanner.js'
import { NovelMemoryStore } from './core/novel-memory-store.js'
import { createChapterProjectionRecorder } from './core/chapters/chapter-projection-recorder.js'
import { NovelDiscussionRunner } from './core/discussion/novel-discussion-runner.js'
import { ChapterChatRunner } from './core/chapters/chapter-chat-runner.js'
import { ChapterChatStore } from './core/chapters/chapter-chat-store.js'
import { ChapterOutlineGenerator } from './core/chapters/chapter-outline-generator.js'
import { VolumeBeatPlanner } from './core/chapters/beat-plan-generator.js'
import { DiscussionRunStore } from './core/discussion/discussion-run-store.js'
import { WorkflowRunStore } from './core/workflow-run-store.js'
import { DiscussionSettingsStore } from './core/discussion/engine/discussion-settings-store.js'
import { ConsistencyAuditor } from './core/analysis/consistency-auditor.js'
import { RelationshipGraph } from './core/analysis/novel-relationship-graph.js'
import { ReferenceAnalysisStore } from './core/analysis/reference-analysis-store.js'
import { ReferenceAnalysisService } from './core/analysis/reference-analysis-service.js'
import { ReferenceAnalysisRunStore } from './core/analysis/reference-analysis-run-store.js'
import { ReferenceAnalysisRunWorker } from './core/analysis/reference-analysis-run-worker.js'
import { ReferenceProfileStore } from './core/analysis/reference-profile-store.js'
import { ReferenceTemplateStore } from './core/analysis/reference-template-store.js'
import { ReferenceValidationRunStore } from './core/analysis/reference-validation-run-store.js'
import { ReferenceValidationRunWorker } from './core/analysis/reference-validation-run-worker.js'
import { TimelineRebuildRunner } from './core/analysis/timeline-rebuild-runner.js'
import { CostReportService } from './core/analysis/cost-report-service.js'
import { ObservabilityService } from './core/analysis/observability-service.js'
import { SharedOverlapAnalyzer } from './core/analysis/shared-overlap-analyzer.js'
import type { PluginContext } from '../../core/plugin/plugin-types.js'
import type { TeamManager } from '../../core/agent/team-manager.js'
import type { AgentManager } from '../../core/agent/subagent-tool.js'
import type { ConfirmationManager } from '../../core/tool/confirmation-manager.js'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { createInterjectDispatchHooks } from './utils/chapter-task-registry.js'

export interface NovelServices {
  /** 插件运行时，用于文风蒸馏等不改写领域账本的临时 Agent 调用。 */
  context: PluginContext
  store: NovelStore
  memoryStore: NovelMemoryStore
  promptManager: PromptManager
  promptBuilder: NovelPromptBuilder
  /**
   * 统一关系图查询层（聚合 edges + JSON 派生 + relationships）
   * 与 novel-routes 共享同一实例，避免重复实例化
   */
  relationshipGraph: RelationshipGraph
  /**
   * 跨章节一致性审计器（伏笔/钩子/孤儿实体/时间线）
   * 与 novel-routes 共享同一实例，避免重复实例化
   */
  consistencyAuditor: ConsistencyAuditor
  engine: NovelEngine
  orchestrator: NovelOrchestrator
  characterGenerator: NovelCharacterGenerator
  entityGenerator: NovelEntityGenerator
  /** LLM 驱动的相似实体扫描器（语义相似去重，与 deduplicateEntities 互补） */
  similarityScanner: NovelSimilarityScanner
  tools: ToolDefinition[]
  /**
   * TeamManager（可选，由 teamPlugin 提供）
   * 当 teamPlugin 已注册且 plugin-loader 完成注入时可用，
   * 供 novel-routes 的 create-team 路由触发统一团队执行。
   */
  teamManager?: TeamManager
  /**
   * AgentManager（可选，由 subagentPlugin 提供）
   * 当用户通过 PUT /agent-config 调整温度时，需同步到 AgentManager
   * 让 subagent / team_execute 路径也能拿到最新温度。
   */
  agentManager?: AgentManager
  /**
   * ConfirmationManager（chat 底座共享，由 PluginContext 注入）
   *
   * 供 novel checkpoint 流程复用 chat 的统一确认/决策机制：
   * - 默认 120s 超时，避免 checkpoint 用户不响应导致永久 pending
   * - 复用 pending 列表与 'confirmation:request' / 'confirmation:resolved' 事件
   * - 调用 requestDecision/respondDecision 处理 'approve'/'reject'/'revise'/'rewrite' 等多决策
   */
  confirmationManager: ConfirmationManager
  /** 群聊共创模式 Runner */
  discussionRunner: NovelDiscussionRunner
  /** 群聊设置存储 */
  discussionSettingsStore: DiscussionSettingsStore
  /** 群聊运行快照存储（断点续跑） */
  discussionRunStore: DiscussionRunStore
  workflowRunStore: WorkflowRunStore
  /** 章节聊天消息存储（按章节持久化用户输入与 Agent 回复） */
  chapterChatStore: ChapterChatStore
  /** 章节级自由聊天 Runner */
  chapterChatRunner: ChapterChatRunner
  /** 无副作用的章节章纲草稿生成器 */
  outlineGenerator: ChapterOutlineGenerator
  /** 卷级节拍表生成器（Beat Planner，含卷纲质量门） */
  beatPlanner: VolumeBeatPlanner
  /** 参考小说阶段 1：与故事实体/Prompt 隔离的本地分析服务 */
  referenceAnalysis?: ReferenceAnalysisService
  /** P4：远端分析 run 持久化（novel_reference_analysis_runs） */
  referenceAnalysisRuns: ReferenceAnalysisRunStore
  /** P4：远端分析执行器（阶段推进/checkpoint/取消恢复；事件只存摘要） */
  referenceAnalysisWorker: ReferenceAnalysisRunWorker
  /** P5：参考档案与 finding 审核存储（novel_reference_profiles） */
  referenceProfiles: ReferenceProfileStore
  /** P6：私人模板与不可变版本链存储 */
  referenceTemplates: ReferenceTemplateStore
  /** P7：同场景验证 run 存储 */
  referenceValidationRuns: ReferenceValidationRunStore
  /** P7：同场景验证执行器（双路生成/固定 facts hash/安全拦截） */
  referenceValidationWorker: ReferenceValidationRunWorker
  /** 中间章隔离顺序重建执行器（start/resume 触发逐章隔离分析，不写主库派生事实） */
  timelineRebuildRunner: TimelineRebuildRunner
  /** P0 成本报表服务（只读聚合 novel_agent_logs + 度量表） */
  costReportService: CostReportService
  /** 观测聚合服务（overview/cache/agents/timeline 四视图，只读聚合 novel_agent_logs） */
  observabilityService: ObservabilityService
  /** P0 相邻章 shared 重复率分析（只读聚合） */
  sharedOverlapAnalyzer: SharedOverlapAnalyzer
}

/**
 * 初始化小说系统所有服务
 *
 * @param context PluginContext（提供 db / cwd / logger / createSession 等）
 */
export function createNovelServices(context: PluginContext): NovelServices {
  const { db, cwd, teamManager, subagentManager: agentManager, confirmationManager } = context

  // confirmationManager 现按 confirmation.request capability 条件注入。
  // novel 是 builtin（默认持有全部 capability），因此这里只可能因宿主装配错误而缺失，
  // 早失败比让下游服务在运行时拿到 undefined 更好诊断。
  if (!confirmationManager) {
    throw new Error('novel 插件需要 confirmation.request 能力（confirmationManager 未注入）')
  }


  // 1. 创建 NovelStore（依赖 db）
  const store = new NovelStore(db)
  const referenceAnalysisStore = new ReferenceAnalysisStore(db)
  const referenceAnalysis = new ReferenceAnalysisService(referenceAnalysisStore, store)

  // 2. 创建 NovelMemoryStore（依赖 db，长期记忆分层存储）
  const memoryStore = new NovelMemoryStore(db)

  // 2.5 把"实体章节投影变更"收口到事件账本。
  //     S4-1 对账实测：账本原本完全没有势力/地点的记录，角色/线索/冲突/伏笔也各有缺失，
  //     来源是手工编辑、Memory Agent 工具、矩阵拖拽这些不经过编排器的写入路径。
  //     观察者挂在 NovelStore 门面上，是覆盖所有路径的唯一收口点；记录器本身幂等。
  store.setChapterProjectionObserver(createChapterProjectionRecorder(memoryStore, {
    onError: (err, projectId, change) => {
      context.logger.warn(
        { err, projectId, entityType: change.entityType, entityId: change.entityId },
        '章节投影账本记录失败（实体写入已成功，可由对账脚本补齐）',
      )
    },
  }))

  // 2.6 删除实体时同步清理账本里的多态引用。
  //     story_event_entities.entity_id / memory_events.subject_id 没有外键，
  //     不清理会留下悬空引用（S4-1 在真实库里实测到 11 条）。
  store.setEntityDeletedObserver((projectId, event) => {
    try {
      memoryStore.deleteLedgerReferencesByEntity(projectId, event.entityId)
      memoryStore.pruneEmptyStoryEvents(projectId)
    } catch (err) {
      context.logger.warn(
        { err, projectId, entityType: event.entityType, entityId: event.entityId },
        '删除实体后清理账本引用失败（可由 cleanup 脚本补做）',
      )
    }
  })

  // 3. 创建 PromptManager（依赖 db + cwd）
  const promptManager = new PromptManager(db, cwd)

  // 3.5 创建统一关系图查询层 + 跨章节一致性审计器
  //     提升到 services 层供 novel-routes 与 NovelPromptBuilder 共享同一实例：
  //     - RelationshipGraph：让 prompt 注入派生边（冲突参与/势力敌对/盟友/地点归属等）
  //     - ConsistencyAuditor：让 prompt 注入跨章一致性报告（孤儿实体/悬挂钩子/时间线）
  //     C3 prompt 增强核心依赖
  const relationshipGraph = new RelationshipGraph(store, memoryStore)
  const consistencyAuditor = new ConsistencyAuditor(store)

  // 4. 创建 NovelPromptBuilder（依赖 PromptManager + NovelStore + NovelMemoryStore）
  //    注入 memoryStore 让 buildChapterContextShared 在 SEMI 层注入"账本承接"，
  //    Director/Writer/Reviewer 因此能感知章前状态与本章计划。
  //    注入 relationshipGraph 让 formatEdges 拿到派生边（冲突→角色、势力→盟友等 7 类）。
  //    consistencyAuditor 不再注入 prompt 层：它唯一的两个消费者（formatUrgentForeshadows /
  //    formatConsistencyAudit）从未被调用，已随死代码一并删除。审计结果仍由
  //    GET /consistency-report 路由直接对外提供。
  const promptBuilder = new NovelPromptBuilder(promptManager, store, memoryStore, relationshipGraph)
  // P3 T03-6：identity-contract 守卫——所有 buildAgentIdentity 消费方统一覆盖
  promptBuilder.setIdentityLogger(context.logger)

  // 5. 创建 NovelEngine（依赖 NovelStore）
  //    原 NovelSessionFactory 已删除（薄封装空壳）：
  //    - promptBuilder 直接由外部共享实例使用（避免 factory 内部 new 出"残缺版"实例）
  //    - novelTools 通过 createNovelTools(store) 创建后直接注入 orchestrator
  const engine = new NovelEngine(store)

  // 6. 创建 Pi Session 工具集（依赖 NovelStore + NovelPromptBuilder）
  //    提前到 orchestrator 之前：orchestrator 需要它替代原 sessionFactory.getNovelTools()
  //    注入 promptBuilder 作为 boundaryProvider：让 novel_query_state / novel_ask_story
  //    工具与 prompt-builder 注入路径共用同一章前语义（P0 双事实源修复）
  const tools = createNovelTools(store, memoryStore, promptBuilder)

  // 7. 创建 NovelOrchestrator（依赖 NovelStore + NovelMemoryStore + novelTools + NovelPromptBuilder + NovelEngine + PluginContext + NovelMemoryGenerator）
  //    PluginContext.createSession 用于 runAgent 调用 LLM
  //    novelTools 替代原 sessionFactory.getNovelTools()
  //    温度合并通过 NOVEL_AGENT_CONFIGS 工具函数 + context.subagentManager 直接完成（删除原 NovelAgentConfigStore 空壳）
  //    memoryGenerator 用于 Memory 阶段的结构化 LLM 调用（替代原工具循环模式）
  // 7.5 先创建 NovelMemoryGenerator（orchestrator 依赖它）
  //     memoryStore 注入用于账本承接：Memory 需要看到「章前状态 + 本章计划变更」
  //     才能做差分，而不是每章从零重新判断实体现在算什么状态。
  const memoryGenerator = new NovelMemoryGenerator(promptBuilder, promptManager, context, store, engine, memoryStore)
  // 插话状态回调需要在 orchestrator 构造时即可写入章节聊天历史。
  const chapterChatStore = new ChapterChatStore(db)
  // 第 8 参 hooks：插话 injected/dropped 生命周期回调，经注册表按 messageId/flowKey
  // 路由到对应运行中 flow 的 SSE 通道（见 utils/chapter-task-registry.ts）。
  const orchestrator = new NovelOrchestrator(
    store,
    memoryStore,
    tools,
    promptBuilder,
    engine,
    context,
    memoryGenerator,
    createInterjectDispatchHooks((messageId, status, agentType) => {
      chapterChatStore.updateInterjectStatus(messageId, status, agentType)
    }),
  )

  // 7.6 创建群聊共创模式组件（依赖 store/memoryStore/promptBuilder/engine/context + memoryGenerator）
  //     discussionSettingsStore 读取持久化的 moderatorModel 传入 runner 构造函数
  const discussionSettingsStore = new DiscussionSettingsStore(db)
  const discussionRunStore = new DiscussionRunStore(db)
  const workflowRunStore = new WorkflowRunStore(db)
  const discussionRunner = new NovelDiscussionRunner(
    store, memoryStore, promptBuilder, engine, context,
    discussionSettingsStore.get().moderatorModel,
    memoryGenerator,
    discussionSettingsStore,
  )

  // 7.7 创建章节聊天组件（按章节持久化用户输入 + 自由聊天）
  //     chapterChatStore 依赖 db；chapterChatRunner 依赖 store/promptBuilder/engine/context/chatStore
  const chapterChatRunner = new ChapterChatRunner(
    store, promptBuilder, engine, context, chapterChatStore,
    discussionSettingsStore.get().moderatorModel,
  )

  // 7.8 章纲生成只读取领域上下文并返回草稿，不直接写章节或派生状态。
  const outlineGenerator = new ChapterOutlineGenerator(store, memoryStore, promptManager, context)

  // 7.9 卷级节拍表生成（Beat Planner）：消费卷纲与故事状态，产出按卷替换的节拍行。
  const beatPlanner = new VolumeBeatPlanner(store, promptManager, context)

  // 8. 创建 NovelCharacterGenerator（依赖 NovelPromptBuilder + PromptManager + PluginContext）
  //    PluginContext.createSession 用于 generate 调用 LLM
  const characterGenerator = new NovelCharacterGenerator(promptBuilder, promptManager, context)

  // 9. 创建 NovelEntityGenerator（通用实体生成器，character 分支委托给 characterGenerator）
  //    依赖 NovelStore 用于 generateAndArrange 落库（角色/冲突/伏笔 + 角色历史）
  const entityGenerator = new NovelEntityGenerator(promptBuilder, promptManager, context, characterGenerator, store, memoryStore)

  // 9.5 创建 NovelSimilarityScanner（LLM 驱动的相似实体扫描器）
  //     与 store.deduplicateEntities 互补：deduplicateEntities 处理"完全相同"的重复，
  //     similarityScanner 处理"语义相似但表述不同"的重复，支持字段级合并方案
  const similarityScanner = new NovelSimilarityScanner(promptBuilder, promptManager, context, store)

  // 9.6 P0 成本测量只读服务（报表 + 观测聚合 + 相邻章重复率）
  const costReportService = new CostReportService(db)
  const observabilityService = new ObservabilityService(db)
  const sharedOverlapAnalyzer = new SharedOverlapAnalyzer(db)

  // 9.7 中间章隔离顺序重建执行器：依赖 context.createSession 做逐章隔离分析，
  //     分析产物只落 rebuild steps/checkpoints，不写主库派生事实（方案 §6）。
  const timelineRebuildRunner = new TimelineRebuildRunner(context, store, memoryStore)

  // 9.8 P4-P7：远端分析 run 执行器、参考档案、模板与同场景验证。
  //     worker 依赖阶段 1 服务读取 sections/本地报告；事件表只存阶段与摘要。
  const referenceAnalysisRuns = new ReferenceAnalysisRunStore(db)
  const referenceProfiles = new ReferenceProfileStore(db)
  const referenceAnalysisWorker = new ReferenceAnalysisRunWorker(
    context, referenceAnalysisRuns, referenceProfiles, referenceAnalysis,
  )
  const referenceTemplates = new ReferenceTemplateStore(db, referenceProfiles)
  const referenceValidationRuns = new ReferenceValidationRunStore(db)
  const referenceValidationWorker = new ReferenceValidationRunWorker(
    context, referenceValidationRuns, referenceTemplates, referenceProfiles, referenceAnalysis,
  )

  return { context, store, memoryStore, promptManager, promptBuilder, relationshipGraph, consistencyAuditor, engine, orchestrator, characterGenerator, entityGenerator, similarityScanner, tools, teamManager, agentManager, confirmationManager, discussionRunner, discussionSettingsStore, discussionRunStore, workflowRunStore, chapterChatStore, chapterChatRunner, outlineGenerator, beatPlanner, referenceAnalysis, referenceAnalysisRuns, referenceAnalysisWorker, referenceProfiles, referenceTemplates, referenceValidationRuns, referenceValidationWorker, timelineRebuildRunner, costReportService, observabilityService, sharedOverlapAnalyzer }
}
