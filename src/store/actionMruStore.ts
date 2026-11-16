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

function hasUsesArray(raw: unknown): boolean {
  return typeof raw === "object" && raw !== null && Array.isArray((raw as { uses?: unknown }).uses);
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
      const hydrated = toUsageList(get());
      // A current-shape list hydrates to itself minus aged-out uses; writing
      // that pruning back would bring the per-mount rewrite straight back. It is
      // still written when a use recorded before hydration landed is mid-write
      // (that write would leave disk behind), or when it held legacy entries,
      // whose synthetic timestamps are rebuilt every load and never decay.
      if (!inFlight && list.every(hasUsesArray)) {
        lastPersisted = JSON.stringify(hydrated);
      } else {
        persist(hydrated);
      }
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
        persist(next);
      }
    });
}

function persist(list: ActionUsageEntry[]): void {
  // Queued before comparing: the settled value isn't where disk is heading, so
  // a list matching it must still replace an older queued snapshot.
  if (inFlight) {
    queued = list;
    return;
  }

  if (JSON.stringify(list) === lastPersisted) return;

  flush(list);
}

useActionMruStore.subscribe((state) => {
  if (hydrating) return;
  persist(toUsageList(state));
});
