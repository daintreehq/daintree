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
  "claude",
  "gemini",
  "codex",
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

interface ToolbarPreferencesState extends ToolbarPreferences {
  setLeftButtons: (buttons: ToolbarButtonId[]) => void;
  setRightButtons: (buttons: ToolbarButtonId[]) => void;
  moveButton: (buttonId: ToolbarButtonId, from: "left" | "right", to: "left" | "right", toIndex: number) => void;
  toggleButtonVisibility: (buttonId: ToolbarButtonId, side: "left" | "right") => void;
  setAlwaysShowDevServer: (value: boolean) => void;
  setDefaultSelection: (selection: ToolbarPreferences["launcher"]["defaultSelection"]) => void;
  reset: () => void;
}

export const useToolbarPreferencesStore = create<ToolbarPreferencesState>()(
  persist(
    (set) => ({
      ...DEFAULT_PREFERENCES,
      setLeftButtons: (buttons) =>
        set((state) => ({
          layout: { ...state.layout, leftButtons: buttons },
        })),
      setRightButtons: (buttons) =>
        set((state) => ({
          layout: { ...state.layout, rightButtons: buttons },
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
      reset: () => set(DEFAULT_PREFERENCES),
    }),
    {
      name: "canopy-toolbar-preferences",
      storage: createJSONStorage(() => getSafeStorage()),
    }
  )
);
