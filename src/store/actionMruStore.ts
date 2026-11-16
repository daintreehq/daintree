import { create } from "zustand";
import { createActionMruSlice, type ActionMruSlice } from "./slices/actionMruSlice";
import type { ActionUsageEntry } from "@shared/types/actions";

let lastPersisted: string | null = null;
let inFlight = false;
// Latest snapshot observed while a write is in flight. Coalesced (only the most
// recent is kept) and flushed once the current write settles, so rapid usage
// updates aren't dropped — each recorded use is part of the 7-day count.
let queued: ActionUsageEntry[] | null = null;
// Hydration restores what Main just read from config.json, so the subscriber
// must not echo it back: that rewrote the file on every project view mount.
let hydrating = false;

function toUsageList(state: ActionMruSlice): ActionUsageEntry[] {
  return Array.from(state.actionUsageEntries.entries()).map(([id, { uses }]) => ({ id, uses }));
}

export const useActionMruStore = create<ActionMruSlice>()((set, get, store) => {
  const slice = createActionMruSlice(set, get, store);
  return {
    ...slice,
    hydrateActionMru: (list) => {
      hydrating = true;
      try {
        slice.hydrateActionMru(list);
      } finally {
        hydrating = false;
      }
      // The hydrated (pruned, migrated) list is the baseline rather than the raw
      // input: uses age out of the window daily, and writing that pruning back
      // would bring the per-mount rewrite straight back.
      lastPersisted = JSON.stringify(toUsageList(get()));
    },
  };
});

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
  if (hydrating) return;
  const list = toUsageList(state);

  if (JSON.stringify(list) === lastPersisted) return;

  if (inFlight) {
    queued = list;
    return;
  }

  flush(list);
});
