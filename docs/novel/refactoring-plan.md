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

### Phase B: Durable run lifecycle and entry points — completed

1. Keep the committed `CreationRunLifecycle` as the runtime lifecycle base.
2. Migrate create-flow checkpoint feedback, cancellation, recovery, and status projection to persisted run commands/events. The initial create-flow path is wired; workflow resume now creates a new durable run from the saved `writing`/`reviewing`/`memory` boundary and records phase, checkpoint, and terminal transitions.
3. Migrate discussion, arrange, and reverse-arrange in separate slices; do not maintain two authoritative state machines for one run. All three entry points now use `CreationRunLifecycle` with the background event-tail protocol.
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

## Completed slice: Phase A transaction consistency

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

## Completed slice: Phase B workflow resume lifecycle

### Files and responsibilities

- `apps/agent-server/src/plugins/novel-plugin/routes/creation-flow-routes.ts`: create a new durable lifecycle run for each workflow resume and project its phases, checkpoints, and terminal result.
- `apps/agent-server/src/plugins/novel-plugin/__tests__/creation-flow-routes.test.ts`: verify resume starts from the saved boundary and writes lifecycle transitions.
- `apps/agent-server/src/plugins/novel-plugin/core/runtime/creation-run-lifecycle.ts`: shared state transition rules and durable event projection; unchanged by this slice.

### Acceptance criteria

- Resuming a `writing`, `reviewing`, or `memory` workflow snapshot creates a new lifecycle run with the matching stage (`memory` maps to `finalizing`).
- Resume progress events, checkpoints, success, failure, and cancellation use the new run id without changing the original snapshot input.
- A lifecycle admission conflict returns `409` before the resume task or event stream starts.
- Existing workflow event tail and snapshot recovery behavior remains unchanged.

## Completed slice: Phase B AI arrange lifecycle

### Files and responsibilities

- `apps/agent-server/src/plugins/novel-plugin/routes/creation-flow-routes.ts`: create and update the durable arrange run around the existing SSE and confirmation flow.
- `apps/agent-server/src/plugins/novel-plugin/core/runtime/creation-run-state.ts`: allow `revising -> arranging` when an arrange review requests another generation.
- `apps/agent-server/src/plugins/novel-plugin/__tests__/creation-flow-routes.test.ts`: verify arrange start, phase, checkpoint decision, and terminal projection.

### Acceptance criteria

- AI arrange creates a durable run in `arranging` before model work starts.
- The `arrange_review` checkpoint is persisted and its `approve`, `revise`, and `reject` decisions resolve the same run.
- The run reaches `completed`, `cancelled`, or `failed` when the existing arrange task reaches its terminal path.
- The existing SSE contract, draft rollback, and confirmation behavior remain unchanged.

### Verification commands

Run from the repository root:

```powershell
pnpm --filter agent-server test src/plugins/novel-plugin/__tests__/chapter-projection-recorder.test.ts src/plugins/novel-plugin/__tests__/ledger-cleanup.test.ts src/plugins/novel-plugin/__tests__/projection-read-switch.test.ts src/plugins/novel-plugin/__tests__/novel-entity-appearance.test.ts src/plugins/novel-plugin/__tests__/novel-entity-generator-arrange-draft.test.ts src/plugins/novel-plugin/__tests__/novel-entity-generator-arrange-reuse.test.ts src/plugins/novel-plugin/__tests__/chapter-finalizer.test.ts
pnpm --filter agent-server build
git diff --check
```

## Completed slice: Phase B discussion lifecycle

### Files and responsibilities

- `apps/agent-server/src/plugins/novel-plugin/routes/creation-flow-routes.ts`: start, resume, checkpoint, cancel, and terminal projection for background discussion runs.
- `apps/agent-server/src/plugins/novel-plugin/utils/checkpoint-controller.ts`: bind generated checkpoint ids and the durable discussion run id before emitting the checkpoint event.
- `apps/agent-server/src/plugins/novel-plugin/__tests__/creation-flow-routes.test.ts`: verify discussion start, phase projection, checkpoint decision resolution, and terminal state.

### Acceptance criteria

- A new discussion run is admitted into `CreationRunLifecycle` before the background task starts, and returns `202` with its event-stream run id.
- Progress phases map to durable stages; discussion checkpoints persist `waiting_input` with the exact checkpoint id and resolve on approve/revise/reject.
- Explicit cancellation rejects a pending confirmation, wakes the runner, and projects a cancelled terminal state; task registries are cleaned afterward.
- Discussion resume creates a new durable run from the saved resumable phase and preserves the original run as the recovery input.
- Existing discussion event tail, checkpoint feedback, history persistence, and resume behavior remain compatible.

### Verification commands

Run from the repository root:

```powershell
pnpm --filter agent-server test src/plugins/novel-plugin/__tests__/creation-flow-routes.test.ts src/plugins/novel-plugin/__tests__/novel-discussion-runner.test.ts src/plugins/novel-plugin/__tests__/team-discussion-engine.test.ts
pnpm --filter agent-server build
git diff --check
```

