---
phase: quick-2
plan: 2
subsystem: dev-preview
tags: [port-registry, ipc, worktree, dev-server, assignedUrl]
dependency_graph:
  requires: []
  provides: [assignedUrl-on-DevPreviewSessionState, portRegistry-in-DevPreviewSessionService, getByWorktree-IPC]
  affects: [DevPreviewSessionService, devPreview-IPC-stack, preload-bridge, ElectronAPI-types]
tech_stack:
  added: [node:net (port probing)]
  patterns: [restart-safe-port-reuse, portRegistry-map, worktreeToSession-map]
key_files:
  created: []
  modified:
    - shared/types/ipc/devPreview.ts
    - electron/services/DevPreviewSessionService.ts
    - electron/ipc/channels.ts
    - electron/ipc/handlers/devPreview.ts
    - electron/preload.cts
    - shared/types/ipc/api.ts
decisions:
  - Port is NOT released in stopSessionTerminal (preserves port for restart), only released in stop()/stopByPanel()/stopByProject()/dispose()
  - allocatePort() checks portRegistry by sessionKey first -- returns existing port for restart case before probing for new port
  - PORT env var merged into spawnEnv before ptyClient.spawn() call; no changes to ptyClient.spawn() signature needed
  - getByWorktree() is synchronous (not async) -- portRegistry and worktreeToSession are in-memory maps
  - ElectronAPI type in shared/types/ipc/api.ts is the canonical renderer-facing type (not src/types/electron.d.ts which delegates to it)
metrics:
  duration: ~20min
  completed: 2026-04-16
  tasks_completed: 2
  files_modified: 6
---

# Quick Task 2: Implement per-worktree dev server port registry with proactive port assignment and assignedUrl on DevPreviewSessionState

**One-liner:** Per-worktree port registry with restart-safe port reuse, assignedUrl populated at spawn time, and getByWorktree IPC method wired through the full stack.

## What Was Built

### Task 1: assignedUrl + port registry in DevPreviewSessionService

- Added `assignedUrl: string | null` field to `DevPreviewSessionState` in `shared/types/ipc/devPreview.ts`
- Added `DevPreviewGetByWorktreeRequest` type to `devPreview.ts`
- Added `portRegistry: Map<string, number>` (sessionKey → port) and `worktreeToSession: Map<string, string>` (worktreeId → sessionKey) maps to `DevPreviewSessionService`
- Implemented `allocatePort(sessionKey)`: checks portRegistry first for restart-safe port reuse; probes random ports 3000–9999 up to 20 attempts; falls back to OS-assigned port
- Implemented `releasePort(sessionKey)`: called on `stop()`, `stopByPanel()`, `stopByProject()`, and `dispose()` — intentionally NOT called in `stopSessionTerminal()` to preserve port across restarts
- Implemented `getByWorktree(worktreeId)`: resolves session state from worktreeId via worktreeToSession map
- Updated `spawnSessionTerminal()` to compute sessionKey, call `allocatePort()`, merge `PORT` into `spawnEnv`, set `session.assignedUrl`, and broadcast `assignedUrl` in `updateSession()`
- Updated `updateSession()` Pick type to include `"assignedUrl"` and handle the field
- Updated `getSessionState()` fallback object and `toPublicState()` to include `assignedUrl`
- Updated `getOrCreateSession()` to initialize `assignedUrl: null` and register `worktreeToSession` if worktreeId is present
- Updated `ensure()` to refresh `worktreeToSession` after config fields are set

### Task 2: IPC channel, handler, preload bridge, renderer types

- Added `DEV_PREVIEW_GET_BY_WORKTREE: "dev-preview:get-by-worktree"` to `electron/ipc/channels.ts`
- Added `handleGetByWorktree` handler in `electron/ipc/handlers/devPreview.ts` with input validation (worktreeId must be non-empty string)
- Added `DevPreviewGetByWorktreeRequest` import to `electron/preload.cts` and added inlined channel constant
- Added `getByWorktree()` bridge method to `devPreview` namespace in preload.cts
- Added `DevPreviewGetByWorktreeRequest` import and `getByWorktree()` signature to `ElectronAPI.devPreview` in `shared/types/ipc/api.ts`

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | 670afbe44 | feat(quick-2): add assignedUrl and port registry to DevPreviewSessionService |
| 2 | ed2bbd20b | feat(quick-2): wire DEV_PREVIEW_GET_BY_WORKTREE IPC channel through full stack |

## Verification Results

- `grep -n "assignedUrl" shared/types/ipc/devPreview.ts` — line 29: `assignedUrl: string | null`
- `grep -n "portRegistry|allocatePort|releasePort|getByWorktree" DevPreviewSessionService.ts` — all four symbols present
- `grep -n "existing = this.portRegistry.get"` — line 141: port-reuse guard confirmed
- `grep -n "DEV_PREVIEW_GET_BY_WORKTREE" electron/ipc/channels.ts` — line 410
- `grep -n "getByWorktree" electron/ipc/handlers/devPreview.ts` — line 75
- `grep -n "getByWorktree" electron/preload.cts` — line 1919
- `grep -n "getByWorktree" shared/types/ipc/api.ts` — line 716

## Deviations from Plan

None — plan executed exactly as written.

## Loop 2 Simulation Gate

INFO: formal-coverage-intersect.cjs not found -- skipping formal coverage check (fail-open)
INFO: No formal coverage intersections found -- Loop 2 not needed (GATE-03).
WARNING: formal-coverage-intersect.cjs not found -- skipping (fail-open)
WARNING: solution-simulation-loop.cjs not found or errored -- skipping Loop 2 simulation (fail-open)

## Self-Check

- `/Users/jonathanborduas/canopy-worktrees/feature-dev-servers-per-worktree/shared/types/ipc/devPreview.ts` — modified with assignedUrl
- `/Users/jonathanborduas/canopy-worktrees/feature-dev-servers-per-worktree/electron/services/DevPreviewSessionService.ts` — modified with port registry
- `/Users/jonathanborduas/canopy-worktrees/feature-dev-servers-per-worktree/electron/ipc/channels.ts` — modified with DEV_PREVIEW_GET_BY_WORKTREE
- `/Users/jonathanborduas/canopy-worktrees/feature-dev-servers-per-worktree/electron/ipc/handlers/devPreview.ts` — modified with handler
- `/Users/jonathanborduas/canopy-worktrees/feature-dev-servers-per-worktree/electron/preload.cts` — modified with bridge method
- `/Users/jonathanborduas/canopy-worktrees/feature-dev-servers-per-worktree/shared/types/ipc/api.ts` — modified with ElectronAPI signature
- Commit 670afbe44 — FOUND
- Commit ed2bbd20b — FOUND

## Self-Check: PASSED
