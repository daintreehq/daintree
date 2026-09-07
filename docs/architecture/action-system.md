# Action System Architecture

The Action System is Daintree's central orchestration layer for all UI operations. It provides a unified, typed API that powers menus, keybindings, context menus, and—critically—AI agent automation.

## Core Philosophy

### Decoupling UI from Business Logic

Actions separate "what can be done" from "how it's triggered." A button click, keyboard shortcut, menu item, or AI agent tool call all resolve to the same `dispatch()` call. This ensures consistent behavior regardless of input source.

### AI-First Design

The Action System is designed so AI agents can drive the IDE using the exact same entry points as human users. Every action is:

- **Typed**: Zod schemas validate arguments at runtime (critical when LLMs generate args)
- **Safe**: The `danger` field controls what agents can do without confirmation
- **Observable**: Every dispatch emits events for logging, replay, and debugging

### MCP Compatibility

Actions expose themselves as an MCP-compatible manifest via `actionService.list()`. Each manifest entry carries the id, title, description, `kind`, `danger`, the JSON Schema derived from the Zod `argsSchema`, the derived risk band, and the MCP hints (`mcpVisibility`, `mcpAnnotations`, `examples`, `deprecated`). What a given caller actually _sees_ is narrower than the manifest: the MCP tier allowlists and any live per-tool grant filter it per session.

Two consequences that make this more than a convenience:

- **The manifest is a public contract.** An action's id, argument names, and result shape are what an external agent's existing calls are written against — renaming one breaks them silently. `mcp.surface` publishes a compatibility hash computed from the _unprojected_ input schema for exactly this reason.
- **The prose is billed on every turn.** Descriptions and field descriptions are re-sent with every request, so they are budget-gated in CI. [mcp-context-condensation.md](./mcp-context-condensation.md) is the authoring standard.

## Key Files

| File | Purpose |
| --- | --- |
| `shared/config/actionIds.ts` | `BUILT_IN_ACTION_IDS` — the single source of truth for built-in runtime action ids |
| `shared/types/actions.ts` | Type definitions: `ActionId`, `ActionDefinition`, `ActionContext`, `ActionSource`, `ActionDanger`, `ActionErrorCode`, `PaletteBehavior` |
| `src/services/ActionService.ts` | Singleton registry and dispatcher |
| `src/services/actions/definitions/*.ts` | ~63 domain-specific definition files, grouped into ~36 `register*Actions()` domains by `actionDefinitions.ts` |
| `src/services/actions/actionDefinitions.ts` | Registration aggregator |
| `src/services/actions/definitions/locationArgs.ts`, `schemas.ts` | Shared argument builders (worktree/project selectors, pagination) — use these rather than hand-rolling the fields |
| `src/hooks/useActionRegistry.ts` | React hook that wires UI callbacks to the service and installs the context provider |

## Action Definition Anatomy

Every action implements the `ActionDefinition` interface:

```typescript
// Abbreviated — see shared/types/actions.ts for the full interface and the
// per-field rationale, which is where the load-bearing detail lives.
interface ActionDefinition<S extends z.ZodTypeAny | undefined, Result> {
  id: ActionId; // BuiltInActionId | (string & {}) — plugins contribute the open half
  title: string; // Human-readable name
  description: string; // Model-facing prose; budgeted (see mcp-context-condensation.md)
  category: string; // Grouping: "terminal", "worktree", "git", etc.
  kind: ActionKind; // "command" | "query" — mutates vs. reads state
  danger: ActionDanger; // Safety level (see below)
  scope: ActionScope; // "renderer" (the only member today)
  denyPluginDispatch?: boolean; // Reject source:"plugin" with RESTRICTED, regardless of danger
  argsSchema?: S; // Runtime validation schema (drives arg type inference)
  resultSchema?: z.ZodType<Result>; // ENFORCED — dispatch() parses the result through it
  isEnabled?: (ctx) => boolean; // Dynamic enable/disable (fails CLOSED)
  isVisible?: (ctx) => boolean; // Discovery-layer visibility (fails OPEN)
  disabledReason?: (ctx) => string | undefined;
  palette?: PaletteBehavior; // "hidden" | "redirect" | "requireContext" — palette-only
  dangerRationale?: string; // Required when danger !== "safe"; surfaced in MCP consent
  selfNotifiesOnExecutionError?: boolean; // Suppress the palette's generic failure toast
  run: (args: InferActionArgs<S>, ctx: ActionContext) => Promise<Result>;
  // MCP/AI surface: keywords, examples, mcpAnnotations, mcpVisibility,
  //   mcpOutputSchema, safeBreadcrumbArgs, nonRepeatable, deprecated, ...
}
```

