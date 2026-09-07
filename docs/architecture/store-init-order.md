# Cross-Store Accessor Module and Renderer Init Order

This document describes how renderer store modules read each other's state without crashing on boot or returning stale data. The safety rule is mechanistic: a store may never dereference a partner store's binding at **module-evaluation time**—reads must happen inside function bodies that run after the ESM live bindings have resolved. Most cross-store reads satisfy this by routing through a single dependency-free leaf module (`src/store/storeAccessors.ts`) whose live closures are registered inside `initStoreOrchestrator()` rather than at module-evaluation time. One sanctioned pair (`panelStore` ↔ `worktreeStore`) instead imports each other directly because both honour the same eval-time rule; see "Sanctioned exception" below. This pattern is **load-bearing**—violating the eval-time rule (e.g. reverting to module-bottom setter injection, or reading a partner's state during `create()`) re-introduces the TDZ and silent-failure classes documented below.

## Why This Matters

Renderer stores in Daintree are independent Zustand `create()` calls. Several stores (`panelStore`, `projectStore`, `worktreeStore`, `fleetArmingStore`) need to read each other in narrow places—e.g., `projectStore.buildOutgoingState()` snapshots panel state during a project switch, and `worktreeStore.applyWorktreeTerminalPolicy()` reads the fleet-armed set to keep cross-worktree terminals visible while fleet scope is active.

A direct top-level import between a pair of these stores forms an ESM cycle, but the cycle is **not** the hazard by itself. The hazard is **dereferencing a partner store's binding while modules are still evaluating**. ESM live bindings are not resolved until both modules in a cycle have finished evaluating, so the rule is precise:

> A direct static import between two stores is safe **if and only if** neither store reads the partner's binding at module-evaluation time—every read happens inside a function body that runs later (an action, a selector, a closure registered at init), after both modules have finished evaluating.

Violating that rule produces two failure modes:

1. **TDZ crash on boot.** `ReferenceError: Cannot access 'X' before initialization` when a module references a non-hoisted binding (`let`/`const`/`class`) from a partner that has started evaluating but not finished—e.g. reading the partner inside top-level code or inside a `create()` initializer that runs during evaluation.
2. **Silent stale-state failure.** If a cycle is "patched" with a getter that defaults to `null`, an inverted evaluation order leaves the closure unset—and call sites like `buildOutgoingState()` quietly return incomplete data instead of crashing.

Two mechanisms keep cross-store reads on the safe side of that rule. The accessor-module pattern routes references through a leaf module that imports no other store module and defers closure registration to a single explicit init point—this is required whenever an eval-time read is otherwise unavoidable (notably during persisted-store hydration, which runs at evaluation time) and is the default for any store pair that has not earned a direct-import carve-out backed by its own regression gate. Exactly one pair has earned that carve-out today: the sanctioned `panelStore` ↔ `worktreeStore` direct import relies on every cross-store read living inside a function body; see the next section for the conditions a future pair would have to meet.

## Sanctioned exception: `panelStore` ↔ `worktreeStore`

PR #8402 deliberately introduced a mutual **static** import between these two stores: `worktreeStore.ts` imports `usePanelStore` from `@/store/panelStore`, and `panelStore.ts` imports `useWorktreeSelectionStore` from `./worktreeStore`. This is a genuine ESM cycle, and it is safe—because both stores honour the eval-time rule above. Every cross-store read sits inside a function body and reaches the partner through `getState()`/`setState()` (e.g. `worktreeStore.applyWorktreeTerminalPolicy()` reads `usePanelStore.getState()`, and `panelStore`'s `getActiveWorktreeId` closure reads `useWorktreeSelectionStore.getState()`). What matters is _when_ the binding is dereferenced, not where it is written: neither store _calls_ the partner's binding while modules are evaluating—not in top-level code, and not in the code path of its `create()` initializer. A closure defined inside `create()` that merely captures the partner binding (like `getActiveWorktreeId`) is fine, because it is invoked later. Because no eval-time dereference exists, the live bindings always resolve before any action runs, in either evaluation order.

The regression gate is `src/store/__tests__/worktreeStore.circularInit.test.ts`. It enters the cold module graph from both entry orders (`panelStore` first, then `worktreeStore` first) and via the `panelRegistrySlice` cold-graph entry point, then reads each store's state—which forces its zustand state-creator to have run during evaluation—and asserts none of those reads throw (a TDZ/circular-eval failure would surface there). A fourth case calls `selectWorktree()` (which runs `applyWorktreeTerminalPolicy()`, the synchronous `usePanelStore.getState()` consumer) from a cold graph and asserts it does not throw. The two stores themselves are never mocked; their dependencies are stubbed, including service-layer modules like `TerminalInstanceService` that statically import `panelStore`—stubbing them keeps the cycle under test to just the two stores rather than a wider service graph. If any entry order ever throws, the direct-import approach has become unsafe and the read must move back behind `storeAccessors.ts`.

This carve-out is scoped to this one pair. Other cross-store references still route through the accessor module—`worktreeStore.applyWorktreeTerminalPolicy()` reads the fleet-armed set via `getFleetArmedIds()` (worktreeStore.ts), not a direct `fleetArmingStore` import—so adding a new direct store↔store import is not licensed by this exception. A new pair earns a direct import only with its own equivalent cold-graph regression gate.

## Architecture

### Leaf accessor module (`src/store/storeAccessors.ts`)

Holds eleven mutable getter/callback slots and a paired reader for each. It imports no other store module—only shared types and a panel-registry selector used to derive the `PanelStoreSnapshot` carrier type—so it cannot participate in a store cycle. Stores import from this leaf unidirectionally:

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

| Slot | Reader | Setter |
| --- | --- | --- |
| Panel snapshot | `getPanelStoreSnapshot()` | `setPanelStoreAccessor()` |
| Worktree selection | `getWorktreeSelectionSnapshot()` | `setWorktreeSelectionAccessor()` |
| Worktree id set | `getWorktreeIdSet()` | `setWorktreeIdSetAccessor()` |
| Worktree git dir by id | `getWorktreeGitDirById()` | `setWorktreeGitDirAccessor()` |
| Worktree path index | `getWorktreePathIndex()` | `setWorktreePathIndexAccessor()` |
| Project path index | `getProjectPathIndex()` | `setProjectPathIndexAccessor()` |
| Panel extension state | `persistPanelExtensionStateThroughAccessor()` | `setPanelExtensionStateAccessor()` |
| Panel store clear-for-switch | `clearPanelStoreForSwitchThroughAccessor()` | `setPanelStoreClearForSwitchAccessor()` |
| Fleet arming clear | `clearFleetArmingThroughAccessor()` | `setFleetArmingClearAccessor()` |
| Fleet armed ids | `getFleetArmedIds()` | `setFleetArmedIdsAccessor()` |
| Fleet last armed id | `getFleetLastArmedId()` | `setFleetLastArmedIdAccessor()` |

`storeAccessors.ts` is the source of truth for this list — the consumers move around more than the slots do, so read the call sites from the file rather than from a column here. The historical anchors: `projectStore.buildOutgoingState()` reads the panel/worktree snapshots during a project switch, `projectStore.switchProject()` fires the two clear callbacks, and `worktreeStore.applyWorktreeTerminalPolicy()` / `exitFleetScope()` read the fleet slots.

`panelPersistence.setProjectIdGetter()` is **not** in the accessor module—it is a one-directional optional dep (`panelPersistence` depends on `projectStore`, never the reverse), so a direct call at the bottom of `projectStore.ts` is load-order-safe and stays there. The accessor module is reserved for slots that previously caused cycles.

## Rules for New Store Authors

**DO:**

- Read cross-store state through `storeAccessors.ts` when there is any risk of a cycle.
- Tolerate `null` returns from accessor readers—the orchestrator may not have run yet in test contexts.
- Add new accessor slots to `storeAccessors.ts` rather than re-introducing module-bottom setter injection.
- Register the accessor closure inside `initStoreOrchestrator()` before the idempotency guard, calling `store.getState()` inside the closure body.

**DON'T:**

- Dereference a partner store's binding at module-evaluation time—in top-level code, or inside a `create()` initializer that runs during evaluation. This, not the static import statement, is what causes the TDZ crash. (A static import whose reads all live inside later-running function bodies is fine; that is exactly the sanctioned `panelStore` ↔ `worktreeStore` pair.)
- Add a new direct store↔store import on the strength of the `panelStore` ↔ `worktreeStore` carve-out. Route the read through `storeAccessors.ts` unless you ship an equivalent cold-graph regression gate proving both evaluation orders are init-safe.
- Call lazy accessor readers at module top level. They will be `null` during module evaluation.
- Add module-bottom side effects (`setXxxGetter(...)`, `store.subscribe(...)`) for cross-store wiring. The orchestrator owns lifecycle.
- Add module-scope `store.subscribe()` calls for cross-store reactions. Use the orchestrator's `DisposableStore` instead (lesson #4754).
- Assume singletons span renderer contexts (each `WebContentsView` evaluates modules independently).

**Red Flags:**

- `ReferenceError: Cannot access 'X' before initialization` — you dereferenced a partner store's binding at module-evaluation time (top-level code or a `create()` initializer). The fix is to move the read into a later-running function body, or behind `storeAccessors.ts`—not necessarily to delete the import.
- Test mocks needing to stub `setXxxGetter` exports on `projectStore`/`worktreeStore` — those exports are gone; mock the accessor reader instead, or call the setter from the accessor module directly.

## Related

- [state-management.md](./state-management.md) — the store layer this ordering protects: the two store flavors, the panel-listener subsystem, and the two persistence paths.
- [process-and-window-model.md](./process-and-window-model.md) — the per-view V8 topology that makes "module-level singleton" mean something narrower than it looks.

## Multi-Renderer Context

Each `WebContentsView` has an independent V8 context due to Site Isolation. Module-level singletons—including the accessor slots—**do not span contexts**. Each renderer runs `initStoreOrchestrator()` independently as part of `src/main.tsx` boot, populating its own accessor slots. State mutations in view A do not automatically update view B; cross-view sync must use Main process IPC.

## When This Breaks

**Renderer crash on boot:**

```
ReferenceError: Cannot access 'usePanelStore' before initialization
```

Caused by reading a partner store's binding (here `usePanelStore`) **at module-evaluation time** in a cyclic dependency graph—top-level module code, or a `create()` initializer that runs during evaluation, executing before the partner module has finished evaluating. The static import statement itself is not the cause: the sanctioned `panelStore` ↔ `worktreeStore` pair imports each other directly and never crashes, because every read sits inside a later-running function body. Fix by moving the read into a function body that runs after init, or—if an eval-time read is genuinely unavoidable (e.g. during hydration)—route it through `storeAccessors.ts`.

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
