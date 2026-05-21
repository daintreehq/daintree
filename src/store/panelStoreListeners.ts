import { DisposableStore, toDisposable } from "@/utils/disposable";
import { clearAllRestartGuards } from "./restartExitSuppression";
import { cancelPanelStatusBuffer } from "./panelStatusBuffer";
import { setupIdentityListeners } from "./listeners/panel/identity";
import { setupLifecycleListeners } from "./listeners/panel/lifecycle";
import { setupActivityListeners } from "./listeners/panel/activity";
import { setupBackendHealthListeners } from "./listeners/panel/backendHealth";
import { setupResourceListeners } from "./listeners/panel/resource";
import { setupFdLeakWarningListeners } from "./listeners/panel/fdLeakWarning";
import { setupWatchdogHealthListeners } from "./listeners/panel/watchdogHealth";

let store: DisposableStore | null = null;

export function cleanupTerminalStoreListeners() {
  clearAllRestartGuards();
  store?.dispose();
  store = null;
}

export function setupTerminalStoreListeners() {
  if (typeof window === "undefined") return () => {};

  // Idempotent: return early if already set up to prevent overlapping registration.
  if (store !== null) {
    return cleanupTerminalStoreListeners;
  }

  const disposables = new DisposableStore();
  store = disposables;

  // Owns the shared RAF buffer's teardown. Sub-listeners (activity, lifecycle
  // onStatus) only enqueue patches; the buffer is a module-level singleton
  // and must outlive any single sub-store, so cancellation lives here.
  disposables.add(toDisposable(cancelPanelStatusBuffer));

  disposables.add(setupIdentityListeners());
  disposables.add(setupLifecycleListeners());
  disposables.add(setupActivityListeners());
  disposables.add(setupBackendHealthListeners());
  disposables.add(setupResourceListeners());
  disposables.add(setupFdLeakWarningListeners());
  disposables.add(setupWatchdogHealthListeners());

  return cleanupTerminalStoreListeners;
}

// This module registers IPC listeners via `setupTerminalStoreListeners` at app
// bootstrap (see `src/hooks/app/usePanelStoreBootstrap.ts`). Without an HMR
// accept boundary, any edit here — or to any of its imports — cascades into a
// full page reload because Vite can't prove the replacement is safe. Self-
// accepting is safe because the listener registry (`store`) is module-level
// and we drop it on dispose; the React effect in `usePanelStoreBootstrap`
// then re-invokes `setupTerminalStoreListeners` on its next run. Sub-modules
// in `./listeners/panel/` deliberately have NO HMR accept blocks so changes
// propagate up to this single coordinator boundary.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    cleanupTerminalStoreListeners();
  });
  import.meta.hot.accept();
}
