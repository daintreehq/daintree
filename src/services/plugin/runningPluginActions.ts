import { useCallback, useMemo, useSyncExternalStore } from "react";
import { pluginManifestIdFromInstanceKey } from "@shared/types/plugin";

/**
 * Plugin actions whose handlers main has in flight, as `pluginId → action ids`
 * (each plugin's complete set, as dispatched). Main tracks the handler's
 * promise at its one dispatch choke point, so this covers every route in:
 * palette, menu, panel toolbar, keybinding, agent. Main's events do not
 * replay to a late listener, so the renderer subscribes at bootstrap
 * ({@link installRunningPluginActions}) and stays subscribed: a run started
 * before any toolbar or view mounts is still known when one does, and a
 * cold-restored view catches the set `pushSnapshotTo` replays at load.
 */

type Listener = () => void;
export type RunningPluginActions = ReadonlyMap<string, readonly string[]>;

const EMPTY: RunningPluginActions = new Map();
const NO_ACTIONS: readonly string[] = Object.freeze([]);
let snapshot: RunningPluginActions = EMPTY;
const listeners = new Set<Listener>();
let unsubscribeMain: (() => void) | null = null;

/**
 * Start following main. Called synchronously from the renderer's bootstrap,
 * before main's `did-finish-load` replay; idempotent, and a subscriber calls
 * it too so a test without the bootstrap still connects.
 */
export function installRunningPluginActions(): void {
  if (unsubscribeMain) return;
  // Tolerate a partially-stubbed bridge (component tests): nothing is running,
  // and a later subscriber with a real bridge can still connect.
  const plugin = window.electron?.plugin;
  if (typeof plugin?.onActionsRunningChanged !== "function") return;
  unsubscribeMain = plugin.onActionsRunningChanged(({ pluginId, actionIds }) =>
    applyRunningPluginActions(pluginId, actionIds)
  );
}

export function getRunningPluginActionsSnapshot(): RunningPluginActions {
  return snapshot;
}

export function subscribeToRunningPluginActions(listener: Listener): () => void {
  installRunningPluginActions();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Replace one plugin's running set; an empty list drops it. */
export function applyRunningPluginActions(pluginId: string, actionIds: readonly string[]): void {
  const previous = snapshot.get(pluginId) ?? NO_ACTIONS;
  if (
    previous.length === actionIds.length &&
    previous.every((actionId, index) => actionId === actionIds[index])
  ) {
    return;
  }
  const next = new Map(snapshot);
  if (actionIds.length === 0) next.delete(pluginId);
  else next.set(pluginId, Object.freeze([...actionIds]));
  snapshot = next.size === 0 ? EMPTY : next;
  for (const listener of [...listeners]) listener();
}

/** Whether `actionId` (as dispatched) is running for any plugin. */
export function isPluginActionRunning(running: RunningPluginActions, actionId: string): boolean {
  for (const actionIds of running.values()) {
    if (actionIds.includes(actionId)) return true;
  }
  return false;
}

/**
 * `pluginId`'s running actions as its manifest writes them. A project plugin's
 * actions dispatch under its instance namespace, but its view names them by
 * manifest id, as it does for `setToolbarItemState`.
 */
export function authoredRunningActions(
  running: RunningPluginActions,
  pluginId: string
): readonly string[] {
  const actionIds = running.get(pluginId);
  if (!actionIds) return NO_ACTIONS;
  const manifestId = pluginManifestIdFromInstanceKey(pluginId);
  if (manifestId === pluginId) return actionIds;
  const instancePrefix = `${pluginId}.`;
  return actionIds.map((actionId) =>
    actionId.startsWith(instancePrefix)
      ? `${manifestId}.${actionId.slice(instancePrefix.length)}`
      : actionId
  );
}

/**
 * {@link authoredRunningActions} for one plugin, re-rendering only when that
 * plugin's set changes: what a view receives as `runningActions`.
 */
export function useAuthoredRunningActions(pluginId: string): readonly string[] {
  const getPluginSnapshot = useCallback(() => snapshot.get(pluginId) ?? NO_ACTIONS, [pluginId]);
  const actionIds = useSyncExternalStore(
    subscribeToRunningPluginActions,
    getPluginSnapshot,
    getPluginSnapshot
  );
  return useMemo(
    () => authoredRunningActions(new Map([[pluginId, actionIds]]), pluginId),
    [pluginId, actionIds]
  );
}

/** Test-only: drop the main subscription and every running action. */
export function _resetRunningPluginActionsForTest(): void {
  unsubscribeMain?.();
  unsubscribeMain = null;
  snapshot = EMPTY;
  listeners.clear();
}
