import { create } from "zustand";
import type { PluginPanelBadge } from "@shared/types/plugin";

/**
 * Renderer mirror of the live panel badges plugins set via `host.setPanelBadge`
 * (#10585), keyed `panelId → pluginId → badge` so a panel header can resolve its
 * badges in O(1) at render time. Source of truth is `PluginService` in main; we
 * hydrate from `plugin:panel-badges-changed` (one plugin's COMPLETE current map
 * per event) and `plugin:panel-badges-cleared` (a plugin unloaded). Cold-restored
 * views get the current state replayed via `pushSnapshotTo`. Not persisted —
 * badges are ephemeral runtime state.
 *
 * Subscription is module-level (not per-component) so badges survive panel
 * header unmount/remount (dock/grid toggle, LRU view restore) and no event is
 * missed between renders.
 */
type BadgesByPanelId = Record<string, Record<string, PluginPanelBadge>>;

interface PluginPanelBadgeState {
  badgesByPanelId: BadgesByPanelId;
  /** Idempotent: subscribes to live badge updates. */
  init: () => void;
  /**
   * Drop all badges for a closed panel. Called from the renderer store
   * orchestrator's terminal-removal cleanup when `panelIds` shrinks — without
   * it a closed panel's badge entry leaks for the renderer's lifetime (#10908).
   * Idempotent: a no-op (preserving the root reference so subscribers don't
   * re-render) when the panel has no badges.
   */
  removePanel: (panelId: string) => void;
}

let initialized = false;
let unsubscribeChanged: (() => void) | null = null;
let unsubscribeCleared: (() => void) | null = null;

/** Main's equality: an omitted colour is the default one. */
function sameBadge(a: PluginPanelBadge, b: PluginPanelBadge): boolean {
  return (
    a.kind === b.kind &&
    (a.color ?? "default") === (b.color ?? "default") &&
    a.tooltip === b.tooltip &&
    (a.kind !== "label" || (b.kind === "label" && a.text === b.text))
  );
}

/**
 * Recompute `badgesByPanelId` after replacing one plugin's entire badge set.
 * `badges` is the plugin's COMPLETE current map (`panelId → badge`); an empty
 * map clears the plugin. Only panels whose badge from this plugin actually
 * changed get a new object, and an equal replay returns `current` itself, so a
 * fleet-wide snapshot re-renders just the panel that moved (#14128).
 */
function applyPluginBadges(
  current: BadgesByPanelId,
  pluginId: string,
  badges: Record<string, PluginPanelBadge>
): BadgesByPanelId {
  let next: BadgesByPanelId | null = null;
  for (const [panelId, byPlugin] of Object.entries(current)) {
    if (!Object.hasOwn(byPlugin, pluginId) || Object.hasOwn(badges, panelId)) continue;
    const { [pluginId]: _removed, ...rest } = byPlugin;
    next ??= { ...current };
    if (Object.keys(rest).length > 0) next[panelId] = rest;
    else delete next[panelId];
  }
  for (const [panelId, badge] of Object.entries(badges)) {
    const byPlugin = current[panelId];
    const previous = byPlugin?.[pluginId];
    if (previous !== undefined && sameBadge(previous, badge)) continue;
    next ??= { ...current };
    next[panelId] = { ...byPlugin, [pluginId]: badge };
  }
  return next ?? current;
}

export const usePluginPanelBadgeStore = create<PluginPanelBadgeState>((set, get) => ({
  badgesByPanelId: {},
  init: () => {
    if (initialized) return;

    // Rendered from every panel header, so tolerate a partially-stubbed bridge
    // (component tests that don't mock the plugin namespace) — absent bridge ⇒
    // no badges, matching prod before the first snapshot. Don't latch
    // `initialized` until the bridge is actually present, so a no-bridge early
    // return stays retryable (a later mount with a real bridge can subscribe).
    const plugin = window.electron?.plugin;
    if (
      typeof plugin?.onPanelBadgesChanged !== "function" ||
      typeof plugin.onPanelBadgesCleared !== "function"
    ) {
      return;
    }
    initialized = true;

    const apply = (pluginId: string, badges: Record<string, PluginPanelBadge>): void => {
      const current = get().badgesByPanelId;
      const badgesByPanelId = applyPluginBadges(current, pluginId, badges);
      if (badgesByPanelId !== current) set({ badgesByPanelId });
    };
    unsubscribeChanged = plugin.onPanelBadgesChanged(({ pluginId, badges }) =>
      apply(pluginId, badges)
    );
    unsubscribeCleared = plugin.onPanelBadgesCleared(({ pluginId }) => apply(pluginId, {}));
  },
  removePanel: (panelId) =>
    set((state) => {
      if (!(panelId in state.badgesByPanelId)) return state;
      const { [panelId]: _removed, ...badgesByPanelId } = state.badgesByPanelId;
      return { badgesByPanelId };
    }),
}));

/** Stable empty reference so panels with no badges never re-render on identity. */
const EMPTY_BADGES: Readonly<Record<string, PluginPanelBadge>> = Object.freeze({});

/**
 * Badges set on `panelId`, keyed by the contributing plugin id (empty when
 * none). Reference is stable while that panel's badges are unchanged.
 */
export function usePanelBadges(panelId: string): Readonly<Record<string, PluginPanelBadge>> {
  return usePluginPanelBadgeStore((s) => s.badgesByPanelId[panelId] ?? EMPTY_BADGES);
}

/** Test-only: reset the module-level init guard and state between cases. */
export function _resetPluginPanelBadgeStoreForTest(): void {
  unsubscribeChanged?.();
  unsubscribeCleared?.();
  unsubscribeChanged = null;
  unsubscribeCleared = null;
  initialized = false;
  usePluginPanelBadgeStore.setState({ badgesByPanelId: {} });
}
