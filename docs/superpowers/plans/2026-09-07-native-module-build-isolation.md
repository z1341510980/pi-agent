# Native Module Build Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep the Node.js ABI used by backend development separate from the Electron ABI used by packaged builds.

**Architecture:** The desktop build first creates `.deploy-tmp`, rebuilds `better-sqlite3` only inside that isolated production tree for the installed Electron version, then collects that tree into the server distribution. Development startup validates that the workspace native module loads under the current Node.js runtime and reports an actionable error otherwise.

**Tech Stack:** pnpm workspaces, Node.js ESM scripts, Electron 39, `@electron/rebuild`, `better-sqlite3`, bytenode.

---

### Task 1: Add development ABI validation

**Files:**
- Create: `apps/agent-server/scripts/check-native-abi.mjs`
- Modify: `apps/agent-server/package.json`

- [x] Add a script that loads `better-sqlite3`, opens an in-memory database, and exits with a message containing the current Node ABI when loading fails.
- [x] Run it against the current workspace module and confirm the existing Electron-ABI module fails under Node 22.
- [x] Wire it before the server dev command.

### Task 2: Isolate Electron native rebuilds

**Files:**
- Modify: `apps/desktop/scripts/rebuild-sqlite.mjs`
- Modify: `apps/desktop/package.json`

- [x] Resolve `better-sqlite3` from `.deploy-tmp` instead of the workspace package tree.
- [x] Fail clearly if the deploy tree does not exist.
- [x] Validate an existing binary by loading it through Electron before reusing it.
- [x] Run `prebuild-install` or `@electron/rebuild` against only `.deploy-tmp`.
- [x] Keep `build:server` order as deploy, native rebuild, bytenode build, and dependency collection.

### Task 3: Collect the rebuilt production module

**Files:**
- Modify: `apps/agent-server/scripts/collect-server-deps.mjs`

- [x] Resolve the native package roots from the deployed tree after deploy completes.
- [x] Copy those roots as real directories into `dist/node_modules`.
- [x] Preserve the existing fallback collector for non-build invocations.

### Task 4: Verify both runtime paths

- [x] Restore the workspace module to Node ABI and run `pnpm --filter agent-server dev`.
- [x] Run `pnpm --filter desktop build` and verify it completes without modifying the workspace native binary.
- [x] Load the collected production module with Electron's Node runtime.
- [x] Run targeted typechecks and tests.
