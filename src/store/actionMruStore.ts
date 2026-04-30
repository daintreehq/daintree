import { create } from "zustand";
import { createActionMruSlice, type ActionMruSlice } from "./slices/actionMruSlice";
import type { ActionFrecencyEntry } from "@shared/types/actions";

export const useActionMruStore = create<ActionMruSlice>()((...a) => ({
  ...createActionMruSlice(...a),
}));

let lastPersisted: ActionFrecencyEntry[] | null = null;
let pendingPersist: ActionFrecencyEntry[] | null = null;

useActionMruStore.subscribe((state) => {
  const list: ActionFrecencyEntry[] = Array.from(state.actionFrecencyEntries.entries()).map(
    ([id, { score, lastAccessedAt }]) => ({ id, score, lastAccessedAt })
  );

  if (JSON.stringify(list) === JSON.stringify(lastPersisted)) return;

  if (pendingPersist !== null) return;

  pendingPersist = list;

  void import("@/clients/appClient")
    .then(({ appClient }) => appClient.setState({ actionMruList: list }))
    .then(() => {
      lastPersisted = pendingPersist!;
      pendingPersist = null;
    })
    .catch(() => {
      pendingPersist = null;
    });
});
