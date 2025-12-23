# Phase 2 Spec: One‑Shot Agent MVP (Basic Actions)

## Summary
This phase ships the smallest “app‑wide agent” that is immediately useful: a one‑shot command UI that uses an LLM to choose and execute **exactly one** global action via the Phase 1 dispatcher.

Core loop:
1) user types a request → 2) agent selects an action + args → 3) app confirms if needed → 4) dispatcher executes → 5) user sees result.

## Depends On
- `Phase 1: Global Actions System (Foundation)` (`issues/app-wide-agent/phase-1-global-actions-system.md`)

## Goals
- **G1: One-shot UX**: a lightweight command entry UI that can be opened anywhere.
- **G2: Single action execution**: the agent returns one `dispatch(actionId, args)` call (or a clarifying question).
- **G3: Safe by default**: action metadata drives confirmations; secrets never logged.
- **G4: BYOK configuration**: user can supply a model + API key without installing new CLIs.
- **G5: Deterministic debugging**: show the resolved action + args + result (and optionally the raw model output).

## Non‑Goals
- Multi-step workflows, loops, event listeners, or automation runs.
- Long-term memory, summarization, or note-taking (Phase 4).
- Exposing dangerous actions (delete worktree, kill all terminals) to the agent.

## UX
### Entry points
- Menu: `Agent → One-shot Command…` (new menu item; can reuse existing menu wiring)
- Keybinding: `agent.commandBar` (new `KeyAction` in a later migration) or reuse an existing chord.

### Command bar behavior
- Single-line input with “Enter to run”.
- Inline result area: “Action selected → Executed → Outcome”.
- If the agent needs clarification, show a single clarifying question with 2–6 buttons plus “Cancel”.
- If an action is `danger: confirm`, show a confirmation sheet with the exact action + args.

### First-run onboarding
- If no provider key is configured, the command bar opens directly into a “Configure Agent” screen with a link to Settings.

## Architecture (4-layer)
This phase introduces a minimal model-calling path while keeping secrets out of the renderer.

### 1) Service (main process)
Add a service responsible for:
- Validating requests
- Building a tool/manifest prompt
- Calling the chosen provider over HTTPS
- Returning a structured “agent decision” object

Proposed module: `electron/services/AppAgentService.ts`

### 2) IPC
Add a handler to bridge the renderer command bar to the main service:
- `app-agent:run-one-shot` → returns `AgentDecision`
- `app-agent:get-config` / `app-agent:set-config` (or reuse existing Settings persistence paths)

Use Zod schemas in `electron/schemas/ipc.ts` (consistent with other handlers like `slashCommands`).

### 3) Store (renderer)
Add a small Zustand store to manage:
- open/close state
- current input
- pending decision / confirmation
- last result (Phase 4 persists history)

Proposed module: `src/store/appAgentStore.ts`

### 4) UI (renderer)
Add a command bar component:
- `src/components/AppAgent/OneShotCommandBar.tsx`
- optionally `src/components/AppAgent/AgentConfigCallout.tsx`

## Data & Configuration
### Provider config (BYOK)
Store alongside existing sensitive config patterns (e.g., GitHub token in `electron-store`), not in project settings.

Proposed storage location:
- `electron/store.ts` → `userConfig.appAgent`:
  - `provider`: `"openai"` | `"anthropic"` | `"google"` | `"openaiCompatible"`
  - `model`: string
  - `apiKey`: string (sensitive)
  - `baseUrl` (optional for compatible endpoints)

Security constraints:
- Never emit `apiKey` to renderer.
- Never include it in logs/events.
- Only main process performs the HTTPS request.

## Tool Contract (Model Output)
To keep Phase 2 reliable across providers, treat the model response as a **strict JSON** object (validated with Zod).

### Response shape (example)
One of:
- **dispatch**
  - `{ "type": "dispatch", "id": "app.settings.openTab", "args": { "tab": "agents" } }`
- **ask**
  - `{ "type": "ask", "question": "Which worktree?", "choices": [{ "label": "api", "value": "wt-1" }] }`
- **reply** (no action)
  - `{ "type": "reply", "text": "I can do that once actions are enabled for it." }`

The renderer executes only `dispatch` and only after:
- action exists in the Action Registry
- args validate against `argsSchema`
- action is `enabled` in current context
- confirmation satisfied if `danger: confirm`

## Prompt Inputs (what the model receives)
Phase 2 prompt payload should be small and deterministic:
- User message
- Current `ActionContext` (from Phase 1)
- **Tool Definitions:** A list of available actions presented as **MCP-compatible tool definitions** (name, description, inputSchema). This ensures the model "thinks" it is using standard functions/tools.

Do **not** send raw terminal output or full settings snapshots yet (Phase 3).

## Action Set Exposed to the Agent (Phase 2)
Start with “safe navigation + spawning” only:
- `app.settings.open`
- `app.settings.openTab`
- `terminal.new`
- `terminal.palette.open`
- `worktree.createDialog.open`
- `worktree.selectByName` (if implemented; otherwise omit)
- `agent.launch`
- `nav.toggleSidebar`
- `panel.toggleDock`
- `panel.toggleSidecar`

Everything else remains non-agent-accessible until Phase 3+ hardens read tools and safety.

## Safety & Abuse Controls
- **Allowlist only**: agent sees only actions explicitly marked `agentAccessible: true`.
- **Confirmations**: any `danger: confirm` requires explicit user approval in the UI.
- **Rate limiting**: basic debounce / single in-flight request to prevent spamming providers.
- **PII/secrets**: no terminal output ingestion in Phase 2; keep payloads minimal.

## Observability
Leverage the **Event System** established in Phase 1 for full traceability:
- **Action Tracking:** The dispatcher will automatically emit `action:dispatched` events to the main process `EventBuffer`.
- **Agent Decisions:** The `AppAgentService` must emit specific agent lifecycle events:
  - `agent:run:started` (user prompt, context summary)
  - `agent:decision` (tool calls, reasoning)
  - `agent:run:completed` (result)
- **Traceability:** All events should include a `traceId` linking the user request to the agent execution and resulting action.
- **Debug UI:** Phase 2 can simply query `EventBuffer` (via `events.query`) or subscribe to show the live trace in the command bar.

## Acceptance Criteria
- One-shot command bar can:
  - open settings and specific tabs
  - spawn a terminal
  - open terminal palette
  - launch a selected agent type
  - toggle dock / sidecar / sidebar
- For unsupported requests, it returns `reply` or asks a single clarification.
- The model never receives or returns sensitive config (API keys).
- Debug mode shows “selected action JSON” and validation errors when things fail.

