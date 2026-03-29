import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  ToolbarPreferences,
  ToolbarButtonId,
  AnyToolbarButtonId,
} from "@/../../shared/types/toolbar";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import { isRegisteredPluginButton } from "@shared/config/toolbarButtonRegistry";

const DEFAULT_LEFT_BUTTONS: ToolbarButtonId[] = [
  "agent-setup",
  ...(BUILT_IN_AGENT_IDS as unknown as ToolbarButtonId[]),
  "terminal",
  "browser",
  "panel-palette",
];

const DEFAULT_RIGHT_BUTTONS: ToolbarButtonId[] = [
  "voice-recording",
  "github-stats",
  "notification-center",
  "notes",
  "copy-tree",
  "settings",
  "problems",
];

const DEFAULT_PREFERENCES: ToolbarPreferences = {
  layout: {
    leftButtons: DEFAULT_LEFT_BUTTONS,
    rightButtons: DEFAULT_RIGHT_BUTTONS,
  },
  launcher: {
    alwaysShowDevServer: false,
    defaultSelection: undefined,
  },
};

const FIXED_BUTTON_IDS: ToolbarButtonId[] = ["sidebar-toggle", "portal-toggle"];

function sanitizeButtonList(buttons: AnyToolbarButtonId[]): AnyToolbarButtonId[] {
  return buttons.filter((id) => {
    if (FIXED_BUTTON_IDS.includes(id as ToolbarButtonId)) return false;
    if (id.startsWith("plugin.") && !isRegisteredPluginButton(id)) return false;
    return true;
  });
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
    const buttonId = defaults[i];
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
            layout: { leftButtons, rightButtons },
          };
        }),
      toggleButtonVisibility: (buttonId, side) =>
        set((state) => {
          const sideKey = side === "left" ? "leftButtons" : "rightButtons";
          const buttons = [...state.layout[sideKey]];
          const index = buttons.indexOf(buttonId);

          if (index === -1) {
            buttons.push(buttonId);
          } else {
            buttons.splice(index, 1);
          }

          return {
            layout: { ...state.layout, [sideKey]: buttons },
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
      name: "canopy-toolbar-preferences",
      version: 1,
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
          },
        };
      },
    }
  )
);
