# Renderer state management & the store layer

The renderer's state lives in `src/store/` — ~100 top-level store modules plus ~40 supporting files (slices, listeners, persistence). Almost all of it is Zustand. This doc explains the two store flavors, why the distinction is load-bearing for multi-window correctness, the panel-listener and persistence subsystems, and how to add a new store. It does **not** re-derive the cross-store ESM init ordering — that lives in [store-init-order.md](./store-init-order.md).

`src/store/index.ts` is the barrel and the canonical inventory of what the rest of the app consumes. When this doc and `index.ts` disagree, `index.ts` wins.

## The two store flavors

Daintree has exactly two ways to make a store, and choosing wrong is a correctness bug, not a style choice.

| Flavor | Constructor | Scope | Accessed via | Count |
| --- | --- | --- | --- | --- |
| **App-global React store** | `create()` (`zustand`) | One singleton per V8 context | `useFooStore` hook / `useFooStore.getState()` | ~90 |
| **Per-view vanilla store** | `createStore()` (`zustand/vanilla`) | One instance per `WebContentsView` | React Context + a module-level accessor | 2 |

### App-global stores — `create()`

The overwhelming majority. A module like `preferencesStore.ts` calls `create<State>()(...)` once and exports a `useFooStore` hook. Because each project's `WebContentsView` runs in its own V8 context (see the multi-window model below), "global singleton" means _global within that view's context_ — two project views never share a `create()` store instance; they each evaluate the module fresh. So app-global is the right default for state that is conceptually per-window: panel grid, focus, settings, notifications, diagnostics.

### Per-view vanilla stores — `createStore()`

Only two stores use `zustand/vanilla`:

- **`createWorktreeStore.ts`** — the worktree snapshot map for the active project. This is a _factory_, not a singleton: `WorktreeStoreProvider` (`src/contexts/WorktreeStoreContext.tsx`) calls `createWorktreeStore()` once per mount and holds the instance in React state, then publishes it for non-React callers via `setCurrentViewStore(store)`.
- **`shortcutHintStore.ts`** — a small vanilla store for the same reason (no React-hook coupling for non-component readers).

Why vanilla here? The worktree store is fed by a dedicated `MessagePort` (`worktreePort`) that is itself per-view. A `create()` singleton would be fine for the _instance_, but the worktree store is deliberately modeled as a value that is **created, swapped, and torn down with the view's provider**, and consumed by a large amount of non-React code (action definitions, `notify()` gating, identity listeners). The factory + accessor shape makes that lifecycle explicit and lets tests create a throwaway instance without touching a module singleton.

Non-React code reaches the live instance through `createWorktreeStore.ts`:

```ts
getCurrentViewStore(); // throws if called before WorktreeStoreProvider mounts
getCurrentViewStoreOrNull(); // null-returning variant for callers that can run early
```

Use `…OrNull()` from anything that can run during initial render or the action-manifest listing (e.g. `listeners/panel/identity.ts` reads `changedFileCount` through it and tolerates a null store).

**The rule:** if the state is conceptually owned by _one project view_ and is driven by that view's port/lifecycle, it is a per-view vanilla store. Everything else is an app-global `create()` store. Getting this wrong (e.g. putting worktree snapshots in a `create()` singleton) would leak one project's data into another's `WebContentsView` — the failure mode the vanilla flavor exists to prevent. See [process-and-window-model.md](./process-and-window-model.md) for the view/context topology.

## Store inventory (categorized)

`src/store/index.ts` is the source of truth; this is a map of the major clusters, not an exhaustive list. ~110 files end in `Store.ts`.

