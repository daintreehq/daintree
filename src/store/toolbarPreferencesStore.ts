import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { StorageValue } from "zustand/middleware";
import type {
  ToolbarPreferences,
  ToolbarButtonId,
  AnyToolbarButtonId,
  PluginToolbarButtonId,
  ToolbarPinnedState,
} from "@/../../shared/types/toolbar";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import {
  mergeRecordByWriterDelta,
  pickFieldByWriterDelta,
  type PersistWriteMergeContext,
} from "./persistence/persistWriteMerge";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";
import { BUILT_IN_AGENT_IDS, LAUNCHABLE_AGENT_IDS } from "@shared/config/agentIds";

const DEFAULT_LEFT_BUTTONS: ToolbarButtonId[] = [
  "agent-tray",
  ...(LAUNCHABLE_AGENT_IDS as unknown as ToolbarButtonId[]),
  "terminal",
  "browser",
  "dev-server",
];

const DEFAULT_RIGHT_BUTTONS: ToolbarButtonId[] = [
  "voice-recording",
  "forge-stats",
  "plugin-tray",
  "notification-center",
  "copy-tree",
  "resume-sessions",
  "command-palette",
  "settings",
  "problems",
];

const DEFAULT_PREFERENCES: ToolbarPreferences = {
  layout: {
    leftButtons: DEFAULT_LEFT_BUTTONS,
    rightButtons: DEFAULT_RIGHT_BUTTONS,
    pinnedButtons: {},
  },
  launcher: {
    alwaysShowDevServer: false,
    defaultSelection: undefined,
  },
};

const FIXED_BUTTON_IDS: ToolbarButtonId[] = ["sidebar-toggle", "assistant-toggle", "portal-toggle"];

function sanitizeButtonList(buttons: AnyToolbarButtonId[]): AnyToolbarButtonId[] {
  const filtered = buttons.filter((id) => !FIXED_BUTTON_IDS.includes(id as ToolbarButtonId));
  // Dedupe by first occurrence. A persisted list can accumulate repeated ids —
  // chiefly duplicate `forge-stats` when the v10 `renameForgeStats` migration
  // collapses `github-stats` onto a list that already held `forge-stats`,
  // compounded by shared dev-profile round-trips (#10937). Every hydration
  // routes through here via `mergeButtonList`, and `setLeftButtons`/
  // `setRightButtons` do too, so this is the durable, version-independent guard
  // against duplicate pills (`merge()` runs every load; `migrate()` does not).
  return Array.from(new Set(filtered));
}

/**
 * Merge persisted button list with defaults, adding any new buttons that
 * were added to defaults after the user's preferences were saved.
 * New buttons are added at their default position.
 */
function mergeButtonList(
  persisted: AnyToolbarButtonId[] | undefined,
  defaults: AnyToolbarButtonId[]
): AnyToolbarButtonId[] {
  if (!persisted) return defaults;

  const persistedSet = new Set(persisted);
  const result = [...persisted];

  // Find buttons in defaults that aren't in persisted (new buttons)
  for (let i = 0; i < defaults.length; i++) {
    const buttonId = defaults[i]!;
    if (!persistedSet.has(buttonId)) {
      // Insert at the same position as in defaults, or at end if beyond length
      const insertIndex = Math.min(i, result.length);
      result.splice(insertIndex, 0, buttonId);
      persistedSet.add(buttonId); // Track that we've added it
    }
  }

  return sanitizeButtonList(result);
}

/**
 * The exact subset persisted by `partialize` (note: the launcher's `defaultAgent`
 * is deliberately not persisted). The write merge (#11351) reconciles against
 * this shape, not the full runtime state.
 */
type ToolbarPreferencesPersistedState = {
  layout: ToolbarPreferences["layout"];
  launcher: Pick<ToolbarPreferences["launcher"], "alwaysShowDevServer" | "defaultSelection">;
};

function asButtonList(value: unknown): AnyToolbarButtonId[] | undefined {
  return Array.isArray(value)
    ? value.filter((id): id is AnyToolbarButtonId => typeof id === "string")
    : undefined;
}

