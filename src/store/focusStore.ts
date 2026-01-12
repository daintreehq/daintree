import { create, type StateCreator } from "zustand";

export interface PanelState {
  sidebarWidth: number;
  diagnosticsOpen: boolean;
}

interface FocusState {
  isFocusMode: boolean;
  savedPanelState: PanelState | null;

  toggleFocusMode: (currentPanelState: PanelState) => void;
  setFocusMode: (enabled: boolean, currentPanelState?: PanelState) => void;
  getSavedPanelState: () => PanelState | null;
  reset: () => void;
}

const createFocusStore: StateCreator<FocusState> = (set, get) => ({
  isFocusMode: false,
  savedPanelState: null,

  toggleFocusMode: (currentPanelState) =>
    set((state) => {
      if (state.isFocusMode) {
        return { isFocusMode: false, savedPanelState: null };
      } else {
        return { isFocusMode: true, savedPanelState: currentPanelState };
      }
    }),

  setFocusMode: (enabled, savedOrCurrentPanelState) =>
    set((state) => {
      if (enabled && !state.isFocusMode) {
        // When enabling focus mode, save the panel state (either passed in or null)
        return { isFocusMode: true, savedPanelState: savedOrCurrentPanelState ?? null };
      } else if (!enabled && state.isFocusMode) {
        return { isFocusMode: false, savedPanelState: null };
      } else if (enabled && state.isFocusMode && savedOrCurrentPanelState) {
        // Already in focus mode but restoring saved panel state (hydration case)
        return { ...state, savedPanelState: savedOrCurrentPanelState };
      }
      return state;
    }),

  getSavedPanelState: () => get().savedPanelState,

  reset: () =>
    set({
      isFocusMode: false,
      savedPanelState: null,
    }),
});

export const useFocusStore = create<FocusState>(createFocusStore);
