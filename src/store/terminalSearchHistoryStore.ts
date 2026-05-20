import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";

const MAX_HISTORY_SIZE = 50;

interface TerminalSearchHistoryState {
  searches: string[];
  caseSensitive: boolean;
  regexEnabled: boolean;
  addSearch: (term: string) => void;
  setToggles: (caseSensitive: boolean, regexEnabled: boolean) => void;
}

export const useTerminalSearchHistoryStore = create<TerminalSearchHistoryState>()(
  persist(
    (set) => ({
      searches: [],
      caseSensitive: false,
      regexEnabled: false,

      addSearch: (term) =>
        set((state) => {
          const trimmed = term.trim();
          if (trimmed === "") return state;
          const filtered = state.searches.filter((s) => s !== trimmed);
          const updated = [trimmed, ...filtered].slice(0, MAX_HISTORY_SIZE);
          return { searches: updated };
        }),

      setToggles: (caseSensitive, regexEnabled) => set({ caseSensitive, regexEnabled }),
    }),
    {
      name: "daintree-terminal-search-history",
      storage: createSafeJSONStorage(),
      version: 0,
      migrate: (persistedState, _version) => {
        const state = (persistedState ?? {}) as Partial<TerminalSearchHistoryState>;
        return {
          searches: Array.isArray(state.searches) ? state.searches : [],
          caseSensitive: typeof state.caseSensitive === "boolean" ? state.caseSensitive : false,
          regexEnabled: typeof state.regexEnabled === "boolean" ? state.regexEnabled : false,
        };
      },
      partialize: (state) => ({
        searches: state.searches,
        caseSensitive: state.caseSensitive,
        regexEnabled: state.regexEnabled,
      }),
    }
  )
);

registerPersistedStore({
  storeId: "terminalSearchHistoryStore",
  store: useTerminalSearchHistoryStore,
  persistedStateType: "{ searches: string[]; caseSensitive: boolean; regexEnabled: boolean }",
});
