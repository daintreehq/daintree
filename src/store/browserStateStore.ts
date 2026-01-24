import { create, type StateCreator } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export interface BrowserHistory {
  past: string[];
  future: string[];
}

export interface BrowserPanelState {
  url: string;
  history: BrowserHistory;
  zoomFactor?: number;
}

interface BrowserStateState {
  panelStates: Record<string, BrowserPanelState>;
}

function makeScopedKey(panelId: string, worktreeId?: string): string {
  if (worktreeId !== undefined && worktreeId !== null && worktreeId !== "") {
    return `${worktreeId}:${panelId}`;
  }
  return panelId;
}

interface BrowserStateActions {
  getState: (panelId: string, worktreeId?: string) => BrowserPanelState | undefined;
  setState: (panelId: string, state: BrowserPanelState, worktreeId?: string) => void;
  updateUrl: (panelId: string, url: string, history: BrowserHistory, worktreeId?: string) => void;
  updateZoomFactor: (panelId: string, zoomFactor: number, worktreeId?: string) => void;
  clearState: (panelId: string, worktreeId?: string) => void;
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

  getState: (panelId, worktreeId) => {
    const key = makeScopedKey(panelId, worktreeId);
    return get().panelStates[key];
  },

  setState: (panelId, state, worktreeId) => {
    const key = makeScopedKey(panelId, worktreeId);
    set((s) => ({
      panelStates: {
        ...s.panelStates,
        [key]: state,
      },
    }));
  },

  updateUrl: (panelId, url, history, worktreeId) => {
    const key = makeScopedKey(panelId, worktreeId);
    set((s) => ({
      panelStates: {
        ...s.panelStates,
        [key]: {
          ...s.panelStates[key],
          url,
          history,
        },
      },
    }));
  },

  updateZoomFactor: (panelId, zoomFactor, worktreeId) => {
    const key = makeScopedKey(panelId, worktreeId);
    set((s) => ({
      panelStates: {
        ...s.panelStates,
        [key]: {
          ...s.panelStates[key],
          url: s.panelStates[key]?.url ?? "",
          history: s.panelStates[key]?.history ?? { past: [], future: [] },
          zoomFactor,
        },
      },
    }));
  },

  clearState: (panelId, worktreeId) => {
    const key = makeScopedKey(panelId, worktreeId);
    set((s) => {
      const { [key]: _, ...rest } = s.panelStates;
      return { panelStates: rest };
    });
  },

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
