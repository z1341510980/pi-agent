# S5 Compaction Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a minimal user-visible S5/P7-F4 compaction path: the backend compact operation is contract-tested and the desktop context panel can trigger manual compaction with a status banner.

**Architecture:** Keep compaction execution behind `PiAgUiAgent.compactThread()` and the existing `/ag-ui/agent/:agentId/compact` route. Add a small desktop API helper and local UI state in `ChatWorkspace`; do not introduce a global store or full memory system in this slice.

**Tech Stack:** TypeScript, Fastify, Pi SDK adapter, React 19, Vitest, jsdom, TanStack Query existing setup.

---

### Task 1: Backend Compact Contract

**Files:**
- Modify: `apps/agent-server/src/__tests__/s3-1-agui-contract.test.ts`

- [x] **Step 1: Write the failing compact contract test**

Add a test under the existing `S4 Session navigation 契约` describe block:

```typescript
it('TC-32: compact 通过 PiAgUiAgent 封装并更新访问时间', async () => {
  const { session } = createMockSession()
  const { store, agent } = createAgentWithMockSession(session)
  const threadSession = await store.getOrCreate('thread-1')
  const before = threadSession.lastAccessedAt

  const result = await agent.compactThread('thread-1', '保留关键决策')

  expect(session.compact).toHaveBeenCalledWith('保留关键决策')
  expect(result).toEqual({})
  expect(threadSession.lastAccessedAt).toBeGreaterThanOrEqual(before)
})
```

- [x] **Step 2: Run the backend contract test**

Run:

```bash
pnpm --filter agent-server test -- s3-1-agui-contract.test.ts
```

Expected: PASS if the existing adapter already satisfies the contract. If it fails, fix only `PiAgUiAgent.compactThread()`.

### Task 2: Desktop Compact API Helper

**Files:**
- Modify: `apps/desktop/src/renderer/src/api/http-client.ts`
- Modify: `apps/desktop/src/renderer/src/App.test.tsx`

- [x] **Step 1: Add failing desktop compact UI test**

Add a test to `App.test.tsx` that renders the app, clicks the manual compact button, and verifies:
- `fetch` posts to `/ag-ui/agent/default/compact`;
- the request body contains the active `threadId`;
- a success banner is rendered.

- [x] **Step 2: Run the desktop test for red**

Run:

```bash
pnpm --filter desktop test -- App.test.tsx
```

Expected: FAIL because no compact button or POST helper exists.

- [x] **Step 3: Implement `postApi`**

Add this helper to `http-client.ts`:

```typescript
export async function postApi<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(`${browserConfig.apiBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const body = (await response.json()) as ApiResponse<T>

  if (!body.ok) {
    throw new ApiClientError(
      body.error.message,
      body.error.code,
      body.meta.traceId,
      body.error.details
    )
  }

  return body.data
}
```

### Task 3: Desktop Manual Compact UI

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/chat/chat-workspace.tsx`

- [x] **Step 1: Implement compact status state and handler**

Add a small state machine inside `ChatWorkspace`:

```typescript
type CompactStatus =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'success'; message: string }
  | { state: 'error'; message: string }
```

Use `postApi('/ag-ui/agent/default/compact', { threadId: activeThreadId })` from the manual compact handler.

- [x] **Step 2: Render context panel banner and button**

In the context panel, add a card titled `上下文压缩` with:
- a status line for idle/running/success/error;
- a button named `手动压缩上下文`;
- disabled state when offline or already running.

- [x] **Step 3: Run desktop green test and typecheck**

Run:

```bash
pnpm --filter desktop test -- App.test.tsx
pnpm --filter desktop typecheck
```

Expected: both pass.

### Task 4: Verification Sweep

**Files:**
- No additional files.

- [x] **Step 1: Run backend targeted test**

Run:

```bash
pnpm --filter agent-server test -- s3-1-agui-contract.test.ts
```

Expected: PASS.

- [x] **Step 2: Run package tests**

Run:

```bash
pnpm test:packages
```

Expected: PASS.

- [x] **Step 3: Run full typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.