Three of these are easy to get wrong:

- **`resultSchema` is enforcement, not documentation.** `dispatch()` parses every result through it before returning, so unknown keys are stripped and the delivered payload matches the published projection. A result that fails to parse yields `RESULT_VALIDATION_ERROR` — distinct from `EXECUTION_ERROR`, because the side effects _did_ happen and only the payload is unusable. Enforcement keys off the field's presence, not off `mcpOutputSchema`.
- **`isEnabled` fails closed; `isVisible` fails open.** Hiding a command silently on a thrown predicate is more surprising than briefly showing one. Visibility is a discovery-layer concern — `get(id)` and `dispatch(id)` deliberately ignore it, so keybindings and direct lookups keep working.
- **`palette` is palette-only.** `list()` projects it onto the manifest, but `dispatch()`/`get()` ignore it. It exists because the palette dispatches with empty args `{}`, so an action whose real requirements live in `run()` rather than in `argsSchema` would otherwise leak into the palette and fail when picked. `palette: { mode: "hidden" }` is also how a call-site-gated confirm action is stopped from being bypassed by a `source: "user"` palette pick — see [destructive-action-safeguards.md](./destructive-action-safeguards.md).

### The `danger` Field

This is crucial for AI safety:

| Level | Meaning | Agent Behavior |
| --- | --- | --- |
| `safe` | Read-only or easily reversible | Executes immediately |
| `confirm` | Destructive or hard to undo | `agent`: requires host approval (native ConfirmDialog / host grant sets `confirmed`); `plugin`: always blocked |
| `restricted` | System-only, never agent-callable | Returns `RESTRICTED` error |

Examples:

- `safe`: `terminal.focusNext`, `worktree.refresh`
- `confirm`: `worktree.delete`, `terminal.killAll`
- `restricted`: Reserved for system-only operations. No definition currently sets `danger: "restricted"`, but the RESTRICTED gate in `dispatch()` (`ActionService.ts`) is wired and tested.

When `danger !== "safe"`, `dangerRationale` is required — it surfaces in the MCP host confirmation dialog so the user sees the same reasoning the model would, and in the action palette's pre-warn row.

