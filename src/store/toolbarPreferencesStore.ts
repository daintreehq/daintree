import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { StorageValue } from "zustand/middleware";
import type {
  ToolbarPreferences,
  ToolbarButtonId,
  AnyToolbarButtonId,
  PanelTrayButtonId,
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

/**
 * `browser` and `dev-server` are deliberately absent (#11667). Both assume web
 * development; the file browser assumes only that the project has files, so it
 * takes the first-class slot and the other two move into the panel tray.
 *
 * Absence from this array — not a seeded `pinnedButtons` entry — is what makes
 * them ship hidden. `mergeButtonList` only ever *adds* defaults a profile is
 * missing and never removes an id a profile carries, so an existing toolbar
 * keeps both buttons untouched while a fresh one never grows them. That
 * per-profile discriminator is the whole reason no migration has to stamp
 * anything: see the `ToolbarPinnedState` doc comment on why stamping a default
 * would forfeit the ability to ever change it again.
 */
const DEFAULT_LEFT_BUTTONS: ToolbarButtonId[] = [
  "agent-tray",
  ...(LAUNCHABLE_AGENT_IDS as unknown as ToolbarButtonId[]),
  "terminal",
  "file-browser",
  "panel-tray",
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
    // Always empty, and there is no `DEFAULT_PINNED_BUTTONS` constant to seed it
    // from any more (#11667). A default belongs in the arrays above; this map
    // holds user overrides only, so a fresh profile has nothing to say here.
    // Reintroducing a seeded default would repeat the v12 mistake — see the
    // `ToolbarPinnedState` doc comment.
    pinnedButtons: {},
  },
  launcher: {
    alwaysShowDevServer: false,
    defaultSelection: undefined,
  },
};

const FIXED_BUTTON_IDS: ToolbarButtonId[] = ["sidebar-toggle", "assistant-toggle", "portal-toggle"];

/**
 * Home side lookup, used *only* to pick the survivor when an id sits on both
 * sides. Deliberately not `DEFAULT_LEFT_BUTTONS` itself: `browser` and
 * `dev-server` left the defaults in v13 (#11667) but a profile old enough to
 * carry a cross-side duplicate of one still had it as a left-side button when
 * the duplicate formed. Reading the live defaults here would flip the repair for
 * exactly those profiles and keep the copy the user dragged *away* from.
 *
 * Membership here never causes a button to be inserted anywhere — that is
 * `mergeButtonList`'s job, and it reads the defaults, not this set.
 */
