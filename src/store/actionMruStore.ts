import { create } from "zustand";
import { createActionMruSlice, type ActionMruSlice } from "./slices/actionMruSlice";
import type { ActionUsageEntry } from "@shared/types/actions";

export const useActionMruStore = create<ActionMruSlice>()((...a) => ({
  ...createActionMruSlice(...a),
}));

let lastPersisted: string | null = null;
let inFlight = false;
// Latest snapshot observed while a write is in flight. Coalesced (only the most
// recent is kept) and flushed once the current write settles, so rapid usage
// updates aren't dropped — each recorded use is part of the 7-day count.
let queued: ActionUsageEntry[] | null = null;

function flush(list: ActionUsageEntry[]): void {
  inFlight = true;
  void import("@/clients/appClient")
    .then(({ appClient }) => appClient.setState({ actionMruList: list }))
    .then(() => {
      lastPersisted = JSON.stringify(list);
    })
    .catch(() => {})
    .finally(() => {
      inFlight = false;
      if (queued !== null) {
        const next = queued;
        queued = null;
        flush(next);
      }
    });
}

useActionMruStore.subscribe((state) => {
  const list: ActionUsageEntry[] = Array.from(state.actionUsageEntries.entries()).map(
    ([id, { uses }]) => ({ id, uses })
  );

  if (JSON.stringify(list) === lastPersisted) return;

  if (inFlight) {
    queued = list;
    return;
  }

  flush(list);
});
