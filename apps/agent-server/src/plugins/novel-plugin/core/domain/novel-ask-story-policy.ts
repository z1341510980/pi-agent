/**
 * novel_ask_story tool exposure policy.
 *
 * The static agent configuration remains the compatibility baseline. This module
 * derives a per-run tool list so concurrent chapter flows never mutate it.
 */

import type { NovelAgentType } from './novel-agents.js'
import type { NovelAskStoryPolicy } from '../types.js'

export const NOVEL_ASK_STORY_POLICY_ENV = 'PI_NOVEL_ASK_STORY_POLICY'

export type { NovelAskStoryPolicy } from '../types.js'

const KNOWN_POLICIES: ReadonlySet<string> = new Set<NovelAskStoryPolicy>([
  'legacy',
  'directorReviewerOff',
  'allOffWithReferences',
])

/**
 * Resolve the process-level development policy. Unknown values preserve the
 * conservative legacy behavior rather than silently restricting an agent.
 */
export function getNovelAskStoryPolicy(
  projectValue?: NovelAskStoryPolicy | null,
  rawValue: string | undefined = process.env[NOVEL_ASK_STORY_POLICY_ENV],
  nodeEnv: string | undefined = process.env.NODE_ENV,
): NovelAskStoryPolicy {
  if (projectValue && KNOWN_POLICIES.has(projectValue)) return projectValue
  if (nodeEnv !== 'development' && nodeEnv !== 'test') return 'legacy'
  const normalized = rawValue?.trim() ?? ''
  if (KNOWN_POLICIES.has(normalized)) return normalized as NovelAskStoryPolicy
  return 'legacy'
}

/**
 * Whether an agent may receive novel_ask_story for this single chapter run.
 *
 * allOffWithReferences is only applied when the caller confirms that deterministic
 * fact-pack injection is active for this run.
 */
export function isNovelAskStoryEnabled(
  policy: NovelAskStoryPolicy,
  agentType: NovelAgentType,
  factPackPathActive = false,
): boolean {
  if (policy === 'legacy') return true
  if (policy === 'allOffWithReferences') return !factPackPathActive
  return agentType !== 'director' && agentType !== 'reviewer'
}

/**
 * Derive an immutable local whitelist from an agent's static default tools.
 * The source array is never mutated and may safely be shared across requests.
 */
export function resolveNovelAgentToolNames(
  agentType: NovelAgentType,
  staticToolNames: readonly string[],
  policy: NovelAskStoryPolicy,
  factPackPathActive = false,
): string[] {
  if (isNovelAskStoryEnabled(policy, agentType, factPackPathActive)) return [...staticToolNames]
  return staticToolNames.filter((toolName) => toolName !== 'novel_ask_story')
}
