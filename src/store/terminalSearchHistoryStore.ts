import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { StorageValue } from "zustand/middleware";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import {
  pickFieldByWriterDelta,
  type PersistWriteMergeContext,
} from "./persistence/persistWriteMerge";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";

const MAX_HISTORY_SIZE = 50;

interface TerminalSearchHistoryState {
  searches: string[];
  caseSensitive: boolean;
  regexEnabled: boolean;
  addSearch: (term: string) => void;
  setToggles: (caseSensitive: boolean, regexEnabled: boolean) => void;
}

type TerminalSearchPersistedState = Pick<
  TerminalSearchHistoryState,
  "searches" | "caseSensitive" | "regexEnabled"
>;

const TERMINAL_SEARCH_PERSISTED_DEFAULTS: TerminalSearchPersistedState = {
  searches: [],
  caseSensitive: false,
  regexEnabled: false,
};

/**
 * Coerce a persisted (or in-memory) snapshot into the exact persisted subset,
 * mapping a null/malformed blob to defaults. Mirrors the defensive coercions in
 * `migrate` so the write merge compares canonical values (issue #11351).
 */
function toTerminalSearchPersisted(
  state: Partial<TerminalSearchPersistedState> | null | undefined
): TerminalSearchPersistedState {
  const raw = state ?? {};
  return {
    searches: Array.isArray(raw.searches)
      ? raw.searches.filter((entry): entry is string => typeof entry === "string")
      : [],
    caseSensitive: typeof raw.caseSensitive === "boolean" ? raw.caseSensitive : false,
    regexEnabled: typeof raw.regexEnabled === "boolean" ? raw.regexEnabled : false,
  };
}

function sameStringList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

/**
 * Baseline-aware three-way merge for terminal-search writes across project views
 * (issue #11351). The two toggles defer to a sibling's on-disk value unless this
 * writer changed them. `searches` is one shared MRU list mutated a single entry
 * at a time (`addSearch` unshifts one trimmed term), so a stale whole-snapshot
 * write would rewind a sibling's concurrent search. We replay this writer's one
 * touched term (`incoming[0]`) onto the freshest on-disk list instead: a
 * toggle-only write (searches unchanged vs. baseline) keeps the disk list
 * wholesale; an `addSearch` moves its term to the front of the disk list,
 * deduped and capped, preserving the sibling's other entries.
 */
function mergeTerminalSearchPersistedWrite({
  baseline,
  onDisk,
  incoming,
}: PersistWriteMergeContext<TerminalSearchPersistedState>): StorageValue<TerminalSearchPersistedState> {
  // No shared value on disk yet → nothing to reconcile against.
  if (!onDisk) return incoming;
  const base = baseline
    ? toTerminalSearchPersisted(baseline.state)
    : TERMINAL_SEARCH_PERSISTED_DEFAULTS;
  const disk = toTerminalSearchPersisted(onDisk.state);
  const inc = toTerminalSearchPersisted(incoming.state);

  let searches: string[];
  if (sameStringList(base.searches, inc.searches)) {
    // This write left the MRU untouched (e.g. a toggle change) → keep whatever a
    // sibling last wrote.
    searches = disk.searches;
  } else {
    const touched = inc.searches[0];
    if (touched === undefined) {
      // Defensive: the writer emptied its list (no clear API today) — honor it.
      searches = [];
    } else {
      searches = [touched, ...disk.searches.filter((term) => term !== touched)].slice(
        0,
        MAX_HISTORY_SIZE
      );
    }
  }

  return {
    version: incoming.version,
    state: {
      searches,
      caseSensitive: pickFieldByWriterDelta(
        base.caseSensitive,
        inc.caseSensitive,
        disk.caseSensitive
      ),
      regexEnabled: pickFieldByWriterDelta(base.regexEnabled, inc.regexEnabled, disk.regexEnabled),
    },
  };
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
      storage: createSafeJSONStorage<TerminalSearchPersistedState>({
        mergeOnWrite: mergeTerminalSearchPersistedWrite,
      }),
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