`danger` is not the last word. `resolveEffectiveActionDanger(danger, source, args)` can raise a `safe` action to `confirm` **for one call** based on the arguments it carries — `recipe.editor.open` is `safe`, but an agent dispatch supplying a `recipeId` is elevated (#11860). And `denyPluginDispatch` closes an action to `source: "plugin"` without touching `danger` at all: `terminal.sendCommand` stays `safe` for user and agent dispatch while plugins must go through the capability-gated `host.sendToActiveAgent(...)` instead of the built-in side door (#10558). `danger` would be the wrong tool there — `confirm` would prompt on every agent call, `restricted` would block agents too.

Setting `danger: "confirm"` also has two effects beyond the gate: the action is excluded from `action.repeatLast` eligibility and from the palette's "Recently used" rail, and the palette renders it with a non-chromatic pre-warn (title ellipsis, `TriangleAlert` glyph, the rationale on the selected row). The full rubric, the per-action audit, and the list of direct-IPC bypasses live in [destructive-action-safeguards.md](./destructive-action-safeguards.md).

## The Dispatch Flow

When `actionService.dispatch(actionId, args, options)` is called:

```
1. Lookup       → Find action in registry (or return NOT_FOUND)
2. Binding?     → If a contextOverride pins a projectId that no longer matches
                  live state → return BINDING_STALE (stale session guard)
3. Validation   → Parse args through argsSchema (or return VALIDATION_ERROR)
4. Enabled?     → Check isEnabled(context) (or return DISABLED). Fails closed.
5. Restricted?  → Block if danger === "restricted" (return RESTRICTED)
6. Plugin gate  → Block if denyPluginDispatch && source === "plugin" (RESTRICTED)
7. Confirm?     → effectiveDanger = resolveEffectiveActionDanger(danger, source, args)
                  If effectiveDanger === "confirm" AND
                    (source === "plugin"  OR  (source === "agent" && !confirmed))
                  → Return CONFIRMATION_REQUIRED
                  Plugins are always confirm-gated — the `confirmed` flag is
                  ignored for plugin sources.
8. Execute      → Run the action handler (ctx carries dispatchSource for this run)
9. Result check → Parse the return value through resultSchema
                  (or return RESULT_VALIDATION_ERROR — side effects already stand)
10. Emit Event  → Log action:dispatched to main process event bus
11. Return      → { ok: true, result } or { ok: false, error }
```

`dispatchSource` on the context is written by `dispatch()` from the resolved `source`, overwriting anything a `contextOverride` supplied — a definition can trust it, and callers cannot spoof it. Note that every MCP origin (external client, in-app assistant, assistant pane) dispatches as `"agent"`; the finer-grained origin split lives on the MCP session, not on `ActionSource`.

### Result Types

```typescript
type ActionDispatchResult<T> = { ok: true; result: T } | { ok: false; error: ActionError };

interface ActionError {
  code: ActionErrorCode;
  message: string;
  details?: unknown;
}
```

`ActionErrorCode` (`shared/types/actions.ts`) is a closed union — read it there rather than from a list here, but the ones worth knowing apart:

| Code | Means |
| --- | --- |
| `NOT_FOUND` | no such action id |
| `VALIDATION_ERROR` | args failed `argsSchema` |
| `RESULT_VALIDATION_ERROR` | `run()` succeeded but its return value failed `resultSchema` — a bug in the action, not the caller; the side effects stand |
| `DISABLED` | `isEnabled(ctx)` returned false; `message` carries `disabledReason` |
| `RESTRICTED` | `danger: "restricted"`, or `denyPluginDispatch` with a plugin source |
| `CONFIRMATION_REQUIRED` | a confirm-tier dispatch with no host attestation |
| `USER_REJECTED` / `CONFIRMATION_TIMEOUT` | the human said no, or never answered |
| `EXECUTION_ERROR` | `run()` threw |
| `BINDING_STALE` | the pinned project no longer matches live state |
| `PARTIAL_SUCCESS` | a composite completed some of its work — stamped only for a thrown `PartialSuccessError` (`shared/utils/partialSuccess.ts`), never inferred from a message shape |
| `RESOURCE_NOT_OWNED` | an MCP session tried to clean up a resource it did not create (#11909) |

`ELICITATION_FAILED` is retained for compatibility with old persisted audit records only — the elicitation-confirm path was removed in #11342. Do not reuse it.

## Context Injection

Actions receive an `ActionContext` snapshot of current UI state. Every field is optional, and the shape has grown well past the original three — read `shared/types/actions.ts` for the authoritative list. The groups:

```typescript
interface ActionContext {
  // Active project
  projectId?: string;
  projectName?: string;
  projectPath?: string;
  // Active workspace when it is a scratch rather than a project (#11076/#11482).
  // Switching to one clears the other's pointer; project fields win where both
  // are briefly set, mirroring resolveWorkspaceCwd's precedence.
  scratchId?: string;
  scratchName?: string;
  scratchPath?: string;
  // Active worktree
  activeWorktreeId?: string;
  activeWorktreeName?: string;
  activeWorktreePath?: string;
  activeWorktreeBranch?: string;
  activeWorktreeIsMain?: boolean;
  // Focus
  focusedWorktreeId?: string;
  focusedTerminalId?: string;
  focusedTerminalKind?: string;
  focusedTerminalType?: string;
  focusedTerminalTitle?: string;
  // UI
  isSettingsOpen?: boolean;
  // Written by dispatch() from the resolved source — callers cannot spoof it
  dispatchSource?: ActionSource;
}
```

The context is injected via `actionService.setContextProvider()` in `src/hooks/useActionRegistry.ts`, so actions always have current UI state without prop drilling. **An action that resolves "the active workspace" must read both the project and the scratch fields** — reading only `projectPath` is what left the file browser silently no-opping inside a scratch (#11482).

## Programmatic vs. UI Usage

The same action supports both worlds:

### From UI (Button/Menu)

```typescript
// In a React component
import { actionService } from "@/services/ActionService";

const handleClick = async () => {
  const result = await actionService.dispatch("terminal.new");
  if (!result.ok) {
    console.error(result.error.message);
  }
};
```

### From Keybinding

```typescript
// Keybinding config maps key combo to action ID
{ key: "Cmd+T", action: "terminal.new" }
// The keybinding handler calls dispatch internally
```

### From AI Agent

```typescript
// Agent outputs a tool call that maps to dispatch
await actionService.dispatch(
  "worktree.delete",
  { worktreeId: "abc123" },
  { source: "agent", confirmed: true } // `confirmed` is a host attestation (native ConfirmDialog / grant), never client-supplied
);
```

## Adding a New Action

### Step 1: Add the Action ID

Built-in runtime ids live in one array — `BUILT_IN_ACTION_IDS` in `shared/config/actionIds.ts`:

```typescript
export const BUILT_IN_ACTION_IDS = [
  // ... existing IDs, grouped by the register*() function that defines them ...
  "myFeature.doThing",
] as const;
```

`BuiltInActionId` is `BuiltInKeyAction | BuiltInRuntimeActionId`, so **keybinding-only ids (`nav.*`, `tab.*`, …) are not listed here** — they flow through `BuiltInKeyAction` in `shared/types/keymap.ts`. The public `ActionId` is `BuiltInActionId | (string & {})`; the open half is what lets plugins contribute namespaced ids without a core edit.

Renaming a built-in id is a **breaking change for every external MCP caller**, and the id is wired through the tier allowlists, the dedup set and the generated external manifest — change the title and the description instead, and reach for `deprecated` when an id genuinely has to go (#11549).

### Step 2: Create the Definition

In the appropriate file under `src/services/actions/definitions/`:

```typescript
// myFeatureActions.ts
import { z } from "zod";
import type { ActionCallbacks, ActionRegistry } from "../actionTypes";

export function registerMyFeatureActions(
  actions: ActionRegistry,
  callbacks: ActionCallbacks
): void {
  actions.set("myFeature.doThing", () => ({
    id: "myFeature.doThing",
    title: "Do Thing",
    // One imperative sentence, then any disambiguation, prohibition, or return
    // shape. Budgeted — see mcp-context-condensation.md before writing it.
    description: "Perform the thing operation on one target.",
    category: "myFeature",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["thing", "do"],
    argsSchema: z.object({
      targetId: z.string(),
      // A field whose meaning the name and type don't carry needs a describe();
      // one whose meaning they do carry needs none.
      force: z.boolean().optional().describe("Skip the readiness check."),
    }),
    // Enforced: dispatch() parses the return value through this.
    resultSchema: z.object({ success: z.boolean() }),
    run: async ({ targetId, force }) => {
      // args are already inferred from argsSchema — no cast needed.
      return { success: true };
    },
  }));
}
```

Two things to reach for rather than reinvent: `withWorktreeLocation` / `withProjectLocation` from `locationArgs.ts` when the action is worktree- or project-scoped (they give every tool the same selector vocabulary and resolve it in `run()`), and `withPagination` / `PaginatedResultSchema` from the same folder for list tools. Both are documented in [mcp-server.md](./mcp-server.md#tool-argument-and-result-conventions-11543).

### Step 3: Register in Aggregator

In `src/services/actions/actionDefinitions.ts`:

```typescript
import { registerMyFeatureActions } from "./definitions/myFeatureActions";

export function createActionDefinitions(
  callbacks: ActionCallbacks,
  actions?: ActionRegistry
): ActionRegistry {
  actions ??= new Map();
  // ... existing registrations ...
  registerMyFeatureActions(actions, callbacks);
  return actions;
}
```

The action is now available system-wide — via keybindings, menus, and the palette. It is **not** yet reachable over MCP: tier membership is a separate, deliberate edit to `shared/config/helpAssistantTierAllowlists.ts` (in-app tiers) or `shared/config/mcpExternalTierAllowlist.ts` (third-party clients), and the external roster is budget-capped. See [mcp-server.md](./mcp-server.md#tier-model-sharedts).

### Step 4: Run the quality gates

`npm run check` covers the typed wiring, but two suites are what actually police an action definition:

- `src/services/actions/__tests__/actionDefinitions.quality.test.ts` — description floor, no cross-references by action id, object-rooted input schemas for tier-exposed tools, and the `EXPECTED_CONFIRM_DANGER` set that pins which actions must carry `danger: "confirm"`. Adding a destructive action means updating that set **and** the audit table in [destructive-action-safeguards.md](./destructive-action-safeguards.md).
- `src/services/actions/__tests__/mcpWireBudget.test.ts` — the per-tool and aggregate byte ceilings.

## Observability

Every action dispatch emits an `action:dispatched` event to the main process:

```typescript
{
  actionId: "terminal.new",
  args: { /* redacted if sensitive */ },
  source: "user" | "keybinding" | "menu" | "agent" | "context-menu" | "plugin",
  context: { activeWorktreeId: "...", focusedTerminalId: "..." },
  timestamp: 1703001234567
}
```

### Sensitive Data Redaction

The service automatically redacts fields containing: `token`, `password`, `secret`, `key`, `auth`, `credential`. Large payloads (>1KB) are also truncated.

### Event Inspector

Use the Event Inspector (Developer Tools) to view action history in real-time.

## Action Categories

`category` is a free-form string on the definition; the live set is whatever the definitions declare. Today that is 26 values — grep `category: "` under `src/services/actions/definitions/` for the current list. The ones you will meet most:

| Category | Description | Example Actions |
| --- | --- | --- |
| `terminal` | Terminal/panel operations | `terminal.new`, `terminal.kill`, `terminal.focusNext` |
| `panel` | Panel registry and layout | `panel.list`, `panel.focus`, `panel.gridLayout.setStrategy` |
| `agent` | AI agent spawning | `agent.launch` |
| `worktree` | Git worktree management | `worktree.create`, `worktree.delete`, `worktree.refresh` |
| `project` | Project switching/config | `project.switch`, `project.add` |
| `forge` | Forge (issues/PRs) integration, provider-routed | `forge.openPR`, `forge.listPRs` |
| `git` | Git operations | `git.getProjectPulse`, `git.listCommits`, `git.push` |
| `recipes` | Recipe run and authoring handoffs | `recipe.run`, `recipe.editor.open` |
| `introspection` | The self-describing surface MCP clients read | `actions.list`, `actions.search`, `actions.getSchema` |
| `files` / `artifacts` / `copyTree` | File reads, artifact writes, context bundling | `artifact.applyPatch`, `copyTree.generateAndCopyFile` |
| `navigation` | UI navigation | `nav.toggleFocusMode` |
| `app` | Application settings | `app.settings.openTab`, `app.importConfig` |
| `preferences` / `settings` | User preferences | `preferences.showProjectPulse.set` |
| `browser` / `portal` | Browser panel and Portal browser control | `browser.reload`, `portal.openUrl` |
| `devServer` / `devPreview` | Dev-server lifecycle | `devPreview.restart` |
| `system` | System operations | `system.openExternal`, `system.checkCommand` |
| `logs` / `diagnostics` / `errors` | Log and diagnostics management | `logs.openFile`, `logs.clear` |
| `help` / `ui` / `voice` | Assistant, UI state, dictation | `help.displayImage` |

## FAQ

### How does the system prevent an AI agent from deleting my project?

Actions with `danger: "confirm"` require explicit confirmation. When `source === "agent"`:

```typescript
// This will return CONFIRMATION_REQUIRED error
await actionService.dispatch("worktree.delete", { worktreeId: "abc" }, { source: "agent" });

// Agent must explicitly confirm
await actionService.dispatch(
  "worktree.delete",
  { worktreeId: "abc" },
  {
    source: "agent",
    confirmed: true,
  }
);
```

The confirmation requirement forces the agent (or its orchestration layer) to explicitly acknowledge destructive actions.

### Where can I see a history of all actions performed?

1. **Event Inspector**: Open Developer Tools → Event Inspector tab
2. **Main Process Logs**: All dispatched actions are logged with timestamps
3. **Programmatically**: Subscribe to the event bus for `action:dispatched` events
4. **MCP audit log**: every tool call made against the manifest is recorded by `AuditService` — see [mcp-server.md](./mcp-server.md)

### How do I make an action conditional?

Use the `isEnabled` and `disabledReason` fields:

```typescript
actions.set("worktree.openPR", () => ({
  // ...
  isEnabled: (ctx) => {
    const worktree = getWorktree(ctx.activeWorktreeId);
    return !!worktree?.prUrl;
  },
  disabledReason: (ctx) => {
    const worktree = getWorktree(ctx.activeWorktreeId);
    return worktree?.prUrl ? undefined : "No pull request associated with this worktree";
  },
  // ...
}));
```

Disabled actions return a `DISABLED` error with the reason when dispatched.

## See also

- [mcp-server.md](./mcp-server.md) — the local MCP HTTP server whose tool surface _is_ this manifest: the tier model, per-tool grants, the confirm gate, and the `tools/call` pipeline that ends in `dispatch()`.
- [mcp-context-condensation.md](./mcp-context-condensation.md) — the authoring standard and CI budgets for the `description` prose and JSON Schemas an action ships to a model on every turn.
- [destructive-action-safeguards.md](./destructive-action-safeguards.md) — the D0–D3 rubric behind `danger`, the per-action confirm audit, and the direct-IPC bypasses that skip this layer entirely.
- [ipc-services.md](./ipc-services.md) — the `window.electron` layer most `run()` bodies call into.
- [`.claude/rules/actions-and-mcp.md`](../../.claude/rules/actions-and-mcp.md) — the abbreviated agent rule that loads when you touch an action definition.
