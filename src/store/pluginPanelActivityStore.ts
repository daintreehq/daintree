import { create } from "zustand";
import type { PluginPanelActivityReport } from "@shared/types/plugin";

/**
 * Renderer mirror of the activity plugins report on their own panels via
 * `host.setPanelActivity` (#13820), keyed `panelId → pluginId → report`. Source
 * of truth is `PluginService` in main; each `plugin:panel-activity-changed`
 * carries one plugin's COMPLETE map, and an empty map clears it. A restored
 * view gets the current maps replayed. Not persisted.
 *
 * Whether a finished report has been seen is this view's own call, never main's
 * and never an agent read mark: `seenRevisionByPanelId` holds the revision of
 * the report the user last had in front of them, so a replay of the same report
 * stays seen and a new completion reads unread again.
 */
type ActivityByPanelId = Record<string, Record<string, PluginPanelActivityReport>>;

interface PluginPanelActivityState {
  activityByPanelId: ActivityByPanelId;
  seenRevisionByPanelId: Record<string, number>;
  /** Idempotent: subscribes to live activity updates. */
  init: () => void;
  /** Record that the report at `revision` on `panelId` has been in front of the user. */
  markSeen: (panelId: string, revision: number) => void;
  /**
   * Drop everything held for a closed panel. Called from the renderer store
   * orchestrator's removal cleanup, like the badge store's.
   */
  removePanel: (panelId: string) => void;
}

let initialized = false;
let unsubscribeChanged: (() => void) | null = null;

/**
 * Replace one plugin's reports. Only panels whose report from this plugin
 * changed revision get a new object; an equal replay returns `current` itself,
 * so nothing downstream sees a change that did not happen (#14128).
 */
function applyPluginActivity(
  current: ActivityByPanelId,
  pluginId: string,
  activity: Record<string, PluginPanelActivityReport>
): ActivityByPanelId {
  let next: ActivityByPanelId | null = null;
  for (const [panelId, byPlugin] of Object.entries(current)) {
    if (!Object.hasOwn(byPlugin, pluginId) || Object.hasOwn(activity, panelId)) continue;
    const { [pluginId]: _removed, ...rest } = byPlugin;
    next ??= { ...current };
    if (Object.keys(rest).length > 0) next[panelId] = rest;
    else delete next[panelId];
  }
  for (const [panelId, report] of Object.entries(activity)) {
    const byPlugin = current[panelId];
    if (byPlugin?.[pluginId]?.revision === report.revision) continue;
    next ??= { ...current };
    next[panelId] = { ...byPlugin, [pluginId]: report };
  }
  return next ?? current;
}

/** Seen marks only outlive their panel's reports by as long as the panel has any. */
function pruneSeen(
  seen: Record<string, number>,
  activity: ActivityByPanelId
): Record<string, number> {
  let pruned: Record<string, number> | null = null;
  for (const panelId of Object.keys(seen)) {
    if (panelId in activity) continue;
    pruned ??= { ...seen };
    delete pruned[panelId];
  }
  return pruned ?? seen;
}

export const usePluginPanelActivityStore = create<PluginPanelActivityState>((set, get) => ({
  activityByPanelId: {},
  seenRevisionByPanelId: {},
  init: () => {
    if (initialized) return;
    // Tolerate a partially-stubbed bridge, and stay retryable until it is
    // present, like the badge store.
    const plugin = window.electron?.plugin;
    if (typeof plugin?.onPanelActivityChanged !== "function") return;
    initialized = true;

    unsubscribeChanged = plugin.onPanelActivityChanged(({ pluginId, activity }) => {
      const state = get();
      const activityByPanelId = applyPluginActivity(state.activityByPanelId, pluginId, activity);
      if (activityByPanelId === state.activityByPanelId) return;
      set({
        activityByPanelId,
        seenRevisionByPanelId: pruneSeen(state.seenRevisionByPanelId, activityByPanelId),
      });
    });
  },
  markSeen: (panelId, revision) =>
    set((state) => {
      if (state.seenRevisionByPanelId[panelId] === revision) return state;
      return { seenRevisionByPanelId: { ...state.seenRevisionByPanelId, [panelId]: revision } };
    }),
  removePanel: (panelId) =>
    set((state) => {
      if (!(panelId in state.activityByPanelId) && !(panelId in state.seenRevisionByPanelId)) {
        return state;
      }
      const { [panelId]: _activity, ...activityByPanelId } = state.activityByPanelId;
      const { [panelId]: _seen, ...seenRevisionByPanelId } = state.seenRevisionByPanelId;
      return { activityByPanelId, seenRevisionByPanelId };
    }),
}));

/** The report `pluginId` holds on `panelId`, or undefined. */
export function selectPanelActivityReport(
  state: Pick<PluginPanelActivityState, "activityByPanelId">,
  panelId: string,
  pluginId: string | null
): PluginPanelActivityReport | undefined {
  if (pluginId === null) return undefined;
  return state.activityByPanelId[panelId]?.[pluginId];
}

/** Test-only: reset the module-level init guard and state between cases. */
export function _resetPluginPanelActivityStoreForTest(): void {
  unsubscribeChanged?.();
  unsubscribeChanged = null;
  initialized = false;
  usePluginPanelActivityStore.setState({ activityByPanelId: {}, seenRevisionByPanelId: {} });
}
