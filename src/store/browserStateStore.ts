import { create, type StateCreator } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export interface BrowserHistory {
  past: string[];
  future: string[];
}

export interface BrowserPanelState {
  url: string;
  history: BrowserHistory;
}

interface BrowserStateState {
  panelStates: Record<string, BrowserPanelState>;
}

interface BrowserStateActions {
  getState: (panelId: string) => BrowserPanelState | undefined;
  setState: (panelId: string, state: BrowserPanelState) => void;
  updateUrl: (panelId: string, url: string, history: BrowserHistory) => void;
  clearState: (panelId: string) => void;
  reset: () => void;
}

const initialState: BrowserStateState = {
  panelStates: {},
};

const createBrowserStateStore: StateCreator<BrowserStateState & BrowserStateActions> = (
  set,
  get
) => ({
  ...initialState,

  getState: (panelId) => get().panelStates[panelId],

  setState: (panelId, state) =>
    set((s) => ({
      panelStates: {
        ...s.panelStates,
        [panelId]: state,
      },
    })),

  updateUrl: (panelId, url, history) =>
    set((s) => ({
      panelStates: {
        ...s.panelStates,
        [panelId]: { url, history },
      },
    })),

  clearState: (panelId) =>
    set((s) => {
      const { [panelId]: _, ...rest } = s.panelStates;
      return { panelStates: rest };
    }),

  reset: () => set(initialState),
});

const browserStateStoreCreator: StateCreator<
  BrowserStateState & BrowserStateActions,
  [],
  [["zustand/persist", Partial<BrowserStateState>]]
> = persist(createBrowserStateStore, {
  name: "browser-state-storage",
  storage: createJSONStorage(() => {
    return typeof window !== "undefined" ? localStorage : (undefined as never);
  }),
  partialize: (state) => ({
    panelStates: state.panelStates,
  }),
});

export const useBrowserStateStore = create<BrowserStateState & BrowserStateActions>()(
  browserStateStoreCreator
);
