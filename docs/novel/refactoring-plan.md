# Novel Module Refactoring Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Incrementally improve the novel module's data correctness, create-flow behavior, persistence boundaries, and changeability while keeping each slice independently testable.

**Architecture:** Treat persistent domain state as authoritative. Long-running work is represented by durable runs and append-only events; synchronous writes to the same SQLite database share one transaction. Split orchestration and UI state by responsibility only after contracts and regression tests are in place.

**Tech Stack:** TypeScript, Fastify, React, better-sqlite3, Drizzle, TypeBox/Zod, Vitest.

---

## Source material and verified findings

This plan supersedes neither the plugin-host plan nor the older module audit. Use them for their original scope:

- `docs/novel-module-analysis.md` is the structural audit and behavior map. Its file sizes and line counts are a historical snapshot, not current measurements.
- `docs/novel-pluginization-plan.md` remains the plan for plugin boundaries, lifecycle, and desktop Slot integration; that document explicitly excludes module-monolith decomposition.
- `docs/execution-plan.md` remains the Pi SDK and plugin-host execution baseline.

The following findings were checked against the current implementation before this plan was written:

1. `NovelOrchestrator`, `creation-flow-routes`, `prompt-builder`, desktop `use-novel-creation-flow`, and `novel-client` each combine multiple responsibilities. The create-flow behavior therefore spans route, runner, persistence, event delivery, and UI state.
2. Automated revision entry points are distributed across orchestration and review decisions; a single persisted revision budget and quality gate are needed to prevent unbounded or repeated whole-flow retries.
3. Word limits appear in prompts and quality checks, but there is no single persisted count-and-budget contract enforced at finalization.
4. Create-flow run lifecycle persistence has begun. Commit `49e8098` adds the durable creation run lifecycle and is the base for subsequent migration; it does not make entity projections and Story Ledger writes atomic.
5. Projection recording and deletion cleanup currently catch observer errors. A same-database synchronous transaction can make entity, appearance, and ledger changes atomic; an outbox is not required for these writes. External side effects will need a separate delivery design if added.
6. `ChapterFinalizer.finalize()` already commits chapter body, version chain, memory changes, events, chapter dimensions, and snapshot under one transaction. This plan does not duplicate that work.

## Target outcomes

### Runtime and flow control

- One durable run id and state machine identify a create-flow execution across HTTP disconnects and process restarts.
- All transitions and events carry a monotonically increasing sequence, phase, idempotency key, timestamp, and a bounded error summary.
- One `RevisionController` owns automatic revision limits. A quality failure produces a targeted revision input; it cannot recursively restart the whole flow. Exhausting the limit pauses at a human checkpoint.
- Start, resume, cancel, refresh/reconnect, checkpoint feedback, and concurrent start behavior are contract-tested.

### Output and memory quality

- One Unicode-aware word-count implementation reports target, actual count, deviation, and counter version.
- A deterministic quality gate runs before finalization. It enforces the configured word budget and structured acceptance result; at most one automatic correction is allowed before human review.
- Memory acceptance includes concrete evidence from the chapter body, an irreversible change, and links to the corresponding run/event. Model output uses the repository's closure-captured submit-tool pattern from `AGENTS.md`.

### Data and module boundaries

- Entity projection, appearance, and Story Ledger writes are atomic when they happen synchronously in the same SQLite database.
- `NovelStore` remains a compatibility facade during migration; domain operations move behind typed storage/application boundaries in small slices.
- HTTP handlers validate typed params, query, body, and response contracts. Routes do not perform direct database access.
- Frontend transport, event reduction, command submission, and view selection have distinct responsibilities.
- Requirement-to-interface mapping lists each page independently, including displayed fields, user paths, external references, reusable APIs, and ambiguous requirements.

## Refactoring order

Each phase should produce a small verified slice. Do not combine broad file splitting with behavior changes in one patch.

### Phase A: Data correctness and consistency — completed

1. Make chapter projection and entity deletion observer failures propagate.
2. Add outer `NovelStore.withTransaction()` boundaries only to paths that write entities/appearances and then notify `ChapterProjectionObserver` or `EntityDeletedObserver`.
3. Cover `recordAppearancesIfEnabled`, frozen-span appearance diffs, conflict, foreshadow, clue, faction, location, item, narrative, and character-history writes.
4. Make `applyDanglingCleanup` plan and apply in one transaction so a failed multi-entity repair cannot partially commit.
5. Verify ledger-write rollback, ledger-cleanup rollback, matrix reconciliation, and existing finalizer behavior.
6. Keep the polymorphic reference model. Do not add foreign keys or a generic outbox in this slice. Retain reconciliation/backfill tools as drift detection and repair.

### Phase B: Durable run lifecycle and entry points — base implemented

1. Keep the committed `CreationRunLifecycle` as the runtime lifecycle base.
2. Migrate create-flow checkpoint feedback, cancellation, recovery, and status projection to persisted run commands/events.
3. Migrate discussion, arrange, and reverse-arrange in separate compatible slices; do not maintain two authoritative state machines for one run.
4. Reduce module-level registries to connection/transport bookkeeping only; persist business state and make stale run recovery deterministic.

