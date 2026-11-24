import { create } from "zustand";
import { createActionPrefsSlice, type ActionPrefsSlice } from "./slices/actionPrefsSlice";

// The persistence baseline starts at the initial store value (`[]`).
const EMPTY_JSON = JSON.stringify([]);
let lastPinned: string = EMPTY_JSON;
let lastHidden: string = EMPTY_JSON;
let inflightPinned: string | null = null;
let inflightHidden: string | null = null;
// Hydration restores what Main just read from config.json. Zustand notifies
// subscribers synchronously inside the slice's `set`, before the baseline below
// can be primed, so the subscriber is told to ignore that one notification.
let hydrating = false;

export const useActionPrefsStore = create<ActionPrefsSlice>()((set, get, store) => {
  const slice = createActionPrefsSlice(set, get, store);
  const baseHydrate = slice.hydrateActionPrefs;
  return {
    ...slice,
    hydrateActionPrefs: (prefs) => {
      hydrating = true;
      try {
        baseHydrate(prefs);
      } finally {
        hydrating = false;
      }
      const next = get();
      // With no write outstanding, disk holds what was just read. A pin or hide
      // made before hydration landed may still be writing; comparing against it
      // sends the restored list so that write doesn't leave disk behind.
      if (inflightPinned === null) lastPinned = JSON.stringify(next.pinnedActionIds);
      if (inflightHidden === null) lastHidden = JSON.stringify(next.hiddenActionIds);
      persist(next);
    },
  };
});

useActionPrefsStore.subscribe((state) => {
  if (hydrating) return;
  persist(state);
});

function persist(state: ActionPrefsSlice): void {
  const pinnedJson = JSON.stringify(state.pinnedActionIds);
  const hiddenJson = JSON.stringify(state.hiddenActionIds);

  // Compared against what disk will hold once the pending write lands, not the
  // last settled value: an Undo that puts back the pre-write value while that
  // write is still in flight differs from where disk is heading, and must send.
  const pinnedChanged = pinnedJson !== (inflightPinned ?? lastPinned);
  const hiddenChanged = hiddenJson !== (inflightHidden ?? lastHidden);

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
}
