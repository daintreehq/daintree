import type { StateCreator } from "zustand";

const MAX_PINNED = 100;
const MAX_HIDDEN = 200;

function dedupe(input: readonly string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of input) {
    if (typeof id === "string" && id.length > 0 && !seen.has(id)) {
      seen.add(id);
      out.push(id);
      if (out.length >= cap) break;
    }
  }
  return out;
}

export interface ActionPrefsSlice {
  pinnedActionIds: string[];
  hiddenActionIds: string[];
  pinAction: (id: string) => void;
  unpinAction: (id: string) => void;
  hideAction: (id: string) => void;
  showAction: (id: string) => void;
  resetHiddenActions: () => void;
  hydrateActionPrefs: (prefs: {
    pinnedIds?: readonly string[];
    hiddenIds?: readonly string[];
  }) => void;
  isActionPinned: (id: string) => boolean;
  isActionHidden: (id: string) => boolean;
}

export const createActionPrefsSlice: StateCreator<ActionPrefsSlice, [], [], ActionPrefsSlice> = (
  set,
  get
) => ({
  pinnedActionIds: [],
  hiddenActionIds: [],

  pinAction: (id) => {
    set((state) => {
      if (state.pinnedActionIds.includes(id)) return state;
      if (state.pinnedActionIds.length >= MAX_PINNED) return state;
      // Pinning supersedes hiding — an action can't simultaneously be promoted
      // to Favorites and evicted from Recently used. If the user pins a
      // previously-hidden action via the search flow, restore visibility.
      const wasHidden = state.hiddenActionIds.includes(id);
      return {
        pinnedActionIds: [...state.pinnedActionIds, id],
        hiddenActionIds: wasHidden
          ? state.hiddenActionIds.filter((hid) => hid !== id)
          : state.hiddenActionIds,
      };
    });
  },

  unpinAction: (id) => {
    set((state) => {
      if (!state.pinnedActionIds.includes(id)) return state;
      return { pinnedActionIds: state.pinnedActionIds.filter((pinned) => pinned !== id) };
    });
  },

  hideAction: (id) => {
    set((state) => {
      if (state.hiddenActionIds.includes(id)) return state;
      if (state.hiddenActionIds.length >= MAX_HIDDEN) return state;
      return { hiddenActionIds: [...state.hiddenActionIds, id] };
    });
  },

  showAction: (id) => {
    set((state) => {
      if (!state.hiddenActionIds.includes(id)) return state;
      return { hiddenActionIds: state.hiddenActionIds.filter((hidden) => hidden !== id) };
    });
  },

  resetHiddenActions: () => {
    set((state) => (state.hiddenActionIds.length === 0 ? state : { hiddenActionIds: [] }));
  },

  hydrateActionPrefs: ({ pinnedIds, hiddenIds }) => {
    const pinned = pinnedIds ? dedupe(pinnedIds, MAX_PINNED) : [];
    const pinnedSet = new Set(pinned);
    // An ID can't simultaneously be pinned (Favorites) and hidden (Recently used
    // eviction). If a stale persisted state has both, pin wins and we strip
    // the duplicate from `hiddenActionIds` so unpinning later doesn't silently
    // leave the action vanished.
    const hiddenRaw = hiddenIds ? dedupe(hiddenIds, MAX_HIDDEN) : [];
    const hidden = hiddenRaw.filter((id) => !pinnedSet.has(id));
    set({ pinnedActionIds: pinned, hiddenActionIds: hidden });
  },

  isActionPinned: (id) => get().pinnedActionIds.includes(id),
  isActionHidden: (id) => get().hiddenActionIds.includes(id),
});
