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

Actions expose themselves as an MCP-compatible manifest via `actionService.list()`. Each action includes:

- `name`: MCP-friendly identifier
- `inputSchema`: JSON Schema derived from Zod
- `danger`: Safety classification for agent guardrails

## Key Files

| File | Purpose |
| --- | --- |
| `shared/types/actions.ts` | Type definitions: `ActionId`, `ActionDefinition`, `ActionSource`, `ActionDanger` |
| `src/services/ActionService.ts` | Singleton registry and dispatcher |
| `src/services/actions/definitions/*.ts` | ~50 domain-specific definition files, grouped into ~28 domains by `actionDefinitions.ts` |
| `src/services/actions/actionDefinitions.ts` | Registration aggregator |
| `src/hooks/useActionRegistry.ts` | React hook that wires UI callbacks to the service |

## Action Definition Anatomy

Every action implements the `ActionDefinition` interface:

```typescript
// Abbreviated — see shared/types/actions.ts for the full interface.
interface ActionDefinition<S extends z.ZodTypeAny | undefined, Result> {
  id: ActionId; // Typed union: "terminal.new", "worktree.delete", etc.
  title: string; // Human-readable name
  description: string; // What this action does
  category: string; // Grouping: "terminal", "worktree", "git", etc.
  kind: ActionKind; // "command" | "query" — mutates vs. reads state
  danger: ActionDanger; // Safety level (see below)
  scope: ActionScope; // "renderer"
  argsSchema?: S; // Runtime validation schema (drives arg type inference)
  resultSchema?: z.ZodType<Result>; // Optional result schema
  isEnabled?: (ctx) => boolean; // Dynamic enable/disable (fails closed)
  isVisible?: (ctx) => boolean; // Discovery-layer visibility (fails open)
  disabledReason?: (ctx) => string | undefined;
  dangerRationale?: string; // Required when danger !== "safe"; surfaced in MCP consent
  run: (args: InferActionArgs<S>, ctx: ActionContext) => Promise<Result>;
  // MCP/AI surface: keywords, examples, mcpAnnotations, mcpVisibility,
  //   mcpOutputSchema, safeBreadcrumbArgs, nonRepeatable, ...
}
```

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

When `danger !== "safe"`, `dangerRationale` is required — it surfaces in the MCP host confirmation dialog so the user sees the same reasoning the model would.

## The Dispatch Flow

When `actionService.dispatch(actionId, args, options)` is called:

```
1. Lookup       → Find action in registry (or return NOT_FOUND)
2. Binding?     → If a contextOverride pins a projectId that no longer matches
                  live state → return BINDING_STALE (stale session guard)
3. Validation   → Parse args through Zod schema (or return VALIDATION_ERROR)
4. Enabled?     → Check isEnabled(context) (or return DISABLED)
5. Restricted?  → Block if danger === "restricted" (return RESTRICTED)
6. Confirm?     → If danger === "confirm" AND
                    (source === "plugin"  OR  (source === "agent" && !confirmed))
                  → Return CONFIRMATION_REQUIRED
                  Plugins are always confirm-gated — the `confirmed` flag is
                  ignored for plugin sources.
7. Execute      → Run the action handler (ctx carries dispatchSource for this run)
8. Emit Event   → Log action:dispatched to main process event bus
9. Return       → { ok: true, result } or { ok: false, error }
```

### Result Types

```typescript
type ActionDispatchResult<T> = { ok: true; result: T } | { ok: false; error: ActionError };

interface ActionError {
  code: ActionErrorCode; // NOT_FOUND, VALIDATION_ERROR, DISABLED, etc.
  message: string;
  details?: unknown;
}
```

## Context Injection

Actions receive an `ActionContext` that provides current state:

```typescript
interface ActionContext {
  projectId?: string;
  activeWorktreeId?: string;
  focusedTerminalId?: string;
  isTerminalPaletteOpen?: boolean;
  isSettingsOpen?: boolean;
}
```

The context is injected via `actionService.setContextProvider()` in `App.tsx`, ensuring actions always have access to current UI state without prop drilling.

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

In `shared/types/actions.ts`, add to the `ActionId` union:

```typescript
export type ActionId =
  | KeyAction
  // ... existing IDs ...
  | "myFeature.doThing"; // Add your new ID
```

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
    description: "Performs the thing operation",
    category: "myFeature",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      targetId: z.string(),
      force: z.boolean().optional(),
    }),
    run: async (args) => {
      const { targetId, force } = args as { targetId: string; force?: boolean };
      // Implementation here
      return { success: true };
    },
  }));
}
```

### Step 3: Register in Aggregator

In `src/services/actions/actionDefinitions.ts`:

```typescript
import { registerMyFeatureActions } from "./definitions/myFeatureActions";

export function createActionDefinitions(callbacks: ActionCallbacks): ActionRegistry {
  const actions: ActionRegistry = new Map();
  // ... existing registrations ...
  registerMyFeatureActions(actions, callbacks);
  return actions;
}
```

The action is now available system-wide—via keybindings, menus, and AI agents.

## Observability

Every action dispatch emits an `action:dispatched` event to the main process:

```typescript
{
  actionId: "terminal.new",
  args: { /* redacted if sensitive */ },
  source: "user" | "keybinding" | "menu" | "agent" | "context-menu",
  context: { activeWorktreeId: "...", focusedTerminalId: "..." },
  timestamp: 1703001234567
}
```

### Sensitive Data Redaction

The service automatically redacts fields containing: `token`, `password`, `secret`, `key`, `auth`, `credential`. Large payloads (>1KB) are also truncated.

### Event Inspector

Use the Event Inspector (Developer Tools) to view action history in real-time.

## Action Categories

| Category | Description | Example Actions |
| --- | --- | --- |
| `terminal` | Terminal/panel operations | `terminal.new`, `terminal.kill`, `terminal.focusNext` |
| `agent` | AI agent spawning | `agent.launch` |
| `worktree` | Git worktree management | `worktree.create`, `worktree.delete`, `worktree.refresh` |
| `project` | Project switching/config | `project.switch`, `project.add` |
| `forge` | Forge (issues/PRs) integration, provider-routed | `forge.openPR`, `forge.listPRs` |
| `git` | Git operations | `git.getProjectPulse`, `git.listCommits` |
| `navigation` | UI navigation | `nav.toggleFocusMode` |
| `app` | Application settings | `app.settings.openTab` |
| `preferences` | User preferences | `preferences.showProjectPulse.set` |
| `browser` | Browser panel control | `browser.reload`, `browser.navigate` |
| `system` | System operations | `system.openExternal`, `system.checkCommand` |
| `logs` | Log management | `logs.openFile`, `logs.clear` |
| `portal` | Portal browser | `portal.toggle`, `portal.openUrl` |

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
