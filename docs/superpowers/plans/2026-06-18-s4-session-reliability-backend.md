# S4 Session Reliability Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the S4 backend reliability slice needed before long-context features: AG-UI navigation encapsulation plus session health and orphan tool-result repair helpers.

**Architecture:** Keep all AG-UI session operations behind `PiAgUiAgent`; routes should call agent methods rather than reaching into `sessionStore` internals. Add a focused `core/session/session-health.ts` module with pure JSONL helpers so health checks and orphan repair can be tested without a live Pi SDK session.

**Tech Stack:** TypeScript, Fastify route tests, Vitest, Pi SDK session adapter layer.

---

### Task 1: Encapsulate Navigation Through PiAgUiAgent

**Files:**

- Modify: `apps/agent-server/src/core/agent/pi-agui-agent.ts`
- Modify: `apps/agent-server/src/routes/agui.route.ts`
- Modify: `apps/agent-server/src/__tests__/s3-1-agui-contract.test.ts`

- [x] **Step 1: Write failing navigation test**

Add a `PiAgUiAgent.navigateThread()` contract test that calls `session.navigateTree(targetId, { summarize, customInstructions })` and updates `lastAccessedAt`.

- [x] **Step 2: Run red test**

Run: `pnpm --filter agent-server test -- s3-1-agui-contract.test.ts`

Expected: FAIL because `navigateThread` does not exist yet.

- [x] **Step 3: Implement minimal navigation method and route wiring**

Add `navigateThread(threadId, targetId, options)` to `PiAgUiAgent`, then update `POST /ag-ui/agent/:agentId/navigate` to call it.

- [x] **Step 4: Run green test**

Run: `pnpm --filter agent-server test -- s3-1-agui-contract.test.ts`

Expected: PASS.

### Task 2: Session Health and Orphan Tool Result Repair

**Files:**

- Create: `apps/agent-server/src/core/session/session-health.ts`
- Create: `apps/agent-server/src/__tests__/session-health.test.ts`

- [x] **Step 1: Write failing health and repair tests**

Tests must verify:

- missing file evaluates as `{ exists: false, healthy: true }`;
- three recent assistant entries with `stopReason: "error"` are unhealthy;
- malformed JSONL is tolerated as healthy;
- orphan tool-result entries are removed when no matching assistant tool call exists;
- file repair rewrites the JSONL only when removals happen.

- [x] **Step 2: Run red test**

Run: `pnpm --filter agent-server test -- session-health.test.ts`

Expected: FAIL because the module does not exist yet.

- [x] **Step 3: Implement minimal pure helpers**

Implement `evaluateSessionHealth`, `repairOrphanToolResultEntries`, and `repairOrphanToolResultEntriesInFile`.

- [x] **Step 4: Run green test**

Run: `pnpm --filter agent-server test -- session-health.test.ts`

Expected: PASS.

### Task 3: Verification Sweep

**Files:**

- No additional files.

- [x] **Step 1: Run backend S3/S4 tests**

Run: `pnpm --filter agent-server test -- s3-1-agui-contract.test.ts session-health.test.ts`

Expected: both test files pass.

- [x] **Step 2: Run backend typecheck**

Run: `pnpm --filter agent-server exec tsc --noEmit`

Expected: exit 0.

- [x] **Step 3: Run existing package tests**

Run: `pnpm test:packages`

Expected: shared and protocol tests pass.
