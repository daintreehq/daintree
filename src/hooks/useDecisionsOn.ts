import { useSyncExternalStore } from "react";
import { decisionsClient } from "@/clients/decisionsClient";

/**
 * Whether Decisions is switched on, as main last reported it, shared by every
 * pane in the view: one status watch however many headers ask, held while any
 * of them is mounted. Off until main says otherwise, so nothing that reads
 * this starts watching panes on a guess.
 */
let on = false;
let holders = 0;
let stopWatch: (() => void) | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  holders += 1;
  if (holders === 1) {
    // Pane chrome must never come down with a bridge that is missing or
    // throws: then Decisions reads as off, which shows and watches nothing.
    try {
      stopWatch = decisionsClient.watchStatus((status) => {
        const next = status.state !== "off";
        if (next === on) return;
        on = next;
        for (const notify of [...listeners]) notify();
      });
    } catch {
      stopWatch = null;
    }
  }
  return () => {
    listeners.delete(listener);
    holders -= 1;
    if (holders > 0) return;
    stopWatch?.();
    stopWatch = null;
    // The next watcher reads afresh; a stale "on" must not let a pane
    // subscribe before main has answered.
    on = false;
  };
}

function getSnapshot(): boolean {
  return on;
}

export function useDecisionsOn(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
