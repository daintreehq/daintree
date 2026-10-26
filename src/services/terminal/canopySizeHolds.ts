import { logWarn } from "@/utils/logger";

/**
 * The terminals a Canopy panel on another machine holds at its own size
 * (#14497). Main is the only authority: this mirrors its list. Their panes
 * follow the PTY's grid instead of fitting, as a Canopy panel in the pane's
 * own view freezes it.
 */
let held: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
let offPush: (() => void) | null = null;
// A pull from an earlier setup must not land after cleanup, and a push for
// this setup outranks the pull.
let setupGeneration = 0;
let pushLandedGeneration = -1;

export function isCanopySizeHeld(terminalId: string): boolean {
  return held.has(terminalId);
}

function apply(terminalIds: readonly string[]): void {
  held = new Set(terminalIds);
  for (const listener of [...listeners]) listener();
}

/**
 * Subscribe, then hydrate: a hold taken before this view existed is otherwise
 * not heard of until the next one changes.
 */
function start(): void {
  if (offPush !== null || typeof window === "undefined" || !window.electron?.events) return;
  const generation = ++setupGeneration;
  offPush = window.electron.events.on("terminal:canopy-size-holds-changed", (terminalIds) => {
    pushLandedGeneration = generation;
    apply(terminalIds);
  });
  const read = window.electron.canopy?.getSizeHolds;
  if (!read) return;
  read()
    .then((terminalIds) => {
      if (generation !== setupGeneration || pushLandedGeneration === generation) return;
      apply(terminalIds);
    })
    .catch((error: unknown) => {
      logWarn("[canopySizeHolds] Couldn't read which terminals Canopy holds", { error });
    });
}

function stop(): void {
  setupGeneration += 1;
  offPush?.();
  offPush = null;
  held = new Set();
}

export function subscribeCanopySizeHolds(listener: () => void): () => void {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}