function normalizePinnedButtons(value: unknown): ToolbarPinnedState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  // Keyed by plain string then returned as ToolbarPinnedState
  // (Partial<Record<AnyToolbarButtonId, boolean>>) — a total string→boolean map
  // is assignable to it, so no per-key assertion is needed.
  const result: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "boolean") result[key] = entry;
  }
  return result;
}

/**
 * Coerce a persisted (or in-memory) snapshot into the canonical persisted shape.
 * Button lists are only deduped/fixed-stripped via `sanitizeButtonList` (NOT
 * `mergeButtonList`): the reconciler takes the writer's own list verbatim rather
 * than diffing it, so there's no need to re-materialize defaults — and doing so
 * would duplicate a button the user moved across sides. A null/malformed blob
 * maps to defaults (issue #11351).
 */
function toToolbarPersisted(
  state: Partial<ToolbarPreferencesState> | null | undefined
): ToolbarPreferencesPersistedState {
  const layout = state?.layout;
  const launcher = state?.launcher;
  return {
    layout: {
      leftButtons: sanitizeButtonList(asButtonList(layout?.leftButtons) ?? DEFAULT_LEFT_BUTTONS),
      rightButtons: sanitizeButtonList(asButtonList(layout?.rightButtons) ?? DEFAULT_RIGHT_BUTTONS),
      pinnedButtons: normalizePinnedButtons(layout?.pinnedButtons),
    },
    launcher: {
      alwaysShowDevServer:
        typeof launcher?.alwaysShowDevServer === "boolean" ? launcher.alwaysShowDevServer : false,
      defaultSelection: launcher?.defaultSelection,
    },
  };
}

/**
 * Baseline-aware three-way merge for toolbar-preferences writes across project
 * views (issue #11351). `pinnedButtons` merges per button id so a stale view
 * neither drops nor resurrects a sibling's plugin pin/hide; launcher scalars
 * defer to a sibling's on-disk value unless this writer changed them. Button
 * orderings are the writer's own arrangement — two divergent orders can't be
 * merged, so they're taken verbatim (last-writer-wins).
 *
 * Migration coexistence: `onDisk` is read raw (no `migrate`), so the reconciler
 * must never diff against a foreign schema version — the 11-step migrate chain
 * reshapes the persisted blob (e.g. v7 `hiddenButtons` array → v8 `pinnedButtons`
 * map, v10 `github-stats` → `forge-stats`). Two guards cover the app-upgrade
 * window: a foreign on-disk version skips the merge outright; a foreign
 * *baseline* version (this writer's first post-migrate write, before any user
 * edit) defers wholesale to the sibling's already-current disk value rather than
 * mistaking the migration for an edit.
 */
function mergeToolbarPreferencesPersistedWrite({
  baseline,
  onDisk,
  incoming,
}: PersistWriteMergeContext<ToolbarPreferencesPersistedState>): StorageValue<ToolbarPreferencesPersistedState> {
  // Disk absent, or disk is a foreign (unmigrated) schema version we can't safely
  // diff against → take this writer's already-migrated snapshot.
  if (!onDisk || onDisk.version !== incoming.version) return incoming;
  const disk = toToolbarPersisted(onDisk.state);
  const inc = toToolbarPersisted(incoming.state);
  // This writer's baseline predates a migration: its first post-migrate write
  // carries no user edit yet, so defer to the sibling's already-current value
  // instead of reading the migration as an edit. (`migrate` runs only on the
  // numeric-version branch, so an unversioned baseline is not "foreign".)
  if (baseline && typeof baseline.version === "number" && baseline.version !== incoming.version) {
    return { version: incoming.version, state: disk };
  }
  const base = toToolbarPersisted(baseline?.state);
  return {
    version: incoming.version,
    state: {
      layout: {
        // Take the writer's own ordering verbatim (last-writer-wins) — see the
        // JSDoc; this also avoids re-materializing a moved default onto both sides.
        leftButtons: inc.layout.leftButtons,
        rightButtons: inc.layout.rightButtons,
        pinnedButtons: mergeRecordByWriterDelta(
          base.layout.pinnedButtons,
          inc.layout.pinnedButtons,
          disk.layout.pinnedButtons
        ),
      },
      launcher: {
        alwaysShowDevServer: pickFieldByWriterDelta(
          base.launcher.alwaysShowDevServer,
          inc.launcher.alwaysShowDevServer,
          disk.launcher.alwaysShowDevServer
        ),
        defaultSelection: pickFieldByWriterDelta(
          base.launcher.defaultSelection,
          inc.launcher.defaultSelection,
          disk.launcher.defaultSelection
        ),
      },
    },
  };
}

