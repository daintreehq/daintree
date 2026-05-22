import { create } from "zustand";
import { createActionPrefsSlice, type ActionPrefsSlice } from "./slices/actionPrefsSlice";

export const useActionPrefsStore = create<ActionPrefsSlice>()((...a) => ({
  ...createActionPrefsSlice(...a),
}));

let lastPinned: string | null = null;
let lastHidden: string | null = null;
let inflightPinned: string | null = null;
let inflightHidden: string | null = null;

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

  if (pinnedChanged) {
    inflightPinned = pinnedJson;
    updates.actionPinnedIds = [...state.pinnedActionIds];
  }
  if (hiddenChanged) {
    inflightHidden = hiddenJson;
    updates.actionHiddenIds = [...state.hiddenActionIds];
  }

  void import("@/clients/appClient")
    .then(({ appClient }) => appClient.setState(updates))
    .then(() => {
      if (pinnedChanged) {
        lastPinned = inflightPinned;
        inflightPinned = null;
      }
      if (hiddenChanged) {
        lastHidden = inflightHidden;
        inflightHidden = null;
      }
    })
    .catch(() => {
      if (pinnedChanged) inflightPinned = null;
      if (hiddenChanged) inflightHidden = null;
    });
});