## Completed slice: Phase B reverse-arrange lifecycle

### Files and responsibilities

- `apps/agent-server/src/plugins/novel-plugin/routes/creation-flow-routes.ts`: admit reverse-arrange as a durable `mode: reverse` run, project arranging/terminal state, expose active-run lookup, and use the shared workflow event tail.
- `apps/desktop/src/renderer/src/hooks/use-novel-creation-flow.ts`: consume reverse-arrange through the same background run transport as create-flow and discussion.
- `apps/desktop/src/renderer/src/hooks/__tests__/use-novel-creation-flow.test.ts`: verify model forwarding and background acceptance.
- `apps/agent-server/src/plugins/novel-plugin/__tests__/creation-flow-routes.test.ts`: verify admission, cancellation, active-run lookup, and terminal projection.

### Acceptance criteria

- POST reverse-arrange returns `202` with `runId` and `eventsPath`; progress and terminal events are persisted in the workflow event stream.
- `CreationRunLifecycle` owns reverse-arrange state (`arranging` → `completed`/`cancelled`/`failed`); explicit cancellation waits for task cleanup.
- The desktop client uses one background run/tail implementation and reconnects through `active-reverse-arrange-run`.
- The old POST SSE compatibility transport and duplicate client parser are removed.

### Verification commands

```powershell
pnpm --filter agent-server test src/plugins/novel-plugin/__tests__/creation-flow-routes.test.ts
pnpm --filter desktop test src/renderer/src/hooks/__tests__/use-novel-creation-flow.test.ts
pnpm --filter desktop typecheck
pnpm --filter agent-server build
git diff --check
```

## Completed slice: Phase C route storage boundary

### Files and responsibilities

- `apps/agent-server/src/plugins/novel-plugin/core/analysis/reference-template-binding-store.ts`: typed CRUD/resolve boundary for project reference-template bindings, including JSON mapping, version ownership, optimistic locking, and chapter filtering.
- `apps/agent-server/src/plugins/novel-plugin/novel-services.ts`: construct and expose the binding store.
- `apps/agent-server/src/plugins/novel-plugin/routes/reference-template-routes.ts`: use the binding store for all P8 binding endpoints; no direct SQLite access remains in routes.
- `apps/agent-server/src/plugins/novel-plugin/__tests__/reference-template-binding-store.test.ts`: store behavior and persistence invariants.
- `apps/agent-server/src/plugins/novel-plugin/__tests__/reference-template.test.ts`: P8 HTTP contract coverage.
- `apps/agent-server/src/plugins/novel-plugin/__tests__/route-storage-boundary.test.ts`: architecture guard against SQL in route modules.

### Acceptance criteria

- Binding list/upsert/delete/resolve preserve the existing URL and response contract.
- Stale `lockVersion` returns `409`; omitted update fields preserve their stored values; a version from another template is rejected.
- Malformed JSON falls back to typed empty values rather than returning a 500 from a route.
- All novel route modules remain behind store/service boundaries, enforced by an automated architecture test.

### Current task: Phase C typed route contracts

Extend `RouteDefinition` and the plugin loader with typed params/query/body/response schema metadata, then migrate one route family under contract tests. Keep this separate from repository extraction so route schema changes can be rolled out without mixing storage behavior changes.

## Progress log

- 2026-10-14: Phase B foundation committed as `49e8098` on `codex/novel-runtime-refactor`.
- 2026-10-14: Phase A regression test added first; verified RED because projection recorder swallowed the SQLite ledger error.
- 2026-10-14: Phase A implemented and verified: 81 tests across 7 files pass, agent-server TypeScript build passes, and `git diff --check` is clean.
- 2026-10-14: Overall refactor sequence and current transaction slice documented here; Phase B migration beyond its committed lifecycle foundation remained next.
- 2026-10-15: AI arrange projection commit is now atomic across the Story Ledger and appearance writes; failure performs strict compensating rollback and does not emit an arrange-completed event.
- 2026-10-15: Workflow resume is wired to `CreationRunLifecycle`; its phase/checkpoint/terminal transitions use a new durable run id while retaining the original workflow snapshot as input.
- 2026-10-15: AI arrange is wired to `CreationRunLifecycle`; `arranging` and `arrange_review` now have durable state and terminal projection.
- 2026-10-15: Discussion start and resume are wired to `CreationRunLifecycle`; phases, checkpoints, explicit cancellation, and terminal states now use the durable run id while the event tail remains the transport contract.
- 2026-10-15: Reverse-arrange is wired to the durable background run protocol; the old POST SSE compatibility path and duplicate client parser were removed.
- 2026-10-15: Phase C started with the project reference-template binding boundary; typed storage, P8 contracts, stale-lock handling, and the route SQL architecture guard are now in place.
- 2026-10-15: Phase C typed route contracts now carry Fastify schema metadata through the plugin loader. The four P8 binding routes declare params, query, body, and response contracts, with TypeBox constraints aligned to the existing Zod validation; contract tests cover request validation and response serialization.
