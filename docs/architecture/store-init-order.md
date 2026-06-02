# Cross-Store Accessor Module and Renderer Init Order

This document describes how renderer store modules read each other's state without forming ESM import cycles. Cross-store reads route through a single dependency-free leaf module (`src/store/storeAccessors.ts`), and the live closures are registered inside `initStoreOrchestrator()` rather than at module-evaluation time. This pattern is **load-bearing**—changing it back to module-bottom setter injection will re-introduce the TDZ and silent-failure classes documented below.

## Why This Matters

Renderer stores in Daintree are independent Zustand `create()` calls. Several stores (`panelStore`, `projectStore`, `worktreeStore`, `fleetArmingStore`) need to read each other in narrow places—e.g., `projectStore.buildOutgoingState()` snapshots panel state during a project switch, and `worktreeStore.applyWorktreeTerminalPolicy()` reads the fleet-armed set to keep cross-worktree terminals visible while fleet scope is active.

Direct top-level imports between any pair of these stores form an ESM cycle. Cycles produce two failure modes:

1. **TDZ crash on boot.** `ReferenceError: Cannot access 'X' before initialization` when a module references a non-hoisted binding (`let`/`const`/`class`) from a partner that has started evaluating but not finished.
2. **Silent stale-state failure.** If the cycle is "patched" with a getter that defaults to `null`, an inverted evaluation order leaves the closure unset—and call sites like `buildOutgoingState()` quietly return incomplete data instead of crashing.

The accessor-module pattern eliminates both classes by routing all cross-store references through a leaf module that imports no other store module, and by deferring closure registration to a single explicit init point.

## Architecture

### Leaf accessor module (`src/store/storeAccessors.ts`)

Holds seven mutable getter/callback slots and a paired reader for each. It imports no other store module—only a shared type (`TabGroup`) and a panel-registry selector used to derive the `PanelStoreSnapshot` carrier type—so it cannot participate in a store cycle. Stores import from this leaf unidirectionally:

```typescript
// imports elided (TabGroup type, panel-registry selector for the carrier type)
let _getPanelStoreState: (() => PanelStoreSnapshot) | null = null;

export function setPanelStoreAccessor(getter: () => PanelStoreSnapshot): void {
  _getPanelStoreState = getter;
}

export function getPanelStoreSnapshot(): PanelStoreSnapshot | null {
  return _getPanelStoreState?.() ?? null;
}
```

### Registration in `initStoreOrchestrator()`

`rendererStoreOrchestrator.ts` already owns all cross-store subscriptions and lifecycle. It is the only place that registers accessor closures, and it registers them **before** the idempotency guard so test `destroyStoreOrchestrator()` + re-init reconnects fresh closures to the current store singletons:

```typescript
export function initStoreOrchestrator(): () => void {
  setPanelStoreAccessor(() => {
    const s = usePanelStore.getState();
    return { panelsById: s.panelsById, panelIds: s.panelIds, tabGroups: s.tabGroups };
  });
  // ...other accessors...

  if (cleanupFn) return cleanupFn;
  // ...subscriptions...
}
```

Closures always call `store.getState()` inside the body—they never capture a snapshot at registration time. This preserves the stale-closure-safety rule from lesson #5087.

### Consumer call sites

Stores call the readers directly and tolerate the null fallback (the accessors return `null` before the orchestrator has run, e.g., in unit tests that import a store standalone):

```typescript
const terminalState = getPanelStoreSnapshot();
if (!terminalState) {
  return { draftInputs, activeWorktreeId };
}
```

## Accessor Slots

