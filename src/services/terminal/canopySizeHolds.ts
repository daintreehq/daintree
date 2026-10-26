import { onHostResync } from "@/store/hostResyncSignal";
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
let offResync: (() => void) | null = null;
// A pull from an earlier read must not land after cleanup or a newer read,
// and a push since the read began outranks it.
let readGeneration = 0;
let pushLandedGeneration = -1;

export function isCanopySizeHeld(terminalId: string): boolean {
  return held.has(terminalId);
}

function apply(terminalIds: readonly string[]): void {
  held = new Set(terminalIds);
  for (const listener of [...listeners]) listener();
}

function hydrate(): void {
  const read = window.electron.canopy?.getSizeHolds;
  if (!read) return;
  const generation = ++readGeneration;
  read()
    .then((terminalIds) => {
      if (generation !== readGeneration || pushLandedGeneration === generation) return;
      apply(terminalIds);
    })
    .catch((error: unknown) => {
      logWarn("[canopySizeHolds] Couldn't read which terminals Canopy holds", { error });
    });
}

/**
 * Subscribe, then hydrate: a hold taken before this view existed, or changed
 * while its link to the host was down, is otherwise not heard of until the
 * next one changes.
 */
function start(): void {
  if (offPush !== null || typeof window === "undefined" || !window.electron?.events) return;
  offPush = window.electron.events.on("terminal:canopy-size-holds-changed", (terminalIds) => {
    pushLandedGeneration = readGeneration;
    apply(terminalIds);
  });
  offResync = onHostResync(hydrate);
  hydrate();
}

function stop(): void {
  readGeneration += 1;
  offPush?.();
  offPush = null;
  offResync?.();
  offResync = null;
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