| Cluster | Representative stores | Notes |
| --- | --- | --- |
| **Panel / terminal** | `panelStore`, `terminalInputStore`, `terminalFontStore`, `terminalColorSchemeStore`, `scrollbackStore`, `terminalSearchHistoryStore`, `dockStore`, `twoPaneSplitStore`, `panelLimitStore` | `panelStore` is the big one — composed from slices (below). |
| **Worktree** | `createWorktreeStore` (per-view), `worktreeStore` (selection/MRU), `worktreeFilterStore`, `worktreeDevServerStore` | `worktreeStore` exports `useWorktreeSelectionStore` — selection is app-global; the snapshot map is per-view. |
| **Project** | `projectStore`, `projectSettingsStore`, `projectPresetsStore`, `projectStatsStore`, `cachedProjectViewsStore`, `distributionStore` | Stores reset on project switch; outgoing state is snapshotted via the accessor pattern. |
| **Fleet** | `fleetArmingStore`, `fleetScopeFlagStore`, `fleetBroadcastProgressStore`, `fleetFailureStore`, `fleetTargetOverridesStore`, `fleetPickerSessionStore`, `fleetResolutionPreviewStore`, `fleetPendingActionStore`, plus `fleetEligibility.ts` (pure helpers) | Large cluster by file count (~9). |
| **Notification** | `notificationStore`, `notificationSettingsStore`, `slices/notificationHistorySlice` | See "Slices vs standalone stores" — the "slice" here is actually a standalone store. |
| **Diagnostics / logs / errors** | `diagnosticsStore`, `diagnosticsReviewStore`, `logsStore`, `errorStore`, `eventStore`, `consoleCaptureStore`, `telemetryPreviewStore` | `errorStore` is the UI surface for service-thrown errors. |
| **Settings / preferences** | `settingsStore`, `preferencesStore`, `agentSettingsStore`, `agentPreferencesStore`, `toolbarPreferencesStore`, `actionPrefsStore`, `notificationSettingsStore`, `memoryLeakConfigStore` | Most localStorage-persisted stores live here. |
| **Resource / perf** | `resourceMonitoringStore`, `resourceProfileStore`, `perfMetricsStore`, `performanceModeStore`, `systemWakeStore` | Fed by main-process resource telemetry. |
| **UI / focus / palette** | `uiStore`, `focusStore`, `macroFocusStore`, `paletteStore`, `actionMruStore`, `shortcutHintStore` (vanilla), `accessibilityAnnouncerStore`, `screenReaderStore` | Focus arbitration spans several stores. |
| **Confirm/guard dialogs** | `gitPushConfirmStore`, `gitPullRebaseConfirmStore`, `mcpConfirmStore`, `pluginConfirmStore`, `restoreConfirmationStore`, `terminalPendingDestructiveActionStore`, `safeModeStore` | One small store per destructive-action confirm surface. |

## panelStore composition (slices)

`panelStore.ts` is built by composing slice creators inside a single `create()` call, wrapped in `subscribeWithSelector` middleware. The slices live in `src/store/slices/` and are barrelled through `slices/index.ts`:

- `createPanelRegistrySlice` — `panelsById`, `panelIds`, `tabGroups`, grid/dock/background/trash lifecycle. This is itself a ~17-file subsystem under `slices/panelRegistry/` (`core`, `addPanel`, `layout`, `ordering`, `tabGroups`, `trash`, `worktreeIndex`, `persistence`, `selectors`, …). `panelRegistrySlice.ts` is a thin re-export shim for backward compatibility.
- `createTerminalFocusSlice` — focus + directional navigation.
- `createTerminalMruSlice` — global terminal MRU list (`mruList`, `recordMru`).
- `createTerminalCommandQueueSlice` — per-terminal queued commands + `isAgentReady`.
- `createTerminalBulkActionsSlice` — fleet/bulk restart and validation.
- `createWatchedPanelsSlice` — the `watchedPanels: Set<string>` watch list.

`MAX_GRID_TERMINALS` is exported from `panelRegistrySlice` and re-exported by `index.ts`.

### Slices vs standalone stores

A **slice** belongs on a host store when its state must mutate atomically with that store's other state and shares the host's `set`/`get` (e.g. focus must move in the same tick a panel is removed → `terminalFocusSlice` lives on `panelStore`). Slices have no independent persistence or lifecycle.

A **standalone store** is correct when the state has its own lifecycle, persistence, or consumers independent of any host store. The naming is historically inconsistent: `slices/notificationHistorySlice.ts` is named "slice" but is actually its own `create()` store (`useNotificationHistoryStore`) with its own debounced localStorage persistence — it is consumed by both `notificationStore` and `uiStore`, so it cannot be a slice of either. Treat the file _name_ as legacy; the `create()` call is the truth. `actionMruSlice`/`actionPrefsSlice` are also exported as both composable slices and backed by standalone `actionMruStore`/`actionPrefsStore`.

## The panel-listener subsystem

Live IPC → store reducers for panel/terminal state run through `panelStoreListeners.ts` and the `src/store/listeners/panel/` reducers (~9 modules). They are bootstrapped once at app start by `usePanelStoreBootstrap.ts` calling `setupTerminalStoreListeners()`.

`setupTerminalStoreListeners()` is **idempotent** (early-returns if the module-level `DisposableStore` is already set), registers each reducer's disposable, and owns the shared status buffer's teardown. It is the single HMR accept boundary — the `listeners/panel/*` sub-modules deliberately have **no** HMR accept blocks so edits propagate up to this one coordinator.