| Slot | Reader | Setter | Consumer |
| --- | --- | --- | --- |
| Panel snapshot | `getPanelStoreSnapshot()` | `setPanelStoreAccessor()` | `projectStore.buildOutgoingState()` |
| Worktree selection | `getWorktreeSelectionSnapshot()` | `setWorktreeSelectionAccessor()` | `projectStore.buildOutgoingState()` |
| Worktree id set | `getWorktreeIdSet()` | `setWorktreeIdSetAccessor()` | `projectStore.buildOutgoingState()` |
| Panel store clear-for-switch | `clearPanelStoreForSwitchThroughAccessor()` | `setPanelStoreClearForSwitchAccessor()` | `projectStore.switchProject()` |
| Fleet arming clear | `clearFleetArmingThroughAccessor()` | `setFleetArmingClearAccessor()` | `projectStore.switchProject()` |
| Fleet armed ids | `getFleetArmedIds()` | `setFleetArmedIdsAccessor()` | `worktreeStore.applyWorktreeTerminalPolicy()` |
| Fleet last armed id | `getFleetLastArmedId()` | `setFleetLastArmedIdAccessor()` | `worktreeStore.exitFleetScope()` |

`panelPersistence.setProjectIdGetter()` is **not** in the accessor module—it is a one-directional optional dep (`panelPersistence` depends on `projectStore`, never the reverse), so a direct call at the bottom of `projectStore.ts` is load-order-safe and stays there. The accessor module is reserved for slots that previously caused cycles.

## Rules for New Store Authors

**DO:**

- Read cross-store state through `storeAccessors.ts` when there is any risk of a cycle.
- Tolerate `null` returns from accessor readers—the orchestrator may not have run yet in test contexts.
- Add new accessor slots to `storeAccessors.ts` rather than re-introducing module-bottom setter injection.
- Register the accessor closure inside `initStoreOrchestrator()` before the idempotency guard, calling `store.getState()` inside the closure body.

**DON'T:**

- Call lazy accessor readers at module top level. They will be `null` during module evaluation.
- Add module-bottom side effects (`setXxxGetter(...)`, `store.subscribe(...)`) for cross-store wiring. The orchestrator owns lifecycle.
- Add module-scope `store.subscribe()` calls for cross-store reactions. Use the orchestrator's `DisposableStore` instead (lesson #4754).
- Assume singletons span renderer contexts (each `WebContentsView` evaluates modules independently).

**Red Flags:**

- `ReferenceError: Cannot access 'X' before initialization` — you re-introduced a direct cycle.
- Test mocks needing to stub `setXxxGetter` exports on `projectStore`/`worktreeStore` — those exports are gone; mock the accessor reader instead, or call the setter from the accessor module directly.

## Multi-Renderer Context

Each `WebContentsView` has an independent V8 context due to Site Isolation. Module-level singletons—including the accessor slots—**do not span contexts**. Each renderer runs `initStoreOrchestrator()` independently as part of `src/main.tsx` boot, populating its own accessor slots. State mutations in view A do not automatically update view B; cross-view sync must use Main process IPC.

## When This Breaks

**Renderer crash on boot:**

```
ReferenceError: Cannot access 'usePanelStore' before initialization
```

Caused by directly importing `usePanelStore` at module level in a cyclic dependency graph. Fix by reading through `storeAccessors.ts`.

**Silent failure in `buildOutgoingState()`:**

```typescript
const terminalState = getPanelStoreSnapshot();
if (!terminalState) {
  return { draftInputs, activeWorktreeId }; // Incomplete state
}
```

The accessor was never set because `initStoreOrchestrator()` did not run. In production this only happens if the renderer entry stops calling the orchestrator; in tests it is the normal path when a store is imported in isolation. To return the slots to that unset state between a `destroyStoreOrchestrator()` and a fresh re-init, use the canonical `resetStoreAccessorsForTesting()` hook (`storeAccessors.ts`)—`destroyStoreOrchestrator()` already calls it (`rendererStoreOrchestrator.ts`). Never null the module-scope slots by hand.

**Stale closures in async callbacks:**

```typescript
// WRONG — captures state at callback creation
const stale = usePanelStore.getState();
document.startViewTransition(() => {
  console.log(stale.panelsById); // Stale!
});

// CORRECT — call getState() inside the callback
document.startViewTransition(() => {
  console.log(usePanelStore.getState().panelsById); // Fresh
});
```

`document.startViewTransition()` is asynchronous—it waits for the current frame before invoking the callback. Any Zustand state captured into a closure before that point is stale. The same rule applies to the accessor closures inside `initStoreOrchestrator()`: always read state inside the closure body, never at registration time.