const LEFT_HOME_BUTTON_IDS: ToolbarButtonId[] = [...DEFAULT_LEFT_BUTTONS, "browser", "dev-server"];
const DEFAULT_LEFT_BUTTON_SET = new Set<AnyToolbarButtonId>(LEFT_HOME_BUTTON_IDS);

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
 * Split an id that ended up on BOTH sides back onto one.
 *
 * Hydration before #11495 re-materialized a default that was missing from its
 * home side, so moving one across sides left a copy on each — and because
 * `sanitizeButtonList` only dedupes within a list, the pair round-tripped to disk
 * and rendered twice. `mergeButtonList` no longer creates that, but profiles
 * already carrying it still need the repair, which is why this runs on every
 * hydration instead of in a version-gated migration (#10938).
 *
 * The survivor reconstructs the move that caused the duplicate: a default on both
 * sides is kept on the side that is NOT its home, because that is where the user
 * dragged it. Anything else (plugin ids, unknowns) keeps its left-hand
 * occurrence, so the outcome is at least deterministic.
 */
function healCrossSideDuplicates(
  persistedLeft: AnyToolbarButtonId[] | undefined,
  persistedRight: AnyToolbarButtonId[] | undefined
): {
  leftButtons: AnyToolbarButtonId[] | undefined;
  rightButtons: AnyToolbarButtonId[] | undefined;
} {
  if (!persistedLeft || !persistedRight) {
    return { leftButtons: persistedLeft, rightButtons: persistedRight };
  }
  const rightSet = new Set(persistedRight);
  const onBothSides = persistedLeft.filter((id) => rightSet.has(id));
  if (onBothSides.length === 0) {
    return { leftButtons: persistedLeft, rightButtons: persistedRight };
  }
  const keepOnRight = new Set(onBothSides.filter((id) => DEFAULT_LEFT_BUTTON_SET.has(id)));
  const keepOnLeft = new Set(onBothSides.filter((id) => !keepOnRight.has(id)));
  return {
    leftButtons: persistedLeft.filter((id) => !keepOnRight.has(id)),
    rightButtons: persistedRight.filter((id) => !keepOnLeft.has(id)),
  };
}

/**
 * Merge persisted button list with defaults, adding any new buttons that
 * were added to defaults after the user's preferences were saved.
 * New buttons are added at their default position.
 *
 * `otherSidePersisted` is the opposite side's persisted list, and it is what
 * makes a side switch survive a reload. `sanitizeButtonList` dedupes within a
 * side but cannot see across the two, so without this check a default that the
 * user dragged to the other side reads as "missing" here and gets
 * re-materialized on its home side — leaving the id on BOTH sides, rendering
 * twice. Defaults own insertion and ordering; a persisted position on either
 * side always wins over the default one.
 */
function mergeButtonList(
  persisted: AnyToolbarButtonId[] | undefined,
  defaults: AnyToolbarButtonId[],
  otherSidePersisted: AnyToolbarButtonId[] | undefined
): AnyToolbarButtonId[] {
  const onOtherSide = new Set(otherSidePersisted ?? []);
  // No list of our own: still honor a default the user parked on the other side.
  if (!persisted) return defaults.filter((id) => !onOtherSide.has(id));

  const positioned = new Set([...persisted, ...onOtherSide]);
  const result = [...persisted];

  // Find buttons in defaults that aren't positioned on either side (new buttons)
  for (let i = 0; i < defaults.length; i++) {
    const buttonId = defaults[i]!;
    if (!positioned.has(buttonId)) {
      // Insert at the same position as in defaults, or at end if beyond length
      const insertIndex = Math.min(i, result.length);
      result.splice(insertIndex, 0, buttonId);
      positioned.add(buttonId); // Track that we've added it
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
      // Both a missing and an explicitly-stored-empty map normalize to `{}`,
      // because as of #11667 no built-in ships hidden and the defaults carry no
      // pins to preserve. The distinction used to matter: while `file-browser`
      // shipped as a seeded `false`, normalizing a *missing* map to `{}` made a
      // sibling view's untouched seed look like a fresh edit and reverted
      // another view's opt-in (#11495). With nothing seeded there is no baseline
      // `false` left to misread, so the two cases converge.
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
 * must never diff against a foreign schema version — the 12-step migrate chain
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
   * Give a panel-tray button its own top-level toolbar slot, or take it away
   * (#11667).
   *
   * Distinct from `toggleButtonVisibility` because that only ever touches
   * `pinnedButtons`, and since v13 `browser`/`dev-server` are absent from
   * `DEFAULT_LEFT_BUTTONS` — so on a fresh profile they sit in neither side
   * array and clearing a pin alone would leave them with nowhere to render.
   *
   * Showing deletes any hide entry and, only when the id is positioned on
   * neither side, gives it one; it never writes `true`. A positioned built-in
   * with no pin entry is already visible, so a `true` would record nothing the
   * arrays don't already say — and seeding this map with values the user did not
   * choose is the v12 mistake (see `ToolbarPinnedState`).
   *
   * Hiding writes `false` and leaves the position alone, exactly like
   * `toggleButtonVisibility`, so re-showing restores the button where the user
   * had it rather than appending it somewhere new.
   */
  setPanelButtonOnToolbar: (buttonId: PanelTrayButtonId, onToolbar: boolean) => void;
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
      setPanelButtonOnToolbar: (buttonId, onToolbar) =>
        set((state) => {
          const pinned: ToolbarPinnedState = { ...state.layout.pinnedButtons };
          if (!onToolbar) {
            if (pinned[buttonId] === false) return state;
            pinned[buttonId] = false;
            return { layout: { ...state.layout, pinnedButtons: pinned } };
          }

          delete pinned[buttonId];
          const isPositioned =
            state.layout.leftButtons.includes(buttonId) ||
            state.layout.rightButtons.includes(buttonId);
          if (isPositioned) {
            if (state.layout.pinnedButtons[buttonId] === undefined) return state;
            return { layout: { ...state.layout, pinnedButtons: pinned } };
          }

          // Unpositioned: land it next to the tray it was promoted from, so the
          // panel buttons stay grouped instead of the id appearing at whichever
          // end of the row a bare append would put it. `panel-tray` can only be
          // missing from a hand-edited profile, in which case the left side is
          // where these buttons have always lived (`LEFT_HOME_BUTTON_IDS`).
          const trayOnRight = state.layout.rightButtons.includes("panel-tray");
          const side = trayOnRight ? "rightButtons" : "leftButtons";
          const target = [...state.layout[side]];
          const trayIndex = target.indexOf("panel-tray");
          target.splice(trayIndex === -1 ? target.length : trayIndex, 0, buttonId);
          return {
            layout: { ...state.layout, pinnedButtons: pinned, [side]: sanitizeButtonList(target) },
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
      version: 13,
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
        if (version < 12) {
          // `file-browser` joined the built-in buttons (#11495). It's offered in
          // Settings → Toolbar but must not appear on anyone's existing toolbar,
          // so every pre-v12 profile gets an explicit hide.
          //
          // Unconditional, with no carve-out for what the user already shows:
          // inferring "this user probably wants it" from their current layout is
          // the trap #10709 documents — a newly-introduced default belongs in the
          // safe state for every pre-existing install, without exception.
          //
          // Only `pinnedButtons` is touched. Position is left to `merge()`, whose
          // `mergeButtonList` already inserts a newly-defaulted id on every
          // hydration; pushing it into the arrays here as well is how a profile
          // ends up with the same id twice (#10938).
          //
          // Spelled out rather than spread from `DEFAULT_PINNED_BUTTONS` on
          // purpose: a shipped migration step has to keep doing exactly what it
          // did when it shipped. Pointing it at the live constant would make the
          // next ships-hidden button silently re-stamp itself here, overwriting a
          // choice its own migration step should own.
          //
          // Narrowed rather than asserted, unlike the older steps above: `state`
          // is already `Record<string, unknown>`, so `in`/`typeof` guards reach
          // the same place without a type assertion — and the lint ratchet scores
          // `no-unsafe-type-assertion` per rule, so a new one costs a baseline
          // bump the ratchet exists to prevent.
          const layout = state.layout;
          const hasLayout = typeof layout === "object" && layout !== null && !Array.isArray(layout);
          const existingPins = hasLayout && "pinnedButtons" in layout ? layout.pinnedButtons : null;
          const carriedPins =
            typeof existingPins === "object" &&
            existingPins !== null &&
            !Array.isArray(existingPins)
              ? existingPins
              : {};
          state.layout = {
            ...(hasLayout ? layout : {}),
            pinnedButtons: { ...carriedPins, "file-browser": false },
          };
        }
        if (version < 13) {
          // Undo the v12 stamp above (#11667). `file-browser` now ships visible,
          // and the `false` v12 wrote onto every profile was never user intent —
          // removing it repairs a bad write rather than overriding a preference.
          //
          // Only a literal `false` is removed. A `true` is left alone: nothing
          // writes `true` for a built-in, so one can only have arrived from a
          // hand-edited profile, and deleting it would be the same overreach v12
          // committed.
          //
          // One reset is unavoidable and is NOT a bug: a user who deliberately
          // hid `file-browser` after v12 carries the identical `false` as the
          // stamp, so the button reappears for them once. The two are
          // indistinguishable precisely because v12 materialized a default into
          // user state — the reason this map now records overrides only. The
          // affected population is small: the shipped state was already hidden,
          // so hiding it again required showing it first.
          //
          // `browser` and `dev-server` are deliberately untouched — no `false`
          // stamp, no position change. They ship absent from the *defaults*
          // (`DEFAULT_LEFT_BUTTONS`), which leaves every existing profile's copy
          // exactly where it is while fresh profiles never grow one. Stamping
          // them here would mass-backfill a default into existing records and
          // forfeit the ability to change it again, which is the whole mistake
          // this step exists to undo.
          //
          // `panel-tray` needs no placement here either: `mergeButtonList`
          // inserts a newly-defaulted id on every hydration, and pushing it into
          // the arrays as well is how a profile ends up with the id twice
          // (#10938).
          //
          // Narrowed rather than asserted, matching the v12 step: `state` is
          // already `Record<string, unknown>`, so `in`/`typeof` guards reach the
          // same place without a type assertion, and the lint ratchet scores
          // `no-unsafe-type-assertion` per rule.
          const layout = state.layout;
          const hasLayout = typeof layout === "object" && layout !== null && !Array.isArray(layout);
          const existingPins = hasLayout && "pinnedButtons" in layout ? layout.pinnedButtons : null;
          const carriedPins =
            typeof existingPins === "object" &&
            existingPins !== null &&
            !Array.isArray(existingPins)
              ? existingPins
              : {};
          const repairedPins = Object.fromEntries(
            Object.entries(carriedPins).filter(
              ([key, value]) => !(key === "file-browser" && value === false)
            )
          );
          state.layout = {
            ...(hasLayout ? layout : {}),
            pinnedButtons: repairedPins,
          };
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
        // `persistedState` really is undefined on a fresh install — zustand calls
        // `merge` even with nothing in storage. Guarding here instead of letting
        // the dereference throw into zustand's exception-swallowing thenable is
        // what makes the ships-hidden default an explicit outcome rather than a
        // side effect of where the throw landed, and it lets `hasHydrated()`
        // resolve at all.
        const persisted = (persistedState ?? {}) as Partial<ToolbarPreferencesState>;
        const healed = healCrossSideDuplicates(
          persisted.layout?.leftButtons,
          persisted.layout?.rightButtons
        );
        return {
          ...currentState,
          ...persisted,
          layout: {
            leftButtons: mergeButtonList(
              healed.leftButtons,
              currentState.layout.leftButtons,
              healed.rightButtons
            ),
            rightButtons: mergeButtonList(
              healed.rightButtons,
              currentState.layout.rightButtons,
              healed.leftButtons
            ),
            // A literal `{}`, never `currentState.layout.pinnedButtons`: on a
            // re-`rehydrate()` zustand passes live state here rather than the
            // creator defaults, so reading from it would carry the previous
            // blob's pins into a blob that has none. There is no default pin map
            // to fall back to any more (#11667) — a profile with no persisted
            // pins has expressed no overrides, and every built-in it positions
            // is therefore visible.
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
