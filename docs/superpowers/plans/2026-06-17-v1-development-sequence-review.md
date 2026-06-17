# v1.0 Development Sequence Review

**Goal:** Consolidate `ARCHITECTURE.md`, `FRONTEND_DEVELOPMENT.md`, and the P0-P4 SDK integration spec into a safer v1.0 execution order.

**Current Baseline:** P0-P4 backend SDK integration is present in code and covered by passing unit tests. The frontend is still a health-check shell plus `CopilotSidebar`, so the self-built chat workspace has not started.

---

## Verification Snapshot

Commands run on 2026-06-17:

| Command                                        | Result | Notes                                                                                              |
| ---------------------------------------------- | -----: | -------------------------------------------------------------------------------------------------- |
| `pnpm --filter agent-server test`              |   Pass | 35 tests passed                                                                                    |
| `pnpm --filter @repo/protocol test`            |   Pass | 16 tests passed                                                                                    |
| `pnpm --filter @repo/shared test`              |   Pass | 25 tests passed                                                                                    |
| `pnpm --filter agent-server exec tsc --noEmit` |   Pass | Direct command works                                                                               |
| `pnpm --filter desktop typecheck`              |   Pass | npm config warnings only                                                                           |
| `pnpm --filter @repo/config exec tsc --noEmit` |   Pass | Direct command works                                                                               |
| `pnpm typecheck`                               |   Fail | Root script calls `pnpm --filter agent-server tsc --noEmit`; pnpm treats `tsc` as a package script |

Immediate verification debt:

1. Fix the root `typecheck:server` script to use `pnpm --filter agent-server exec tsc --noEmit`.
2. Move `pnpm.onlyBuiltDependencies` from `apps/desktop/package.json` to the workspace root, or accept the recurring pnpm warning.
3. Add root-level test aggregation scripts so the documented verification target is one command.

---

## Plan Review Findings

### Finding 1: P10 WebSocket Is Scheduled Too Late

The documents map tool confirmation to `P5 + P10`, but P10 is currently placed after P7-P9 in the RC sprint. If P5 implements Gate confirmation without a real-time channel, either the backend blocks without UI support or the frontend has to fake confirmation through polling.

Adjustment:

- Split WebSocket into `P10a` and `P10b`.
- `P10a Minimal Confirmation Channel` must land with P5.
- `P10b Notifications / DevLog / usage updates` can remain later.

### Finding 2: F8 Settings Must Be Split

Provider and API Key setup is listed in F8, but the user cannot reliably exercise F1 without model configuration. The current renderer still exposes CopilotKit runtime status rather than the intended provider flow.

Adjustment:

- Split F8 into `F8a Provider/API Key bootstrap` and `F8b Full Settings`.
- `F8a` should run immediately after F0 or in parallel with F1.
- `F8b` can stay near RC.

### Finding 3: Frontend Needs Earlier End-to-End Feedback

Backend P5-P9 can continue for weeks without proving that users can drive the Agent from the desktop app. Since P0-P4 is already test-covered, the next highest-risk user-facing gap is replacing `CopilotSidebar` with the real `ChatWorkspace`.

Adjustment:

- Start F0 now.
- Start F1 as soon as the shell is ready.
- Treat the first desktop-to-agent streaming conversation as the next milestone, before deep Memory work.

### Finding 4: Architecture Document Has Residual Contradictions

The current architecture has SDK-first sections, but the v1.0 scope summary still says P4 includes "自建 Agent Loop + 工具并行化". That conflicts with the SDK integration spec and the earlier architecture decision that Pi SDK owns Agent Loop and tool execution.

Adjustment:

- Update the roadmap wording to "Pi SDK Agent Loop + AG-UI adapter + hook-based customization".
- Keep custom work limited to Gate, Evidence, EventBus, AG-UI mapping, and frontend/UI contracts.

### Finding 5: P6 Should Be a Stabilization Gate, Not Just a Feature Phase

The P6 scope includes SessionManager verification, Session Health, and SessionFileRegistry. These are reliability gates for any serious user workflow and should be completed before Memory, Usage, or frontend session management is expanded.

Adjustment:

- Keep P6 before P7/P8.
- Allow F3 session UI to begin only after the P6 API contract and health behavior are verified.

---

## Revised Development Order

### S0: Stabilize The Existing Baseline

Purpose: make P0-P4 genuinely repeatable for every later phase.

1. Fix root verification scripts.
2. Run backend/package tests and full typecheck from root.
3. Update roadmap wording that still implies a self-built Agent Loop.
4. Confirm whether the modified `pnpm-workspace.yaml` is intentional before touching it.

Exit criteria:

