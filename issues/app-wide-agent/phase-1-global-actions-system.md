# Phase 1 Spec: Global Actions System (Foundation)

## Summary
Canopy already has the ingredients of an “actions” system (keybinding `actionId`s, menu action strings, UI `CustomEvent`s, and a typed main-process event bus), but the implementation is fragmented across the renderer and hard to control programmatically.

This phase establishes a **single, typed Actions surface in the renderer** that:

- Provides a central `dispatch(actionId, args?)` entrypoint for UI, keybindings, menus, and (later) the app-wide agent.
- Exposes an introspectable **Action Manifest** (IDs, descriptions, args schema, enablement) suitable for LLM tool/function calling.
  - **Design Note:** The schema export should be structured to align with **MCP (Model Context Protocol)** conventions (e.g., `name`, `description`, `inputSchema`). Even though we are not running a full MCP server, presenting tools in this familiar format leverages existing model training.
- Migrates the existing menu actions to the new dispatcher as the first “thin slice” without refactoring the whole app.

This is explicitly the “foundation” layer: it does not yet include a chat UI, long-running automations, or a workflow DSL.

## Current State (Observed in Repo)

### Existing “actions-ish” mechanisms
- **Keybinding action IDs** already exist as a canonical union in `shared/types/keymap.ts` (`KeyAction`) and are configured in `src/services/KeybindingService.ts`, but they are **executed ad-hoc** via many `useKeybinding("some.action", () => ...)` call sites (not centrally dispatched).
- **App menu actions** are currently stringly-typed messages from main → renderer:
  - Main: `electron/menu.ts` sends `CHANNELS.MENU_ACTION` strings like `"new-terminal"`, `"open-settings"`, and `"launch-agent:claude"`.
  - Renderer: `src/hooks/useMenuActions.ts` switches on those strings and calls stores / UI callbacks directly.
- **Renderer-wide UI actions** are often done via `window.dispatchEvent(new CustomEvent("canopy:..."))` (e.g. `"canopy:toggle-focus-mode"`, `"canopy:toggle-terminal-dock"`) and listened to in components like `src/components/Layout/AppLayout.tsx`.
- **Main-process domain event bus** exists (`electron/services/events.ts`, `electron/services/EventBuffer.ts`) and is exposed via the Event Inspector IPC, but it is not yet a unified “command/action” surface.

### Why this blocks an app-wide agent
An agent needs:
- A **stable tool list** (what can I do?) with schemas.
- A **single execution API** (do X) that works regardless of whether X originated from a menu click, keybinding, or agent.
- A clear boundary for **dangerous operations**, **enablement**, and **observability**.

The current approach spreads action logic across App/component hooks and DOM events, making “agent controls app” a major refactor later.

## Goals (Phase 1)
- **G1: Define a Global Action ID space** with stable naming and a central registry.
- **G2: Implement a renderer Action Registry + Dispatcher** that can execute actions by ID with typed args + typed result.
- **G3: Action Manifest export** (`list()` / `get(id)`) including descriptions, args schema, and dynamic enablement.
- **G4: Migrate menu actions** (`src/hooks/useMenuActions.ts`) to the dispatcher so menu + agent share the same entrypoint.
- **G5: Create a safe extension path** for future phases (capabilities, confirmations, automation engine).

## Non-Goals (Phase 1)
- Building the app-wide chat UI or model integration (BYOK, Gemini/Claude hosted, etc.).
- A workflow DSL (if/else, loops, listeners) or a long-running automation engine.
- Refactoring *every* existing keybinding and `CustomEvent` usage immediately.
- Introducing new native dependencies.

## Proposal: “Canopy Actions” (Renderer-Centric)

### Key architectural decision
Phase 1’s actions system should live in the **renderer** because:
- Many actions are purely UI/state (open modal, toggle focus mode, select worktree, focus terminal).
- Renderer already orchestrates stores and calls main via IPC clients (`src/clients/*`).

This stays aligned with the repo’s 4-layer pattern (`Service → IPC → Store → UI`) by treating Actions as a *cross-cutting orchestration layer* in the renderer that uses existing Stores and IPC clients rather than bypassing them.

### Core types (shared where possible)
Create a new shared type surface so the agent and UI can talk about the same things:

- `ActionId`: string union (start with `KeyAction` + new action IDs as needed).
- `ActionContext`: dynamic context derived from stores (active worktree, focused terminal, project id, etc.).
- `ActionDefinition<Args, Result>`:
  - `id`, `title`, `description`, `category`
  - `kind`: `"command"` | `"query"`
  - `danger`: `"safe"` | `"confirm"` | `"restricted"`
  - `scope`: `"renderer"` (Phase 1; extendable later)
  - `argsSchema` / `resultSchema` (Zod)
  - `isEnabled(ctx): boolean` + `disabledReason?(ctx): string`
  - `run(args, ctx): Promise<Result>`

### Registry + dispatcher API (renderer)
Add a new renderer service (example naming):
- `src/services/ActionService.ts`

API shape:
- `register(definition)`
- `dispatch(actionId, args?, options?) => Promise<{ ok: true; result } | { ok: false; error }>`
- `list(ctx?) => ActionManifestEntry[]`
- `get(actionId) => ActionManifestEntry | null`

Where `ActionManifestEntry` includes:
- `id`, `title`, `description`, `category`, `kind`, `danger`
- `argsJsonSchema` (derived from Zod) and a short example payload
- `enabled` and optional `disabledReason`

