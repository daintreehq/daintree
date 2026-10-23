import { create } from "zustand";
import { logError } from "@/utils/logger";
import type { PluginAttentionShelf } from "@/lib/pluginPanelAttention";
import {
  resolveAgentSnoozeDuration,
  type AgentSnoozeDurationOption,
} from "@shared/utils/agentSnoozeDurations";

/**
 * The snooze ladder for a plugin row: the agent ladder without "until I
 * interact", because a plugin panel has no typed input to end it.
 */
export type PluginAttentionSnoozeOption = Exclude<AgentSnoozeDurationOption, "unlimited">;

export const PLUGIN_ATTENTION_SNOOZE_OPTIONS: readonly PluginAttentionSnoozeOption[] = [
  "15m",
  "30m",
  "6h",
];

/**
 * What the attention views need to show plugin panel rows (#13821), beside the
 * reports in `pluginPanelActivityStore`:
 *
 * - `grantedPluginIds`: plugin instances the user switched on in the Plugin
 *   Manager. Pulled from main, and pulled again on every provenance change, which
 *   is what the switch announces. Empty until known and empty on a failed pull:
 *   a plugin only reaches these surfaces on a grant positively in force.
 * - `shelfByPanelId`: the user's parks and snoozes on plugin rows. This view's
 *   own and never persisted, like the reports they shelve; they never touch an
 *   agent's park or snooze, which main owns.
 */
interface PluginPanelAttentionState {
  grantedPluginIds: ReadonlySet<string>;
  shelfByPanelId: Readonly<Record<string, PluginAttentionShelf>>;
  /** Idempotent: pulls the granted set and follows changes to it. */
  init: () => void;
  /**
   * Record a switch this view just saved, ahead of the broadcast that tells every
   * view. A revoke also drops the plugin's shelves.
   */
  setGranted: (pluginId: string, enabled: boolean) => void;
  /** Park the report at `revision` until the plugin reports something new. */
  park: (panelId: string, pluginId: string, revision: number) => void;
  snooze: (panelId: string, pluginId: string, option: PluginAttentionSnoozeOption) => void;
  /** Lift a park or snooze. The inverse of both, so neither needs a confirm. */
  release: (panelId: string) => void;
  /** Drop what is held for a closed panel. Called from the panel-removal cleanup. */
  removePanel: (panelId: string) => void;
}

const EMPTY_GRANTS: ReadonlySet<string> = new Set();

let initialized = false;
let unsubscribe: (() => void) | null = null;
// Only the newest pull may land, so a slow older response cannot bring back a
// grant a later one saw revoked.
let pullSeq = 0;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

/** Shelves for plugins still granted, and snoozes still running. */
function liveShelves(
  shelves: Readonly<Record<string, PluginAttentionShelf>>,
  granted: ReadonlySet<string>,
  nowMs: number
): Readonly<Record<string, PluginAttentionShelf>> {
  let next: Record<string, PluginAttentionShelf> | null = null;
  for (const [panelId, shelf] of Object.entries(shelves)) {
    const expired = shelf.kind === "snoozed" && shelf.until <= nowMs;
    if (!expired && granted.has(shelf.pluginId)) continue;
    next ??= { ...shelves };
    delete next[panelId];
  }
  return next ?? shelves;
}

export const usePluginPanelAttentionStore = create<PluginPanelAttentionState>((set, get) => {
  const prune = () => {
    const { shelfByPanelId, grantedPluginIds } = get();
    const next = liveShelves(shelfByPanelId, grantedPluginIds, Date.now());
    if (next !== shelfByPanelId) set({ shelfByPanelId: next });
    scheduleExpiry();
  };

  /**
   * One timer, for the nearest snooze. Wall-clock deadlines, so a pass on window
   * focus also catches a snooze that ran out while the machine slept.
   */
  const scheduleExpiry = () => {
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    expiryTimer = null;
    let nearest = Number.POSITIVE_INFINITY;
    for (const shelf of Object.values(get().shelfByPanelId)) {
      if (shelf.kind === "snoozed" && shelf.until < nearest) nearest = shelf.until;
    }
    if (nearest === Number.POSITIVE_INFINITY) return;
    expiryTimer = setTimeout(prune, Math.max(0, nearest - Date.now()));
  };

  const pullGrants = async () => {
    const seq = ++pullSeq;
    let granted: ReadonlySet<string> = EMPTY_GRANTS;
    try {
      const ids = await window.electron.pluginCapability.listPanelAttention();
      granted = new Set(ids);
    } catch (err) {
      logError("Failed to load plugin attention grants", err);
    }
    if (seq !== pullSeq) return;
    const current = get();
    if (sameSet(granted, current.grantedPluginIds)) return;
    set({
      grantedPluginIds: granted,
      shelfByPanelId: liveShelves(current.shelfByPanelId, granted, Date.now()),
    });
  };

  return {
    grantedPluginIds: EMPTY_GRANTS,
    shelfByPanelId: {},
    init: () => {
      if (initialized) return;
      // Tolerate a partially-stubbed bridge, and stay retryable until it is
      // present, like the activity store.
      const plugin = window.electron?.plugin;
      const capability = window.electron?.pluginCapability;
      if (
        typeof plugin?.onProvenanceChanged !== "function" ||
        typeof capability?.listPanelAttention !== "function"
      ) {
        return;
      }
      initialized = true;
      const offProvenance = plugin.onProvenanceChanged(() => void pullGrants());
      window.addEventListener("focus", prune);
      unsubscribe = () => {
        offProvenance();
        window.removeEventListener("focus", prune);
      };
      void pullGrants();
    },
    setGranted: (pluginId, enabled) => {
      const current = get();
      if (current.grantedPluginIds.has(pluginId) === enabled) return;
      const granted = new Set(current.grantedPluginIds);
      if (enabled) granted.add(pluginId);
      else granted.delete(pluginId);
      // A newer pull supersedes this, and an older one in flight must not undo it.
      pullSeq++;
      set({
        grantedPluginIds: granted,
        shelfByPanelId: liveShelves(current.shelfByPanelId, granted, Date.now()),
      });
    },
    park: (panelId, pluginId, revision) => {
      set((state) => ({
        shelfByPanelId: {
          ...state.shelfByPanelId,
          [panelId]: { kind: "parked", pluginId, revision, at: Date.now() },
        },
      }));
      scheduleExpiry();
    },
    snooze: (panelId, pluginId, option) => {
      const at = Date.now();
      const until = resolveAgentSnoozeDuration(option, at);
      if (until === undefined) return;
      set((state) => ({
        shelfByPanelId: {
          ...state.shelfByPanelId,
          [panelId]: { kind: "snoozed", pluginId, until, at },
        },
      }));
      scheduleExpiry();
    },
    release: (panelId) => {
      if (!(panelId in get().shelfByPanelId)) return;
      set((state) => {
        const { [panelId]: _released, ...rest } = state.shelfByPanelId;
        return { shelfByPanelId: rest };
      });
      scheduleExpiry();
    },
    removePanel: (panelId) => get().release(panelId),
  };
});

/** Test-only: reset the module-level guards and state between cases. */
export function _resetPluginPanelAttentionStoreForTest(): void {
  unsubscribe?.();
  unsubscribe = null;
  initialized = false;
  pullSeq = 0;
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  expiryTimer = null;
  usePluginPanelAttentionStore.setState({ grantedPluginIds: EMPTY_GRANTS, shelfByPanelId: {} });
}