interface ToolbarPreferencesState extends ToolbarPreferences {
  setLeftButtons: (buttons: AnyToolbarButtonId[]) => void;
  setRightButtons: (buttons: AnyToolbarButtonId[]) => void;
  moveButton: (
    buttonId: AnyToolbarButtonId,
    from: "left" | "right",
    to: "left" | "right",
    toIndex: number
  ) => void;
  toggleButtonVisibility: (buttonId: AnyToolbarButtonId, side: "left" | "right") => void;
  /**
   * Promote a plugin contribution to its own top-level toolbar button, or
   * demote it back to tray-only (#11304).
   *
   * Plugin buttons live in the plugin tray by default, so — unlike
   * `toggleButtonVisibility`, which only ever records a departure-from-visible
   * as `false` — promotion has to persist an explicit `true`. Demoting deletes
   * the key rather than writing `false`: both read as tray-only, and an absent
   * key keeps the map sparse (and lets a legacy pre-#11304 `false` hide entry
   * clear itself the first time a user toggles that button).
   *
   * Ordering arrays are deliberately untouched — a promoted button with no
   * persisted position appends to the right side in `Toolbar.tsx`, matching
   * how plugin buttons behaved before the tray landed.
   */
  setPluginButtonPromoted: (buttonId: PluginToolbarButtonId, promoted: boolean) => void;
  /**
   * Prune `pinnedButtons` entries for plugin buttons that are no longer in
   * the loaded plugin set. `pinnedButtons` is renderer-local persisted state
   * with no main-process access, so an uninstalled plugin's stale hide entry
   * can only be swept here, driven by the plugin lifecycle snapshot in
   * `usePluginToolbarButtons`. Plugin buttons use the `{pluginId}.{btnId}`
   * canonical namespace (#9281) — built-in button IDs (`sidebar-toggle`,
   * `notification-center`, agent IDs like `claude`, etc.) contain only
   * hyphens or single tokens, never dots, so `key.includes(".")` cleanly
   * separates the two. No-ops (returns state unchanged) when nothing is
   * stale so the per-snapshot call doesn't churn the persist layer.
   *
   * Explicit promotions (`true`, #11304) are exempt — see the filter below.
   */
  sweepStalePluginPinnedButtons: (validIds: string[]) => void;
  setAlwaysShowDevServer: (value: boolean) => void;
  setDefaultSelection: (selection: ToolbarPreferences["launcher"]["defaultSelection"]) => void;
  setDefaultAgent: (agent: ToolbarPreferences["launcher"]["defaultAgent"]) => void;
  reset: () => void;
}