### Phase C: Typed persistence and API boundaries

1. Inventory direct database access in routes and domain services; add architecture tests before migrating call sites.
2. Move one bounded operation family at a time behind repositories/application services, keeping `NovelStore` as an adapter while callers move.
3. Add request and response schemas for route params, query, and body. Preserve existing API behavior with contract tests before changing shapes.
4. Add pagination or field selection only where current usage and measurements show full-project loading is a bottleneck.

### Phase D: Create-flow orchestration and revision control

1. Freeze current create-flow behavior with provider-replay and API lifecycle tests.
2. Extract `DirectorPlanner`, `WriterRunner`, `QualityGate`, `RevisionController`, and `MemoryFinalizer` behind structured input/output types.
3. Make the revision controller the only automatic revision entry point, with persisted attempts, reasons, and checkpoint outcomes.
4. Preserve submit-tool structured output for beat plans, outlines, narrative tasks, and acceptance reports; do not make text JSON parsing the main protocol.

### Phase E: Frontend transport and interaction state

1. Add event reducer tests using persisted event sequence and reconnect cursors.
2. Split `use-novel-creation-flow` into transport, reducer, commands, and selectors while preserving the current component-facing contract.
3. Split `novel-client` by API domain after call sites are inventoried; keep shared schemas as the source of request/response types.
4. Replace ephemeral UI run assumptions with persisted run snapshots and explicit loading, paused, failed, and reconnect states.

### Phase F: Prompt and matrix hot paths

1. Measure prompt assembly queries and matrix render/update costs before changing structure.
2. Split prompt context querying, template selection, role instructions, and budget pruning behind tested interfaces.
3. Split matrix model/commands/selectors/rendering by domain behavior; do not split files only by line count.
4. Add query-count or render-work regression thresholds for identified hot paths.

### Phase G: Quality, observability, and architecture guardrails

1. Persist word target/actual/deviation and revision metrics per run.
2. Link accepted memory facts to run id, chapter revision, and body evidence.
3. Record cost, revision count, recovery result, terminal latency, and quality-gate failures in reportable dimensions.
4. Maintain a page-by-page interface matrix and check it against route schemas and source requirements.
5. Add architecture rules for typed route boundaries, approved storage access, and structured LLM submission.

## Current task: Phase A transaction slice

### Files and responsibilities

- `apps/agent-server/src/plugins/novel-plugin/core/chapters/chapter-projection-recorder.ts`: write append-only projection records and propagate failures.
- `apps/agent-server/src/plugins/novel-plugin/core/novel-store.ts`: establish transaction boundaries around the entity/appearance write plus observer notification.
- `apps/agent-server/src/plugins/novel-plugin/novel-services.ts`: log cleanup failure and rethrow so the store transaction can roll back.
- `apps/agent-server/src/plugins/novel-plugin/core/memory/ledger-cleanup.ts`: compute and apply the legacy dangling-reference repair in one transaction.
- `apps/agent-server/src/plugins/novel-plugin/__tests__/chapter-projection-recorder.test.ts`: projection ledger failure and reconciliation behavior.
- `apps/agent-server/src/plugins/novel-plugin/__tests__/ledger-cleanup.test.ts`: entity deletion and polymorphic reference cleanup behavior.

### Acceptance criteria

- If a projection ledger insert fails, entity rows, appearance rows, story events, and change records all remain unchanged.
- If deletion reference cleanup fails, the entity and its appearances remain present and existing ledger references remain unchanged.
- If a multi-entity legacy cleanup fails, its ledger references and story events remain unchanged.
- A failed observer never returns a successful entity mutation result.
- Normal create/update/delete behavior remains idempotent and matrix reconciliation reports no new drift.
- Chapter finalizer tests remain green; no second transaction or outbox layer is added to that path.

### Verification commands

Run from the repository root:

```powershell
pnpm --filter agent-server test src/plugins/novel-plugin/__tests__/chapter-projection-recorder.test.ts src/plugins/novel-plugin/__tests__/ledger-cleanup.test.ts src/plugins/novel-plugin/__tests__/projection-read-switch.test.ts src/plugins/novel-plugin/__tests__/novel-entity-appearance.test.ts src/plugins/novel-plugin/__tests__/novel-entity-generator-arrange-draft.test.ts src/plugins/novel-plugin/__tests__/novel-entity-generator-arrange-reuse.test.ts src/plugins/novel-plugin/__tests__/chapter-finalizer.test.ts
pnpm --filter agent-server build
git diff --check
```

## Progress log

- 2026-10-14: Phase B foundation committed as `49e8098` on `codex/novel-runtime-refactor`.
- 2026-10-14: Phase A regression test added first; verified RED because projection recorder swallowed the SQLite ledger error.
- 2026-10-14: Phase A implemented and verified: 81 tests across 7 files pass, agent-server TypeScript build passes, and `git diff --check` is clean.
- 2026-10-14: Overall refactor sequence and current transaction slice documented here; Phase B migration beyond its committed lifecycle foundation remains next.
