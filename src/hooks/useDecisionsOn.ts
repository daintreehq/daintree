import { useSyncExternalStore } from "react";
import { decisionsClient } from "@/clients/decisionsClient";

/** Decisions' switch as main last reported it; `unknown` until it has. */
export type DecisionsSwitch = "on" | "off" | "unknown";

/**
 * Whether Decisions is switched on, as main last reported it, shared by every
 * pane in the view: one status watch however many headers ask, held while any
 * of them is mounted. Unknown until main says, so nothing that reads this
 * starts watching panes on a guess, and nothing closes on one either.
 */
let current: DecisionsSwitch = "unknown";
let holders = 0;
let stopWatch: (() => void) | null = null;
const listeners = new Set<() => void>();

function set(next: DecisionsSwitch): void {
  if (next === current) return;
  current = next;
  for (const notify of [...listeners]) notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  holders += 1;
  if (holders === 1) {
    // Pane chrome must never come down with a bridge that is missing or
    // throws: then Decisions reads as off, which shows and watches nothing.
    try {
      stopWatch = decisionsClient.watchStatus((status) =>
        set(status.state !== "off" ? "on" : "off")
      );
    } catch {
      stopWatch = null;
      current = "off";
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
    current = "unknown";
  };
}

function getSnapshot(): DecisionsSwitch {
  return current;
}

function subscribeNothing(): () => void {
  return () => {};
}

function getUnknown(): DecisionsSwitch {
  return "unknown";
}

/**
 * The switch as the view's watch last heard it, for code outside React (an
 * action's gate). Unknown while nothing in the view holds the watch.
 */
export function readDecisionsSwitch(): DecisionsSwitch {
  return current;
}

/**
 * Decisions' switch, telling a confirmed off from not yet known. Inactive,
 * nothing is watched and it reads unknown.
 */
export function useDecisionsSwitch(active = true): DecisionsSwitch {
  return useSyncExternalStore(
    active ? subscribe : subscribeNothing,
    active ? getSnapshot : getUnknown,
    active ? getSnapshot : getUnknown
  );
}

/** Whether main has said Decisions is on. */
export function useDecisionsOn(): boolean {
  return useDecisionsSwitch() === "on";
}