export const useToolbarPreferencesStore = create<ToolbarPreferencesState>()(
  persist(
    (set) => ({
      ...DEFAULT_PREFERENCES,
      setLeftButtons: (buttons) =>
        set((state) => ({
          layout: { ...state.layout, leftButtons: sanitizeButtonList(buttons) },
        })),
      setRightButtons: (buttons) =>
        set((state) => ({
          layout: { ...state.layout, rightButtons: sanitizeButtonList(buttons) },
        })),
      moveButton: (buttonId, from, to, toIndex) =>
        set((state) => {
          const leftButtons = [...state.layout.leftButtons];
          const rightButtons = [...state.layout.rightButtons];

          const fromList = from === "left" ? leftButtons : rightButtons;
          const toList = to === "left" ? leftButtons : rightButtons;

          const fromIndex = fromList.indexOf(buttonId);
          if (fromIndex === -1) return state;

          fromList.splice(fromIndex, 1);

          if (from === to && fromIndex < toIndex) {
            toIndex--;
          }

          toList.splice(toIndex, 0, buttonId);

          return {
            layout: {
              ...state.layout,
              // Sanitize both sides so a cross-side move onto a list that
              // already held the id can't leave a duplicate behind (#10937).
              leftButtons: sanitizeButtonList(leftButtons),
              rightButtons: sanitizeButtonList(rightButtons),
            },
          };
        }),
      toggleButtonVisibility: (buttonId, _side) =>
        set((state) => {
          // Only record `false` (hidden) or omit (visible). Mirrors the
          // pre-v8 `hiddenButtons` semantic — the map only tracks departures
          // from the default, never redundantly persisting `true` for every
          // visible button.
          const pinned: ToolbarPinnedState = { ...state.layout.pinnedButtons };
          if (pinned[buttonId] === false) {
            delete pinned[buttonId];
          } else {
            pinned[buttonId] = false;
          }
          return {
            layout: { ...state.layout, pinnedButtons: pinned },
          };
        }),
      setPluginButtonPromoted: (buttonId, promoted) =>
        set((state) => {
          const current = state.layout.pinnedButtons[buttonId];
          if (promoted ? current === true : current === undefined) return state;
          const pinned: ToolbarPinnedState = { ...state.layout.pinnedButtons };
          if (promoted) {
            pinned[buttonId] = true;
          } else {
            delete pinned[buttonId];
          }
          return {
            layout: { ...state.layout, pinnedButtons: pinned },
          };
        }),
      sweepStalePluginPinnedButtons: (validIds) =>
        set((state) => {
          const validSet = new Set(validIds);
          const staleKeys = Object.keys(state.layout.pinnedButtons).filter(
            (key) =>
              key.includes(".") &&
              !validSet.has(key) &&
              // Never reclaim an explicit promotion (#11304). A `complete`
              // broadcast means "a plugin unloaded", not "a plugin was
              // uninstalled" — `unloadPlugin` also runs for an update and for
              // disable/re-enable, so sweeping promotions here would silently
              // undo the user's placement every time a plugin updates. A
              // promotion left behind by a genuine uninstall is inert (no
              // registry entry means nothing renders) and restores the user's
              // choice if they reinstall.
              state.layout.pinnedButtons[key as AnyToolbarButtonId] !== true
          );
          if (staleKeys.length === 0) return state;
          const pinned: ToolbarPinnedState = { ...state.layout.pinnedButtons };
          for (const key of staleKeys) {
            delete pinned[key as AnyToolbarButtonId];
          }
          return {
            layout: { ...state.layout, pinnedButtons: pinned },
          };
        }),
      setAlwaysShowDevServer: (value) =>
        set((state) => ({
          launcher: { ...state.launcher, alwaysShowDevServer: value },
        })),
      setDefaultSelection: (selection) =>
        set((state) => ({
          launcher: { ...state.launcher, defaultSelection: selection },
        })),
      setDefaultAgent: (agent) =>
        set((state) => ({
          launcher: { ...state.launcher, defaultAgent: agent },
        })),
      reset: () => set(DEFAULT_PREFERENCES),
    }),
    {
      name: "daintree-toolbar-preferences",
      version: 11,
      storage: createSafeJSONStorage<ToolbarPreferencesPersistedState>({
        mergeOnWrite: mergeToolbarPreferencesPersistedWrite,
      }),
      migrate: (persisted, version) => {
        const state = persisted as Record<string, unknown>;
        if (version < 1) {
          const layout = state.layout as
            { leftButtons?: string[]; rightButtons?: string[] } | undefined;
          if (layout?.leftButtons) {
            layout.leftButtons = layout.leftButtons.filter((id) => id !== "dev-server");
          }
          if (layout?.rightButtons) {
            layout.rightButtons = layout.rightButtons.filter((id) => id !== "dev-server");
          }
          const launcher = state.launcher as { defaultSelection?: string } | undefined;
          if (launcher?.defaultSelection === "dev-server") {
            launcher.defaultSelection = undefined;
          }
        }
        if (version < 2) {
          const layout = state.layout as Record<string, unknown> | undefined;
          if (layout && !Array.isArray(layout.hiddenButtons)) {
            layout.hiddenButtons = [];
          }
        }
        if (version < 3) {
          const layout = state.layout as
            | { leftButtons?: string[]; rightButtons?: string[]; hiddenButtons?: string[] }
            | undefined;
          const renameAgentSetup = (buttons?: string[]) => {
            if (!buttons) return buttons;
            const renamed = buttons.map((id) => (id === "agent-setup" ? "agent-tray" : id));
            // Dedupe so a persisted list that already contained "agent-tray"
            // does not produce duplicate React keys after the rename.
            return Array.from(new Set(renamed));
          };
          if (layout) {
            layout.leftButtons = renameAgentSetup(layout.leftButtons);
            layout.rightButtons = renameAgentSetup(layout.rightButtons);
            layout.hiddenButtons = renameAgentSetup(layout.hiddenButtons);
          }
        }
        if (version < 4) {
          const layout = state.layout as
            | { leftButtons?: string[]; rightButtons?: string[]; hiddenButtons?: string[] }
            | undefined;
          if (layout) {
            const drop = (buttons?: string[]) => buttons?.filter((id) => id !== "panel-palette");
            layout.leftButtons = drop(layout.leftButtons);
            layout.rightButtons = drop(layout.rightButtons);
            layout.hiddenButtons = drop(layout.hiddenButtons);
          }
        }
        if (version < 5) {
          // Agent visibility moved to `agentSettingsStore.settings.agents[id].pinned`.
          // Stale agent IDs in `hiddenButtons` from older versions would shadow the
          // canonical pinned state after this migration, so strip them.
          const layout = state.layout as { hiddenButtons?: string[] } | undefined;
          if (layout?.hiddenButtons) {
            const agentIds = new Set<string>(BUILT_IN_AGENT_IDS);
            layout.hiddenButtons = layout.hiddenButtons.filter((id) => !agentIds.has(id));
          }
        }
        if (version < 6) {
          // The Notes panel feature was removed (#5616). Strip any persisted
          // "notes" entries from button lists so existing users don't see a
          // ghost button referring to a missing kind.
          const layout = state.layout as
            | { leftButtons?: string[]; rightButtons?: string[]; hiddenButtons?: string[] }
            | undefined;
          if (layout) {
            const drop = (buttons?: string[]) => buttons?.filter((id) => id !== "notes");
            layout.leftButtons = drop(layout.leftButtons);
            layout.rightButtons = drop(layout.rightButtons);
            layout.hiddenButtons = drop(layout.hiddenButtons);
          }
        }
        if (version < 7) {
          // "assistant-toggle" became a fixed pinned button alongside
          // "portal-toggle" (#6748). Strip any stray persisted entries so
          // mid-rollout users don't end up with a ghost in a variable list.
          const layout = state.layout as
            | { leftButtons?: string[]; rightButtons?: string[]; hiddenButtons?: string[] }
            | undefined;
          if (layout) {
            const drop = (buttons?: string[]) => buttons?.filter((id) => id !== "assistant-toggle");
            layout.leftButtons = drop(layout.leftButtons);
            layout.rightButtons = drop(layout.rightButtons);
            layout.hiddenButtons = drop(layout.hiddenButtons);
          }
        }
        if (version < 8) {
          // Replace the `hiddenButtons` array with a `pinnedButtons` map so
          // visibility uses the same tri-state semantics as agent pinning
          // (#7666). Existing hides translate to explicit `false` entries.
          const layout = state.layout as
            { hiddenButtons?: unknown; pinnedButtons?: Record<string, boolean> } | undefined;
          if (layout) {
            const pinned: Record<string, boolean> = { ...(layout.pinnedButtons ?? {}) };
            const hidden = Array.isArray(layout.hiddenButtons) ? layout.hiddenButtons : [];
            for (const id of hidden) {
              if (typeof id === "string") pinned[id] = false;
            }
            layout.pinnedButtons = pinned;
            delete layout.hiddenButtons;
          } else {
            // Older payloads that never had a layout block at all still need a
            // valid v8 shape so `merge()` doesn't fall back to overwriting the
            // freshly-built `pinnedButtons` with the default empty map.
            state.layout = { pinnedButtons: {} } as unknown as Record<string, unknown>;
          }
        }
        if (version < 9) {
          // Plugin toolbar buttons migrated from `plugin.{pluginId}.{btn}` to
          // canonical `{pluginId}.{btn}` (#9281). Rename persisted pin keys
          // AND the position arrays (`leftButtons`/`rightButtons`, populated
          // by `moveButton` when a user drags a plugin button into a fixed
          // slot) so user state survives the rename. Without the array
          // rename, those entries would become dangling references that
          // match no registered button config — producing phantom slots.
          // Built-in ids never start with `plugin.`, so non-prefixed keys
          // pass through unchanged.
          const stripPluginPrefix = (id: string): string =>
            id.startsWith("plugin.") ? id.slice("plugin.".length) : id;
          const layout = state.layout as
            | {
                pinnedButtons?: Record<string, boolean>;
                leftButtons?: string[];
                rightButtons?: string[];
              }
            | undefined;
          if (layout?.pinnedButtons) {
            const renamed: Record<string, boolean> = {};
            for (const [key, value] of Object.entries(layout.pinnedButtons)) {
              renamed[stripPluginPrefix(key)] = value;
            }
            layout.pinnedButtons = renamed;
          }
          if (Array.isArray(layout?.leftButtons)) {
            layout.leftButtons = layout.leftButtons.map(stripPluginPrefix);
          }
          if (Array.isArray(layout?.rightButtons)) {
            layout.rightButtons = layout.rightButtons.map(stripPluginPrefix);
          }
        }
        if (version < 10) {
          // The stats button went forge-neutral: persisted id "github-stats"
          // became "forge-stats". Rename the position arrays and pin map keys
          // so user pin/hide layout prefs survive.
          const renameForgeStats = (id: string): string =>
            id === "github-stats" ? "forge-stats" : id;
          const layout = state.layout as
            | {
                pinnedButtons?: Record<string, boolean>;
                leftButtons?: string[];
                rightButtons?: string[];
              }
            | undefined;
          if (layout?.pinnedButtons) {
            const renamed: Record<string, boolean> = {};
            for (const [key, value] of Object.entries(layout.pinnedButtons)) {
              renamed[renameForgeStats(key)] = value;
            }
            layout.pinnedButtons = renamed;
          }
          if (Array.isArray(layout?.leftButtons)) {
            layout.leftButtons = layout.leftButtons.map(renameForgeStats);
          }
          if (Array.isArray(layout?.rightButtons)) {
            layout.rightButtons = layout.rightButtons.map(renameForgeStats);
          }
        }
        if (version < 11) {
          // One-time heal for profiles that accumulated duplicate button ids —
          // chiefly repeated `forge-stats` from the v10 rename landing on a list
          // that already held one, compounded by shared dev-profile round-trips
          // (#10937). The v10 `renameForgeStats` step above used a bare `.map()`
          // with no dedup, unlike the v3 `renameAgentSetup` precedent. `merge()`
          // (via `sanitizeButtonList`) already dedupes on every load; this makes
          // the repair explicit and matches the per-version migration
          // convention. `pinnedButtons` is a map, so its keys can't duplicate.
          const layout = state.layout as
            { leftButtons?: string[]; rightButtons?: string[] } | undefined;
          const dedupe = (buttons?: string[]) =>
            Array.isArray(buttons) ? Array.from(new Set(buttons)) : buttons;
          if (layout) {
            layout.leftButtons = dedupe(layout.leftButtons);
            layout.rightButtons = dedupe(layout.rightButtons);
          }
        }
        return state as unknown as ToolbarPreferencesState;
      },
      partialize: (state) => ({
        layout: state.layout,
        launcher: {
          alwaysShowDevServer: state.launcher.alwaysShowDevServer,
          defaultSelection: state.launcher.defaultSelection,
        },
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<ToolbarPreferencesState>;
        return {
          ...currentState,
          ...persisted,
          layout: {
            leftButtons: mergeButtonList(
              persisted.layout?.leftButtons,
              currentState.layout.leftButtons
            ),
            rightButtons: mergeButtonList(
              persisted.layout?.rightButtons,
              currentState.layout.rightButtons
            ),
            pinnedButtons: persisted.layout?.pinnedButtons ?? {},
          },
        };
      },
    }
  )
);

registerPersistedStore({
  storeId: "toolbarPreferencesStore",
  store: useToolbarPreferencesStore,
  persistedStateType:
    "{ layout: ToolbarPreferences['layout']; launcher: Pick<ToolbarPreferences['launcher'], 'alwaysShowDevServer' | 'defaultSelection'> }",
});
