# Store Module Init Order and Lazy-Getter Invariants

This document describes why some renderer store modules intentionally avoid direct cross-store imports at module-evaluation time. The lazy-getter injection patterns that break circular dependencies are **load-bearing**—removing or changing them will crash the renderer at boot. Optional lazy dependency patterns (e.g., `panelPersistence`) fail silently when unset.

## Why This Matters

Renderer stores in Daintree use lazy getter injection to break circular dependencies that would cause Temporal Dead Zone (TDZ) errors at module initialization time. When a direct import cycle exists between ES modules (e.g., `projectStore.ts` imports `panelStore.ts` which imports back), accessing non-hoisted exports (`let`/`const`) before they're initialized throws `ReferenceError: Cannot access 'X' before initialization`. The renderer crashes before any UI appears, making these errors notoriously hard to debug.

The lazy getter pattern allows stores to reference each other **after** both modules finish evaluation by deferring the actual store lookup to a function closure. The setter is called at module-init time, but the closure is invoked later during runtime operations.

## Current Lazy Injection Sites

| Source Module                     | Target Module            | Injection Type      | Setter Call                | Purpose                                                               |
| --------------------------------- | ------------------------ | ------------------- | -------------------------- | --------------------------------------------------------------------- |
| `projectStore.ts`                 | `panelStore.ts`          | Circular dependency | `panelStore.ts:524-529`    | Snapshot persistable panel state synchronously before project switch  |
| `projectStore.ts`                 | `worktreeSelectionStore` | Circular dependency | `worktreeStore.ts:537-538` | Capture active worktree ID during project switch                      |
| `persistence/panelPersistence.ts` | `projectStore.ts`        | Optional lazy dep   | `projectStore.ts:636`      | Provide project ID getter for persistence operations (fails silently) |

## How It Works

Setter functions are hoisted and available during module evaluation. The actual store lookup happens **inside** the closure, after both modules finish initialization.

```typescript
// In consuming module (e.g., projectStore.ts)
let _getPanelStoreState:
  | (() => {
      panelsById: Record<string, TerminalInstance>;
      panelIds: string[];
      tabGroups: Map<string, TabGroup>;
    })
  | null = null;

export function setPanelStoreGetter(
  getter: () => {
    panelsById: Record<string, TerminalInstance>;
    panelIds: string[];
    tabGroups: Map<string, TabGroup>;
  }
): void {
  _getPanelStoreState = getter;
}

// Use in actions
const terminalState = _getPanelStoreState?.();
if (!terminalState) return;
```

```typescript
// In source module (e.g., panelStore.ts) — call at module BOTTOM
import { setPanelStoreGetter } from "./projectStore";

setPanelStoreGetter(() => {
  const s = usePanelStore.getState();
  return { panelsById: s.panelsById, panelIds: s.panelIds, tabGroups: s.tabGroups };
});
```

This works because:

1. `setPanelStoreGetter` is a function, which is hoisted and available during circular dependency resolution
2. The store reference (`usePanelStore.getState()`) is only resolved **inside** the closure when invoked during runtime operations, after both modules have finished evaluating
3. No top-level dereference happens during module init, so no TDZ error occurs

## Rules for New Store Authors

**DO:**

- Keep cross-store reads inside functions/callbacks, never at module top level
- Call injection setters at module bottom, after `create()` returns
- Tolerate getter absence with null-safe checks (e.g., `_getPanelStoreState?.()`)
- Use `getState()` **inside** async callbacks, not captured in closures

**DON'T:**

- Add top-level reads of imported store state in cyclic dependency graphs
- Call lazy getters during module evaluation (they will be unset)
- Assume singletons span renderer contexts (each view has independent stores)

**Red Flags:**

- `ReferenceError: Cannot access 'X' before initialization` — you have a direct import cycle
- Cyclic dependency warnings from TypeScript or bundlers
- `getState is not a function` — you tried to call a getter that was never set

## Decision Tree for Cross-Store Access

```
I want store A to use store B. What do I do?

├─ Is there a direct import cycle? (A imports B, B imports A)
│  └─ YES → Add a module-level setter/getter pair and register at module bottom
├─ Does store A need to read store B during module initialization?
│  └─ YES → Lazy getter injection
├─ Does store A only need store B from action/event handlers?
│  └─ YES → Direct import is acceptable (if no cycle)
└─ Does store A need store B only in async code paths?
   └─ YES → Consider dynamic `import()` inside the async function
```

## Multi-Renderer Context

Each `WebContentsView` has an independent V8 context due to Site Isolation. Module-level singletons **do not span contexts** — each renderer evaluates modules independently.

If you register a getter in project view A, it does **not** exist in project view B. Each renderer runs `setPanelStoreGetter()` independently when it loads. State mutations in view A do not automatically update view B; cross-view sync must use Main process IPC.

## When This Breaks

**Renderer crash on boot:**

```
ReferenceError: Cannot access 'usePanelStore' before initialization
```

Caused by directly importing `usePanelStore` at module level in a cyclic dependency graph.

**Silent failure in `buildOutgoingState()`:**

```typescript
const terminalState = _getPanelStoreState?.();
if (!terminalState) return { draftInputs, activeWorktreeId }; // Incomplete state
```

The getter was never set (setter not called at module bottom, or called in wrong order), so `buildOutgoingState()` returns incomplete outgoing state and panel data is lost during project switch.

**Stale closures in async callbacks:**

```typescript
// WRONG — captures state at callback creation
const stale = usePanelStore.getState();
document.startViewTransition(() => {
  console.log(stale.panelsById); // Stale!
});

// CORRECT — captures getState(), calls it when needed
const getState = usePanelStore.getState;
document.startViewTransition(() => {
  console.log(getState().panelsById); // Fresh
});
```

`document.startViewTransition()` is asynchronous — it waits for the current frame to finish before invoking the callback. Any Zustand state accessed via closure formed before the call is stale.
