import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  ToolbarPreferences,
  ToolbarButtonId,
  AnyToolbarButtonId,
  ToolbarPinnedState,
} from "@/../../shared/types/toolbar";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";

const DEFAULT_LEFT_BUTTONS: ToolbarButtonId[] = [
  "agent-tray",
  ...(BUILT_IN_AGENT_IDS as unknown as ToolbarButtonId[]),
  "terminal",
  "browser",
  "dev-server",
];

const DEFAULT_RIGHT_BUTTONS: ToolbarButtonId[] = [
  "voice-recording",
  "github-stats",
  "notification-center",
  "copy-tree",
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
  return buttons.filter((id) => !FIXED_BUTTON_IDS.includes(id as ToolbarButtonId));
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
   * Prune `pinnedButtons` entries for plugin buttons (`plugin.` prefix) that
   * are no longer in the loaded plugin set. `pinnedButtons` is renderer-local
   * persisted state with no main-process access, so an uninstalled plugin's
   * stale hide entry can only be swept here, driven by the plugin lifecycle
   * snapshot in `usePluginToolbarButtons`. Built-in (non-`plugin.`) keys are
   * never touched. No-ops (returns state unchanged) when nothing is stale so
   * the per-snapshot call doesn't churn the persist layer.
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
            layout: { ...state.layout, leftButtons, rightButtons },
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
      sweepStalePluginPinnedButtons: (validIds) =>
        set((state) => {
          const validSet = new Set(validIds);
          const staleKeys = Object.keys(state.layout.pinnedButtons).filter(
            (key) => key.startsWith("plugin.") && !validSet.has(key)
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
      version: 8,
      storage: createSafeJSONStorage(),
      migrate: (persisted, version) => {
        const state = persisted as Record<string, unknown>;
        if (version < 1) {
          const layout = state.layout as
            | { leftButtons?: string[]; rightButtons?: string[] }
            | undefined;
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
            | { hiddenButtons?: unknown; pinnedButtons?: Record<string, boolean> }
            | undefined;
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
