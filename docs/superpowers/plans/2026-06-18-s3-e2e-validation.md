# S3 E2E Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify and harden the S3 desktop streaming chat path: send message, receive streamed text, render tool cards, and abort an active run.

**Architecture:** Keep the runtime architecture unchanged: Desktop posts to `/ag-ui/agent/default/run`, parses AG-UI SSE events, and reduces them into chat UI state. Add focused Vitest/jsdom coverage around `ChatWorkspace` so S3 acceptance criteria are executable without a live LLM.

**Tech Stack:** TypeScript, React 19, Vitest, jsdom, AG-UI event types, existing Electron desktop renderer code.

---

### Task 1: Chat Workspace Streaming Acceptance Tests

**Files:**

- Modify: `apps/desktop/src/renderer/src/App.test.tsx`

- [x] **Step 1: Write failing tests for S3 acceptance behavior**

Add tests that mock `fetch` with a health response and an AG-UI SSE `ReadableStream`. The tests must verify:

- a user can type and send a message;
- streamed assistant text renders in the message list;
- a tool execution event renders a tool card;
- the abort button aborts the active request.

- [x] **Step 2: Run the desktop test to verify red**

Run: `pnpm --filter desktop test -- App.test.tsx`

Expected: at least one new test fails because current implementation does not satisfy all S3 assertions.

- [x] **Step 3: Implement the minimal production fixes**

Only change runtime code if the tests expose a real S3 gap. Keep the fix scoped to existing chat components/hooks.

Result: no production runtime changes were required; the failures were test isolation/assertion issues, and the existing S3 runtime path satisfied the automated acceptance checks.

- [x] **Step 4: Run the desktop test to verify green**

Run: `pnpm --filter desktop test -- App.test.tsx`

Expected: all App tests pass.

### Task 2: S3 Verification Sweep

**Files:**

- No required production files unless Task 1 exposes failures.

- [x] **Step 1: Run desktop typecheck**

Run: `pnpm --filter desktop typecheck`

Expected: `typecheck:node` and `typecheck:web` both exit 0.

- [x] **Step 2: Run backend S3 contract tests**

Run: `pnpm --filter agent-server test -- s3-1-agui-contract.test.ts`

Expected: S3 AG-UI contract tests pass.

- [x] **Step 3: Run package protocol/shared tests**

Run: `pnpm test:packages`

Expected: shared and protocol tests pass.

- [x] **Step 4: Record residual manual check**

If Electron cannot be launched safely in this environment, report that live desktop manual validation remains and provide the exact commands from the roadmap.

Manual check commands:

```bash
pnpm --filter agent-server dev
cd apps/desktop && pnpm dev
```
