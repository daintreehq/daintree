import { create } from "zustand";
import { createActionPrefsSlice, type ActionPrefsSlice } from "./slices/actionPrefsSlice";

// Seed the persistence baseline with the initial store value (`[]`) so the
// subscribe-to-persist path on app boot — where `hydrateActionPrefs` writes
// the on-disk values back into the store — doesn't echo an identical payload
// out to disk as a spurious round-trip.
const EMPTY_JSON = JSON.stringify([]);
let lastPinned: string = EMPTY_JSON;
let lastHidden: string = EMPTY_JSON;
let inflightPinned: string | null = null;
let inflightHidden: string | null = null;

export const useActionPrefsStore = create<ActionPrefsSlice>()((set, get, store) => {
  const slice = createActionPrefsSlice(set, get, store);
  const baseHydrate = slice.hydrateActionPrefs;
  return {
    ...slice,
    hydrateActionPrefs: (prefs) => {
      baseHydrate(prefs);
      // After hydrate, prime the persistence baseline to the just-loaded values
      // so the subscribe-to-persist handler doesn't fire a redundant
      // `appClient.setState` with the same data we just read.
      const next = get();
      lastPinned = JSON.stringify(next.pinnedActionIds);
      lastHidden = JSON.stringify(next.hiddenActionIds);
    },
  };
});

useActionPrefsStore.subscribe((state) => {
  const pinnedJson = JSON.stringify(state.pinnedActionIds);
  const hiddenJson = JSON.stringify(state.hiddenActionIds);

  const pinnedChanged = pinnedJson !== lastPinned && pinnedJson !== inflightPinned;
  const hiddenChanged = hiddenJson !== lastHidden && hiddenJson !== inflightHidden;

  if (!pinnedChanged && !hiddenChanged) return;

  const updates: {
    actionPinnedIds?: string[];
    actionHiddenIds?: string[];
  } = {};

  // Capture per-send copies so the `.then` handler can update `lastPinned`
  // to the value we actually sent — reading the module-level `inflightPinned`
  // at resolve time would clobber the bookkeeping if a newer mutation has
  // already overwritten it (rapid pin→unpin sequence).
  let sentPinnedJson: string | null = null;
  let sentHiddenJson: string | null = null;

  if (pinnedChanged) {
    inflightPinned = pinnedJson;
    sentPinnedJson = pinnedJson;
    updates.actionPinnedIds = [...state.pinnedActionIds];
  }
  if (hiddenChanged) {
    inflightHidden = hiddenJson;
    sentHiddenJson = hiddenJson;
    updates.actionHiddenIds = [...state.hiddenActionIds];
  }

  void import("@/clients/appClient")
    .then(({ appClient }) => appClient.setState(updates))
    .then(() => {
      if (sentPinnedJson !== null) {
        lastPinned = sentPinnedJson;
        if (inflightPinned === sentPinnedJson) inflightPinned = null;
      }
      if (sentHiddenJson !== null) {
        lastHidden = sentHiddenJson;
        if (inflightHidden === sentHiddenJson) inflightHidden = null;
      }
    })
    .catch(() => {
      if (sentPinnedJson !== null && inflightPinned === sentPinnedJson) inflightPinned = null;
      if (sentHiddenJson !== null && inflightHidden === sentHiddenJson) inflightHidden = null;
    });
});
