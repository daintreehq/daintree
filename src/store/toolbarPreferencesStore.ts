import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";
import type { ToolbarPreferences, ToolbarButtonId } from "@/../../shared/types/domain";

const memoryStorage: StateStorage = (() => {
  const storage = new Map<string, string>();
  return {
    getItem: (name) => storage.get(name) ?? null,
    setItem: (name, value) => {
      storage.set(name, value);
    },
    removeItem: (name) => {
      storage.delete(name);
    },
  };
})();

function getSafeStorage(): StateStorage {
  if (typeof localStorage !== "undefined") {
    return localStorage;
  }
  return memoryStorage;
}

const DEFAULT_LEFT_BUTTONS: ToolbarButtonId[] = [
  "assistant",
  "claude",
  "gemini",
  "codex",
  "opencode",
  "terminal",
  "browser",
  "dev-server",
];

const DEFAULT_RIGHT_BUTTONS: ToolbarButtonId[] = [
  "github-stats",
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

const FIXED_BUTTON_IDS: ToolbarButtonId[] = ["sidebar-toggle", "sidecar-toggle"];

function sanitizeButtonList(buttons: ToolbarButtonId[]): ToolbarButtonId[] {
  return buttons.filter((id) => !FIXED_BUTTON_IDS.includes(id));
}

interface ToolbarPreferencesState extends ToolbarPreferences {
  setLeftButtons: (buttons: ToolbarButtonId[]) => void;
  setRightButtons: (buttons: ToolbarButtonId[]) => void;
  moveButton: (
    buttonId: ToolbarButtonId,
    from: "left" | "right",
    to: "left" | "right",
    toIndex: number
  ) => void;
  toggleButtonVisibility: (buttonId: ToolbarButtonId, side: "left" | "right") => void;
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
      storage: createJSONStorage(() => getSafeStorage()),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<ToolbarPreferencesState>;
        return {
          ...currentState,
          ...persisted,
          layout: {
            leftButtons: sanitizeButtonList(
              persisted.layout?.leftButtons ?? currentState.layout.leftButtons
            ),
            rightButtons: sanitizeButtonList(
              persisted.layout?.rightButtons ?? currentState.layout.rightButtons
            ),
          },
        };
      },
    }
  )
);