### Minimal “action context” (Phase 1)
Context can start small and grow:
- `projectId` (current project)
- `activeWorktreeId`
- `focusedTerminalId`
- `isTerminalPaletteOpen` / `isSettingsOpen` (optional)

Compute it from existing stores on-demand (no need to maintain another global state store).

### Menu → Actions mapping (Phase 1 migration)
Replace stringly menu handling in `src/hooks/useMenuActions.ts` with an adapter:
- `"new-terminal"` → `terminal.new`
- `"new-worktree"` → `worktree.createDialog.open` (new action ID)
- `"open-settings"` → `app.settings.open`
- `"open-settings:<tab>"` → `app.settings.openTab` with `{ tab }`
- `"toggle-sidebar"` → `nav.toggleSidebar`
- `"open-agent-palette"` → `terminal.palette.open` (or alias to `terminal.palette`)
- `"launch-agent:<agentId>"` → `agent.launch` with `{ agentId }`

This yields an immediate “agent parity” target: if an action can be triggered from the menu, it can be triggered by the agent in the same way.

### Keybindings integration (Phase 1: minimal)
Phase 1 does **not** need to migrate all `useKeybinding` call sites.

Instead, Phase 1 should:
- Introduce a pattern that future migrations use:
  - `useActionKeybinding(actionId)` → `dispatch(actionId)`
  - Or a single hook wiring: `useKeybinding(actionId, () => actionService.dispatch(actionId))`
- Migrate only a small set that overlaps with menu actions to validate the pattern.

### CustomEvent (“canopy:*”) integration (Phase 1: contain, don’t delete yet)
Keep existing `CustomEvent` listeners for now to avoid broad churn, but stop introducing new ones.

Phase 1 should:
- Add Action IDs that directly call the store operations currently invoked by those events (e.g. `nav.toggleSidebar`, `panel.toggleDock`, `panel.toggleSidecar`).
- Optionally update the *emitters* (menu/keybindings) to call actions instead of dispatching DOM events.

## Initial Action Set (Phase 1)

### Required (menu parity)
- `terminal.new` (spawn a terminal in active worktree)
- `worktree.createDialog.open` (open New Worktree dialog)
- `app.settings.open` (open settings modal)
- `app.settings.openTab` `{ tab: "general" | "keyboard" | "terminal" | "terminalAppearance" | "worktree" | "agents" | "github" | "sidecar" | "troubleshooting" }`
- `nav.toggleSidebar` (currently toggles focus mode / sidebar layout)
- `terminal.palette.open` (open terminal/agent palette)
- `agent.launch` `{ agentId: "claude" | "gemini" | "codex" | "terminal" | "browser" }`

### Introspection / developer support
- `actions.list` (query) → returns `ActionManifestEntry[]`
- `actions.getContext` (query) → returns the current `ActionContext`

## Safety Model (Phase 1 scaffolding)
Even before the agent exists, define the structure for safety:
- `danger: "safe"` for UI navigation and non-destructive actions.
- `danger: "confirm"` for actions that destroy state or kill processes (not in Phase 1’s required set, but the type system should support it).
- `danger: "restricted"` for “future-only” actions that should never be agent-accessible by default.

This is enough to build a future agent “capability filter” without refactoring every action later.

## Observability (Phase 1)
Integrate with the existing main-process **Event System** (`electron/services/events.ts` / `EventBuffer`) to ensure all actions are trackable by future agents.

- **Action Emission:** The `ActionService` must emit an event whenever an action is executed.
  - Create a new IPC channel `events:emit` (or `action:track`) to bridge renderer actions to the main process event bus.
  - Emit a new event type `action:dispatched` (to be added to `CanopyEventMap`) containing:
    - `actionId`
    - `args` (sanitized/redacted if necessary)
    - `context` (summary)
    - `source` ("user", "keybinding", "menu", "agent")
- **Event Inspector:** These events will automatically surface in the Event Inspector via the existing `EventBuffer`.
- **Agent Visibility:** This ensures that in Phase 3/4, the agent can "see" what the user did by querying the event history.

## Deliverables (Phase 1)
- New global actions folder/module in renderer (registry + dispatcher + manifest).
- New shared types for actions and action manifest (or renderer-local types if we want to keep Phase 1 smaller; recommended: shared for agent tooling).
- Menu actions migrated to dispatcher (remove the ad-hoc switch logic).
- At least 2–3 keybindings migrated to dispatch actions (prove the pattern).
- Basic unit tests for:
  - registry registration and duplicate ID guardrails
  - Zod arg validation failures return structured errors
  - enablement computation from mocked context

## Acceptance Criteria
- A single `dispatch(actionId, args?)` call can trigger the same behavior as the current menu items:
  - New Terminal
  - New Worktree dialog
  - Open Settings (and specific settings tab)
  - Toggle sidebar/focus mode
  - Open terminal/agent palette
  - Launch an agent type
- `actions.list` produces a manifest suitable for LLM tool exposure (stable IDs + descriptions + args schema).
- Menu handling logic in `src/hooks/useMenuActions.ts` is reduced to mapping → `dispatch`, not direct store/UI calls.
- No regressions in current UX flows (manual QA checklist for these menu actions).

## Follow-ups (Next Phases, Not in This Spec)
- Phase 2: Expand action set to cover terminal/worktree/sidecar operations and add “query” tools (terminal tail, terminal summary, settings snapshot).
- Phase 3: Add an agent UI that calls the dispatcher, plus capability filtering and confirmations.
- Phase 4: Long-running automation engine (workflow DSL, listeners, pause/resume), built on actions + event streams.