- One root command validates packages, server, and desktop typecheck.
- P0-P4 status can be trusted by future agents without special command knowledge.

### S1: Desktop Shell And Provider Bootstrap

Purpose: make the app usable enough to drive backend work from the desktop.

Backend:

- Keep P0-P4 unchanged except for verification fixes.

Frontend:

- F0 app shell: Tailwind/shadcn setup, title bar, three-column layout, theme, route shell.
- F8a provider bootstrap: Provider/API Key form, model selection, API Key test, local settings persistence.
- Remove `CopilotSidebar` from the primary surface and introduce a placeholder `ChatWorkspace`.

Exit criteria:

- Desktop opens to the real pi-agent shell.
- User can configure a provider/API key without editing environment variables.

### S2: Tool Execution And Confirmation Backbone

Purpose: make Agent actions safe and visible before expanding capabilities.

Backend:

- P5 Gate integration.
- Pi SDK built-in tool activation and tool whitelist.
- Web search/web fetch extension only if the provider contract is stable.
- Evidence Ledger minimal recording.
- P10a minimal WebSocket: auth, `confirmation_request`, `confirmation_response`, connection lifecycle.

Frontend:

- F2 foundation only: permission mode control, confirmation UI, generic tool card state machine.

Exit criteria:

- Dangerous tool calls request confirmation.
- User approval/denial round-trips through desktop UI.
- Tool events render as cards, even if per-tool detail views are still basic.

### S3: Streaming Chat MVP

Purpose: establish the core product loop.

Backend:

- Keep AG-UI run/steer/follow-up stable.
- Add missing contract tests for event order if gaps are found.

Frontend:

- F1 streaming chat: `useStreamingRun`, message stream, input area, interrupt, loading/error/empty states.
- Basic session list backed by current thread IDs, without full persistence UI.

Exit criteria:

- Desktop user can send a message, receive streamed text, see tool cards, and interrupt a run.
- This flow works after a desktop reload.

### S4: Session Reliability

Purpose: make conversations durable before long-context features.

Backend:

- P6 SessionManager verification.
- Session Health and orphan toolResult repair.
- SessionFileRegistry for tool-produced files.
- Fix known L5/L6 issues: deep config merge and `navigate` encapsulation.

Frontend:

- F3 session persistence UI: restore, search, rename/delete/export, branch navigation.

Exit criteria:

- Restarting the app preserves usable conversations.
- Navigation/fork/compact endpoints operate through `PiAgUiAgent` rather than direct session internals.

### S5: Context And Memory

Purpose: add long-running assistant behavior after chat/tool/session loops are solid.

Backend:

- P7 compaction verification, Storm Breaker, tool output truncation.
- P8 FactStore, SessionSummary, MemoryTicker, Memory Reflection, memory_search.

Frontend:

- F4 compaction banner/context panel.
- F5 memory panel.

Exit criteria:

- Long conversations compact safely and continue.
- User-visible memory can be inspected and refreshed.

### S6: Usage And Full Realtime

Purpose: make cost and operational state visible.

Backend:

- P9 Usage Ledger.
- P10b notification, DevLog, memory update, usage update WebSocket events.

Frontend:

- F6 usage panel.
- F7 notification center, DevLog panel, realtime usage refresh.

Exit criteria:

- Per-run and daily usage are visible.
- WebSocket reconnect and notification handling are stable.

### S7: RC Settings And Polish

Purpose: complete desktop expectations for v1.0.

Frontend:

- F8b full settings: model management, agent management, security, proxy, about/update.
- F9 polish: command palette, shortcuts, accessibility, performance, tray, update UI, error boundaries.

Backend:

- Only blocking API gaps needed by F8b/F9.

Exit criteria:

- v1.0 release checklist can be run from a clean machine with documented setup.

---

## Recommended v1.0 Scope

Keep in v1.0:

- Single Agent daily-use desktop experience.
- Provider/API Key setup.
- Streaming chat.
- Tool cards and confirmation.
- Session persistence.
- Compaction.
- Basic memory.
- Usage visibility.
- Minimal notifications.

Defer to v1.1+:

- Plugin system.
- Multi-agent/subagent collaboration UI.
- Cron automation.
- Full i18n beyond Chinese-first scaffolding.
- Advanced per-tool visualization polish that is not required for safe operation.

---

## Next Plan To Write

The next implementation plan should be `S0 + S1` only. It should include:

1. Root script fixes and verification commands.
2. Architecture roadmap wording cleanup.
3. Frontend dependency setup.
4. `ChatWorkspace` shell replacement for `CopilotSidebar`.
5. Provider/API Key bootstrap path.

That plan should not include P7-P10 or Memory work. Those phases depend on the desktop loop being usable first.
