/**
 * 小说创作系统 REST API 路由聚合入口。
 *
 * 每个领域路由在 routes/ 下独立注册；此文件只负责组合模块并保留
 * 插件级上下文预览与共享服务注入，避免多个领域实现继续堆叠在一个文件。
 */

import type { RouteDefinition } from '../../core/plugin/plugin-types.js'
import type { NovelServices } from './novel-services.js'
import { createChapterRoutes } from './routes/chapter-routes.js'
import { createChapterOutlineRoutes } from './routes/chapter-outline-routes.js'
import { createBeatPlanRoutes } from './routes/beat-plan-routes.js'
import { createCharacterRoutes } from './routes/character-routes.js'
import { createEntityCandidateRoutes } from './routes/entity-candidate-routes.js'
import { createCreationFlowRoutes } from './routes/creation-flow-routes.js'
import { createStoryLedgerRoutes } from './routes/story-ledger-routes.js'
import { createNarrativeRevisionRoutes } from './routes/narrative-revision-routes.js'
import { createReferenceAnalysisRoutes } from './routes/reference-analysis-routes.js'
import { createReferenceRunRoutes } from './routes/reference-run-routes.js'
import { createReferenceTemplateRoutes } from './routes/reference-template-routes.js'
import { createContextPreviewRoutes } from './routes/context-preview-routes.js'
import { createProjectRoutes } from './routes/project-routes.js'
import { createVolumeRoutes } from './routes/volume-routes.js'
import { createPromptRoutes } from './routes/prompt-routes.js'
import { createNarrativeRoutes } from './routes/narrative-routes.js'
import { createObservabilityRoutes } from './routes/observability-routes.js'
import { createGraphRoutes } from './routes/graph-routes.js'
import { createMemoryRoutes } from './routes/memory-routes.js'
import { createEntityDeleteRoutes } from './routes/entity-delete-routes.js'
import { createCacheRoutes } from './routes/cache-routes.js'
import { createEntityMaintenanceRoutes } from './routes/entity-maintenance-routes.js'
import { createInterjectRoutes } from './routes/interject-routes.js'
import { createAgentConfigRoutes } from './routes/agent-config-routes.js'
import { createAgentLogRoutes } from './routes/agent-log-routes.js'
import { createMarkerRoutes } from './routes/marker-routes.js'
import { createChapterChatRoutes } from './routes/chapter-chat-routes.js'
import { createEntityPlotRoutes } from './routes/entity-plot-routes.js'
import { createWorldSettingRoutes } from './routes/world-setting-routes.js'
import { createWritingStyleRoutes } from './routes/writing-style-routes.js'
import { createWorldEntityRoutes } from './routes/world-entity-routes.js'
import { completeRouteContracts } from './routes/route-contracts.js'

export function createNovelRoutes(services: NovelServices): RouteDefinition[] {
  const { store, promptBuilder } = services
  const routes: RouteDefinition[] = [
    ...createProjectRoutes(services),
    ...createVolumeRoutes(services),
    ...createStoryLedgerRoutes(services),
    ...createNarrativeRevisionRoutes(services),
    ...createReferenceAnalysisRoutes(services),
    ...createReferenceRunRoutes(services),
    ...createReferenceTemplateRoutes(services),
    ...createPromptRoutes(services),
    ...createNarrativeRoutes(services),
    ...createObservabilityRoutes(services),
    ...createGraphRoutes(services),
    ...createMemoryRoutes(services),
    ...createEntityDeleteRoutes(services),
    ...createCacheRoutes(services),
    ...createEntityMaintenanceRoutes(services),
    ...createInterjectRoutes(services),
    ...createAgentConfigRoutes(services),
    ...createAgentLogRoutes(services),
    ...createMarkerRoutes(services),
    ...createChapterChatRoutes(services),
    ...createChapterRoutes(services),
    ...createChapterOutlineRoutes(services),
    ...createBeatPlanRoutes(services),
    ...createCharacterRoutes(services),
    ...createEntityCandidateRoutes(services),
    ...createEntityPlotRoutes(services),
    ...createWorldSettingRoutes(services),
    ...createWritingStyleRoutes(services),
    ...createWorldEntityRoutes(services),
  ]

  routes.push(...createContextPreviewRoutes(promptBuilder, store, services.engine))
  routes.push(...createCreationFlowRoutes(services))
  return completeRouteContracts(routes)
}
