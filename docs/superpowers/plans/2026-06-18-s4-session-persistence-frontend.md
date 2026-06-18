# S4 Session Persistence Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the minimum F3 desktop session persistence needed for restart-safe conversations: restored sessions, restored messages, session search, session switching, and per-session draft persistence.

**Architecture:** Keep the implementation local to `ChatWorkspace` for this slice, using small localStorage helpers and existing component state. `InputArea` becomes optionally controlled so `ChatWorkspace` can persist drafts without changing the component's uncontrolled default behavior.

**Tech Stack:** React 19, TypeScript, Vitest, jsdom, localStorage, existing Tailwind/shadcn UI.

---

### Task 1: Persisted Session Restore and Search

**Files:**

- Modify: `apps/desktop/src/renderer/src/App.test.tsx`
- Modify: `apps/desktop/src/renderer/src/components/chat/chat-workspace.tsx`

- [x] **Step 1: Write failing restore/search test**

Add a test that seeds `pi-agent.sessions`, `pi-agent.currentSessionId`, and `pi-agent.sessionMessages`, then verifies the restored session and message render on app start and search filters the session list.

- [x] **Step 2: Run red test**

Run: `pnpm --filter desktop test -- App.test.tsx`

Expected: FAIL because `ChatWorkspace` uses hard-coded sessions and in-memory messages.

- [x] **Step 3: Implement local session persistence**

Load and save:

- `pi-agent.sessions`
- `pi-agent.currentSessionId`
- `pi-agent.sessionMessages`

Filter the sidebar from controlled search input and switch `activeThreadId` when a session button is clicked.

- [x] **Step 4: Run green test**

Run: `pnpm --filter desktop test -- App.test.tsx`

Expected: PASS.

### Task 2: Per-Session Draft Persistence

**Files:**

- Modify: `apps/desktop/src/renderer/src/App.test.tsx`
- Modify: `apps/desktop/src/renderer/src/components/chat/input-area.tsx`
- Modify: `apps/desktop/src/renderer/src/components/chat/chat-workspace.tsx`

- [x] **Step 1: Write failing draft remount test**

Add a test that types an unsent draft, unmounts, remounts, and verifies the textarea value is restored.

- [x] **Step 2: Run red test**

Run: `pnpm --filter desktop test -- App.test.tsx`

Expected: FAIL because `InputArea` owns its state internally only.

- [x] **Step 3: Implement controlled draft support**

Add optional `value` and `onChange` props to `InputArea`; persist drafts in `ChatWorkspace` under `pi-agent.drafts`.

- [x] **Step 4: Run green test and typecheck**

Run:

```bash
pnpm --filter desktop test -- App.test.tsx
pnpm --filter desktop typecheck
```

Expected: both exit 0.