| Reducer | Subscribes to | Writes |
| --- | --- | --- |
| `identity.ts` | `onAgentStateChanged`, `onAgentDetected`, `onAgentExited` | `panelStore.updateAgentState` + identity fields (via `identityReducer.ts`); fires review-inbox notify. **Writes direct, not buffered** — `processQueue` reads live state on the same tick. |
| `lifecycle.ts` | terminal status / exit / fallback events | runtime status (via `enqueueFlowStatusUpdate`), fallback-activation, resource-metrics pruning |
| `activity.ts` | `onActivity` | enqueues activity patches into the buffer |
| `backendHealth.ts` | pty-host backend crash/ready | crash-type normalization + recovery-timer state |
| `resource.ts` | `onResourceMetrics`, memory pressure | `resourceMonitoringStore`; reduces background scrollback under pressure |
| `watchdogHealth.ts` | watchdog disabled | `panelStore.setWatchdogDisabled` |
| `fdLeakWarning.ts` | FD-leak warning | **Tier 0 — `console.warn` only** (5-min cooldown). Demoted from a toast in `c41d0ab50`; do not re-promote. |

### `panelStatusBuffer.ts` — the RAF coalescer

High-frequency panel-status writes (activity + flow-status) do **not** call `usePanelStore.setState` per event. They enqueue into module-level `Map`s in `panelStatusBuffer.ts`, which schedules a single `requestAnimationFrame` flush. The flush collapses N enqueued patches into **one** `setState`, because Zustand 5 runs its subscriber-notify loop synchronously per `setState` — coalescing is the dominant per-frame perf win (#8589).

Invariants worth preserving:

- The buffer is a module-level singleton and **must outlive any single listener** — its `cancelPanelStatusBuffer` teardown is owned by `setupTerminalStoreListeners`, not by a sub-listener.
- `enqueueFlowStatusUpdate` drops an out-of-order patch (`timestamp < existing.timestamp`) to prevent in-buffer reordering from clobbering a newer status within the same frame.
- The flush snapshots and clears the buffers **before** running the `setState` updater, so re-entrant enqueues during subscriber callbacks land in the next frame rather than being silently dropped.
- Agent-state writes from `identity.ts` stay **direct** (unbuffered) on purpose — deferring them a frame would break `processQueue` dispatch ordering.

## Persistence

Two distinct persistence paths exist; do not conflate them.

### 1. Zustand `persist` → localStorage (`persistence/safeStorage.ts`)

Settings-style stores opt in by wrapping their `create()` in the `persist` middleware with `storage: createSafeJSONStorage()`. ~13 stores do this (`preferencesStore`, `agentPreferencesStore`, `portalStore`, `commandHistoryStore`, `helpPanelStore`, `panelLimitStore`, `projectStore`, `toolbarPreferencesStore`, `worktreeFilterStore`, `twoPaneSplitStore`, `terminalSearchHistoryStore`, `urlHistoryStore`, `voiceRecordingStore`).

`createSafeJSONStorage()` hardens the default localStorage adapter:

- **Quota errors are transient** — a `QuotaExceededError` keeps localStorage active (the write was just too big) and never switches to memory or notifies (#9170).
- **Structural failures fall back to memory** _permanently for that instance_ and fire a one-shot notify via the registered `permanentFallbackHandler` (wired from `notify.ts` at boot).
- **Corrupt blobs recover from a sibling `${key}.__bak` backup** before resetting to defaults; the backup only advances when the primary write actually reached durable storage (so a quota failure can't desync the two).
- `createDebouncedSafeJSONStorage(delayMs)` is the variant used by hot-writing stores (e.g. notification history); reads stay synchronous so hydration is unaffected.

A persisted store declares `name` (the storage key), `version`, and optional `migrate`/`merge` in its persist options — `preferencesStore` is the canonical worked example (version 9, full `migrate` chain, `merge`-time sanitization).

**Hydration ordering:** localStorage reads are synchronous, so a persisted store hydrates at module-evaluation time. Cross-store reads _during hydration_ run at eval time, so they must not assume another store has finished — this is exactly the TDZ/stale-state hazard documented in [store-init-order.md](./store-init-order.md). Route any eval-time cross-store read through `storeAccessors.ts`. (A direct top-level import is only safe when every read sits inside a later-running function body, as in the sanctioned `panelStore` ↔ `worktreeStore` pair — see [store-init-order.md](./store-init-order.md); hydration is not that case.)

### 2. Project-scoped panel snapshots → main process (`persistence/panelPersistence.ts`)

Panel layout is **not** in localStorage — it persists to the Electron store via IPC, keyed by `projectId`. The `panelPersistence` singleton debounces saves (500ms default), filters out trash/background/assistant/ephemeral panels, and serializes each panel through its kind's `serialize` fragment (`getPanelKindConfig(kind).serialize`). Unregistered kinds (extension disabled mid-session) have their previously-persisted fields preserved via `getPreviousSnapshotMap` rather than erased. `primeProject` seeds the previous-snapshot cache from hydration so the first save doesn't drop unregistered-kind state.

### `persistence/persistedStoreRegistry.ts`

A **read-only diagnostic** registry, not part of the persistence mechanism. Persisted stores call `registerPersistedStore({ storeId, store, persistedStateType })` at module load; the registry derives `name`/`version`/`partialize`/`migrate`/`merge` lazily from `store.persist.getOptions()`. It powers the `actions.persistedStores` diagnostic action and **throws in dev on duplicate `storeId` or storage-key collision** — a cheap guard against two stores fighting over one localStorage key.

## `rendererStoreOrchestrator.ts`

This module owns everything that wires _independent_ stores together. `initStoreOrchestrator()` (called once from `usePanelStoreBootstrap.ts`) does three jobs:

1. **Registers cross-store accessor closures** via `storeAccessors.ts` (`setPanelStoreAccessor`, `setWorktreeSelectionAccessor`, `setFleetArmedIdsAccessor`, …). These run **before** the idempotency guard so `destroy` + re-init reconnects closures to current singletons. The closures resolve `getState()` lazily on each call — no stale-snapshot capture. Also registers the `notify()` active-context accessors (active worktree id + focused panel id + a subscribe fn) so toasts can be suppressed when their origin surface is already visible.

2. **Holds cross-store subscriptions** (each added to a `DisposableStore`): worktree-focus tracking, focus→active-worktree promotion, terminal MRU recording (debounced persist), background-restore-on-focus, terminal-removal cleanup (input/console-capture/resource/voice/semantic-analysis), layout-undo invalidation, voice-dictation lock auto-clear, fleet-arming panel pruning, and CLI-availability → agent-settings re-normalization (with a loading-race backstop).

3. **Lifecycle / teardown** — `destroyStoreOrchestrator()` disposes all subscriptions, cancels the MRU persist debounce, and calls `resetStoreAccessorsForTesting()` so accessor slots return `null` (the documented unset-fallback) rather than stale closures.

`storeAccessors.ts` itself is a dependency-free leaf module: it holds seven mutable getter/callback slots and imports no other store module, which is what breaks the ESM cycle. **Do not** add a store import to it. The full rationale (TDZ crash vs silent stale-state, why registration is deferred to a single init point) is in [store-init-order.md](./store-init-order.md) — read it before touching cross-store reads.

## How to add a new store

Mirrors the "Adding new IPC" checklist in [development.md](../development.md).

1. **Pick the flavor.** Per-view, port-driven, project-owned data → vanilla `createStore()` + Context provider + module accessor (model on `createWorktreeStore.ts`). Everything else → app-global `create()` with a `useFooStore` hook.
2. **Create `src/store/fooStore.ts`.** Keep it a leaf where possible. If you must read a sibling store, the read may never touch the sibling's binding at module-evaluation time — route eval-time reads through an accessor in `storeAccessors.ts`. A direct top-level import is only acceptable when every read lives inside a later-running function body and you add a cold-graph regression gate, as the sanctioned `panelStore` ↔ `worktreeStore` pair does (see [store-init-order.md](./store-init-order.md) for the full decision tree).
3. **Export from `src/store/index.ts`** if anything outside `src/store/` consumes it — `index.ts` is the canonical inventory.
4. **If it persists to localStorage:** wrap in `persist` with `storage: createSafeJSONStorage()` (or the debounced variant for hot writers), set a unique `name`, a `version`, and `migrate`/`merge` if the shape can change. Then call `registerPersistedStore({ … })` at module load so the diagnostic surface and the key-collision guard pick it up.
5. **If it needs to react to another store** (not just be read by one), add the subscription to `rendererStoreOrchestrator.ts` inside the `DisposableStore`, **not** as a module-scope `subscribe` — that's what gives HMR/test teardown a deterministic cleanup point.
6. **If it's a slice of `panelStore`** rather than a standalone store, add a `create*Slice` creator under `src/store/slices/`, compose it in `panelStore.ts`, and export its types through `slices/index.ts`. Choose a slice only when the state must mutate atomically with the host store; otherwise make it standalone.
7. **Tests** go in `src/store/__tests__/`. Stores with cross-store coupling should cover the `destroyStoreOrchestrator()` → re-init path (accessor reconnection) — see `rendererStoreOrchestrator.test.ts`.

## See also

- [store-init-order.md](./store-init-order.md) — cross-store accessor module, ESM cycle avoidance, renderer init order.
- [process-and-window-model.md](./process-and-window-model.md) — per-view `WebContentsView` / V8 context topology that makes the app-global vs per-view distinction load-bearing.
- [terminal-lifecycle.md](./terminal-lifecycle.md) and [terminal-identity.md](./terminal-identity.md) — the panel-registry and identity-reducer behavior the panel listeners drive.
