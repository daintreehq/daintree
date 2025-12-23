# Phase 3 Spec: Agent Read/Inspect Tools (Reliable One‑Shot Commands)

## Summary
Phase 2 can execute basic actions, but it will frequently fail on “real” requests because it lacks grounded app state (e.g., worktree IDs, terminal IDs, what’s running, what’s waiting).

This phase adds **query actions** and **safe inspection IPC** so the agent can request structured snapshots (and optionally limited terminal tails) before choosing a single action.

## Depends On
- Phase 1 Actions foundation (`issues/app-wide-agent/phase-1-global-actions-system.md`)
- Phase 2 One-shot agent UI/service (`issues/app-wide-agent/phase-2-one-shot-agent-mvp.md`)

## Goals
- **G1: Query actions**: expose a small set of `kind: "query"` actions in the manifest.
- **G2: Grounded identifiers**: allow the agent to resolve `worktreeId`, `terminalId`, `projectId` deterministically.
- **G3: Safe terminal inspection**: provide limited, redacted access to terminal output (tail/snapshot) behind explicit user consent.
- **G4: Better “ask” flow**: use queries to reduce clarifying questions.

## Non‑Goals
- Long-running workflows (automation engine).
- Full-text search over all terminal history.
- Agent writing arbitrary files (beyond existing app actions).

## Architecture (4-layer)

### 1) Services (main process)
Add a focused inspection service that reads from existing main-process sources:
- worktree snapshots via existing workspace services
- terminal snapshots via `PtyManager.getTerminalSnapshot()` (exists in `electron/services/PtyManager.ts`)
- event buffer queries via existing `EventBuffer` / Event Inspector sources

Proposed module: `electron/services/AgentInspectionService.ts`

### 2) IPC
Introduce new IPC channels for safe inspection, with Zod validation:
- `agent-inspect:get-context` (returns a structured “agent view” of current app context)
- `agent-inspect:terminal-tail` (returns last N lines, redacted)
- `agent-inspect:terminal-snapshot` (returns bounded snapshot: last N lines + timestamps)
- `agent-inspect:events-query` (filtered event records; already exists via event inspector, but may need an “agent-safe” wrapper)

Prefer returning **bounded payloads** (size limits enforced in main).

### 3) Store (renderer)
Extend the agent store to handle:
- multi-turn “tool calls” inside a one-shot run (query → decide → dispatch)
- user consent state for terminal inspection (“allow once”, “always allow for this project”)

### 4) UI (renderer)
Add a small “Context used” drawer so users can see what the agent read:
- worktree list snapshot summary
- terminal tail snippet (redacted)
- events queried (types + filters)

## Query Actions (Phase 3)
Add `kind: "query"` actions to the Action Registry. These are callable by the agent and by UI.

Recommended initial set:
- `context.get` → returns `ActionContext` + current `projectId`
- `worktrees.list` → `{ worktrees: Array<{ id, name, path, branch?, isCurrent, prNumber?, issueNumber?, mood? }> }`
- `terminals.list` → `{ terminals: Array<{ id, title, kind, agentId?, worktreeId?, location, agentState?, lastActivityHeadline? }> }`
- `terminal.getInfo` `{ terminalId }` → existing `terminal:get-info` payload (sanitized)
- `events.query` `{ filters }` → Query the main-process **`EventBuffer`**.
  - Enables the agent to answer "what just happened?" or "did the last command fail?".
  - Supports filtering by `type` (including `action:dispatched`, `sys:worktree:update`, `agent:output`), `time`, and `traceId`.
  - Returns a sanitized, bounded list of `EventRecord`s.

Note: `worktrees.list` and `terminals.list` can be computed in the renderer from stores, but providing them as query actions keeps the agent/tool contract uniform.

## Terminal Output Inspection (Phase 3)
### Why it’s special
Terminal output may contain secrets (tokens printed by CLIs, env vars, copied credentials). Phase 3 introduces this capability only with explicit consent.

### Consent model
Add a project-level toggle:
- `Allow agent to read terminal output (redacted)` [off by default]
  - “Allow once” per request
  - “Always allow for this project”

### Redaction policy (minimum viable)
In main process, before returning any terminal output:
- Remove lines that match common secret patterns (token/key/password), similar to existing `SENSITIVE_ENV_KEY_RE` in `ProjectSettingsDialog`.
- Apply length limits per line and per response.
- Default to “tail” only (e.g., last 25 lines).

### New inspection endpoints (proposed)
1) `agent-inspect:terminal-tail`
- input: `{ terminalId: string; maxLines: number }` (cap `maxLines` to 50)
- output: `{ terminalId: string; lines: string[]; redacted: boolean; truncated: boolean }`

2) `agent-inspect:terminal-snapshot`
- input: `{ terminalId: string; maxLines: number }`
- output: `{ terminalId: string; lines: string[]; lastOutputTime: number; agentState?: string; redacted: boolean }`

Implementation source of truth:
- `PtyManager.getTerminalSnapshot(id)` which returns bounded `lines` already (see `electron/services/pty/types.ts`).

## One-shot Agent Loop Update (Phase 3)
Phase 2 is “model → single dispatch”. Phase 3 becomes:
1) model may request **queries** (0–3 max) to gather IDs/state
2) model returns final `dispatch`

This is still “one-shot” from the user’s perspective (single run), but internally includes a small, bounded tool loop.

Enforce:
- max tool calls per run (e.g., 3)
- max bytes per tool response
- strict schema validation at every step

## Safety & Controls
- **Action allowlist** remains the control plane.
- **Query allowlist** is separate: terminal output tools are gated behind consent.
- **Sanitization**: do not return unredacted terminal output by default.
- **No implicit side effects**: query actions must be read-only.

## Acceptance Criteria
- The agent can reliably execute requests like:
  - “Focus the worktree working on issue 123”
  - “Switch to the worktree where Claude is waiting”
  - “Open settings → terminal appearance”
  - “Show me the last output from the focused agent”
- The agent can resolve IDs using queries rather than guessing.
- Terminal tail/snapshot reads are impossible without user consent and are redacted/bounded.
- The UI can show what context/tools were used during the run.

